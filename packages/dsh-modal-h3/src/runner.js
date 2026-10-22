/**
 * Spawn the Python runner inside the pinned `pixi exec` environment.
 *
 * **Why a child process at all.** The Modal client is a heavy Python dependency
 * with its own gRPC channels and its own token discovery; loading it into the
 * harness process would put a second network stack, a second event loop and a
 * second credential source inside a long-lived Node process, and would make the
 * harness's own lifetime depend on Modal's. A short-lived child keeps every
 * Modal interaction bounded, and gives cancellation a handle the harness can
 * actually kill.
 *
 * **Why `pixi exec` and not a bundled interpreter.** The runner needs three
 * things that are not in the Node runtime: an interpreter, Pillow (reference
 * image decoding), and `ffprobe`/`ffmpeg` (reference probing and delivery
 * verification). `pixi exec` pins all four by version in one place and caches
 * the environment after the first use, which is the same mechanism the previous
 * generation of this pipeline used — so a machine that already ran it pays
 * nothing extra.
 *
 * **Credentials are environment variables, never a file.** The account's
 * `token_id` / `token_secret` are injected into the child's environment on each
 * call. `~/.modal.toml` is never written and never read for this: the Modal
 * client's precedence is env → profile file → default, so the env vars also
 * override whatever the developer has configured locally. A pooled account is
 * therefore always used exactly as the pool declares it.
 *
 * @module @logictan/dsh-modal-h3/runner
 */
import { spawn } from 'node:child_process';

/** Package names pinned for the runner environment; the same set the CLI used. */
export const PIXI_SPECS = ['python=3.11', 'pillow=12.3.0', 'ffmpeg=8.1.1', 'modal-client==1.5.5'];

/** Runner script, relative to the package root. */
export const RUNNER_SCRIPT = 'app/plugin_runner.py';

/**
 * Build the `pixi exec` argument vector for one runner invocation.
 *
 * Kept as a pure function because the argv is the whole contract between the
 * Node half and the Python half: `-s` must be repeated once per package (a
 * single space-joined `--spec` is parsed as one matchspec and fails to solve),
 * and the script path must come after every `-s`.
 *
 * @param appDir - absolute package root containing `app/`.
 * @param args - runner subcommand and its flags.
 * @returns the argv to spawn.
 */
export function runnerArgv(appDir, args) {
  return [
    'exec',
    ...PIXI_SPECS.flatMap((spec) => ['-s', spec]),
    'python',
    `${appDir}/${RUNNER_SCRIPT}`,
    ...args,
  ];
}

/**
 * Environment overlay for one runner invocation.
 *
 * `PYTHONPATH` names the `app/` directory explicitly rather than relying on the
 * script's own directory being on `sys.path`: `modal deploy` and the runner both
 * import `modal_h3_contract`, and one of them may run from another working
 * directory. `PYTHONDONTWRITEBYTECODE` keeps `__pycache__` out of a package
 * directory that is read-only inside a profile's `node_modules`.
 *
 * The two token variables are the ONLY credential channel: the Modal client's
 * precedence is env → `~/.modal.toml` → default profile, so setting them is
 * sufficient and also overrides whatever the machine has configured.
 *
 * @param appDir - absolute package root containing `app/`.
 * @param account - the pooled account, or `undefined` for local-only commands.
 * @returns variables to add to the child environment.
 */
export function runnerEnv(appDir, account) {
  return {
    PYTHONPATH: `${appDir}/app`,
    PYTHONDONTWRITEBYTECODE: '1',
    ...(account === undefined ? {} : { MODAL_TOKEN_ID: account.tokenId, MODAL_TOKEN_SECRET: account.tokenSecret }),
  };
}

/**
 * Run one runner subcommand and parse its single JSON result line.
 *
 * @param options.appDir - absolute package root containing `app/`.
 * @param options.args - runner subcommand and flags.
 * @param options.account - pooled account for commands that need Modal, omitted for local-only ones.
 * @param options.signal - caller cancellation; the child is killed when it aborts.
 * @param options.timeoutMs - hard wall-clock limit for the child.
 * @returns the parsed JSON result.
 * @throws when `pixi` is missing, the child exits non-zero, or its output is not JSON.
 */
export function runRunner({ appDir, args, account, signal, timeoutMs }) {
  const argv = runnerArgv(appDir, args);
  return new Promise((resolve, reject) => {
    const child = spawn('pixi', argv, {
      cwd: appDir,
      env: { ...process.env, ...runnerEnv(appDir, account) },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let stdout = '';
    let stderr = '';
    let timer;
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`modal-h3 runner exceeded its ${Math.round(timeoutMs / 1000)}s budget`));
      }, timeoutMs);
      timer.unref?.();
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        fail(new Error('pixi is not on PATH; install pixi (https://pixi.sh) or add it to PATH'));
        return;
      }
      fail(error);
    });
    child.on('close', (code, signalName) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-6).join(' | ');
        reject(new Error(`modal-h3 runner failed (exit ${code ?? signalName}): ${detail}`));
        return;
      }
      const line = stdout.trim().split('\n').filter((item) => item.trim() !== '').at(-1);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`modal-h3 runner produced no JSON result: ${(stdout.trim() || stderr.trim()).slice(-500)}`));
      }
    });
  });
}
