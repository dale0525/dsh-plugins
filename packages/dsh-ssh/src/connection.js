/**
 * The SSH transport: one connection per operation, password only.
 *
 * Three constraints shaped this module, each from a failure this plugin exists
 * to avoid:
 *
 *  - **No external binary, no temporary files.** The predecessor was a skill
 *    that spawned `ssh` with `SSH_ASKPASS` and a helper script to feed the
 *    password, which needs OpenSSH, python and a POSIX shell — none of which a
 *    Windows host has. `ssh2` is pure JavaScript, so this path is identical on
 *    macOS, Linux and Windows.
 *
 *  - **The password never leaves this module.** It arrives as an argument, goes
 *    into the connect options, and is never logged, never written to disk and
 *    never placed in the process environment or on a command line where another
 *    process could read it.
 *
 *  - **The host key is verified before the password is offered.** ssh2 accepts
 *    any key unless told otherwise; see `known-hosts.js` for why that is not
 *    acceptable when the secret is a password.
 *
 * A connection per operation rather than a pool: a pooled connection that died
 * while idle fails the next call with a channel error the caller cannot act on,
 * and the reconnect logic needed to hide that is more code than the connect it
 * saves. Operations here are interactive commands and file transfers, not a
 * high-frequency channel.
 *
 * @module @logictan/dsh-ssh/connection
 */
import ssh2 from 'ssh2';

import { judgeHostKey } from './known-hosts.js';

/** How long a TCP connect plus key exchange plus authentication may take. */
export const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Default and maximum budget for one remote command.
 *
 * A command with no ceiling holds the tool call open until the host gives up,
 * which for a stuck `mount` or an interactive prompt is forever. The ceiling is
 * generous enough for a build and short enough that a stuck command surfaces as
 * an error the model can retry with a different approach.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 900_000;

/**
 * Per-stream character ceiling.
 *
 * Truncation happens here rather than at the tool boundary because the tail is
 * what a caller needs after a failure (`tail -50` of a build log), while the
 * head is what proves the command started. Both ends are kept.
 */
export const MAX_STREAM_CHARS = 20_000;

/** Marker inserted where a stream was cut. */
const TRUNCATION_MARKER = '\n…[truncated]…\n';

/**
 * Keep the head and the tail of an over-long stream.
 *
 * @param text - the captured output.
 * @returns the text, possibly with its middle replaced by a marker.
 */
export function truncateStream(text) {
  if (text.length <= MAX_STREAM_CHARS) return text;
  const half = Math.floor((MAX_STREAM_CHARS - TRUNCATION_MARKER.length) / 2);
  return text.slice(0, half) + TRUNCATION_MARKER + text.slice(text.length - half);
}

/**
 * Turn an ssh2 connect failure into something a model can act on.
 *
 * ssh2's own messages are accurate but terse, and the two that matter most —
 * a rejected password and a changed host key — are the two a caller most often
 * misreads as "the network is down".
 *
 * @param error - the error ssh2 emitted.
 * @param host - the configured host, for the message.
 * @returns an error carrying an actionable message.
 */
export function describeConnectError(error, host) {
  const message = String((error && error.message) || error);
  if (error && error.level === 'client-authentication') {
    return new Error(
      `认证失败：${host.alias} (${host.username}@${host.host}:${host.port}) 拒绝了密码。` +
        '请在「设置 → 插件 → dsh-ssh」里重新填写该主机的密码。',
    );
  }
  if (/Host denied \(verification failed\)/.test(message)) {
    return new Error(
      `主机密钥校验失败：${host.alias} (${host.host}:${host.port}) 出示的密钥与上次记录不一致。` +
        '可能主机被重装，也可能有人在中间。确认无误后删除 $DSH_HOME/dsh-ssh/known-hosts.json 里该地址的条目再重试。',
    );
  }
  if (error && error.code === 'ETIMEDOUT') {
    return new Error(`连接超时：${host.alias} (${host.host}:${host.port}) 在 ${CONNECT_TIMEOUT_MS / 1000} 秒内没有完成握手。`);
  }
  if (error && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENOTFOUND')) {
    return new Error(`连不上 ${host.alias} (${host.host}:${host.port})：${message}`);
  }
  return new Error(`连接 ${host.alias} (${host.host}:${host.port}) 失败：${message}`);
}

/**
 * Open an authenticated connection to one configured host.
 *
 * The returned client is ready for `exec`/`sftp` and is the caller's to close.
 * On a first-use host key the recording callback is invoked before the password
 * is sent, so a caller can persist trust at the moment it is granted.
 *
 * @param options.host - normalized host row.
 * @param options.password - the resolved password.
 * @param options.knownHosts - `{entries}` from `readKnownHosts`.
 * @param options.recordHostKey - called with `{address, fingerprint}` on first use.
 * @param options.signal - caller cancellation.
 * @returns the connected client and the fingerprint that was accepted.
 */
export async function connect({ host, password, knownHosts, recordHostKey, signal }) {
  const client = new ssh2.Client();
  let accepted;
  let rejected;

  const onAbort = () => {
    client.end();
    rejected?.(new Error(`连接 ${host.alias} 已取消`));
  };
  if (signal !== undefined) {
    if (signal.aborted) throw new Error(`连接 ${host.alias} 已取消`);
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const settled = new Promise((resolve, reject) => {
    accepted = resolve;
    rejected = reject;
  });

  client.once('ready', () => {
    accepted({ client, fingerprint: acceptedFingerprint });
  });
  // `on`, NOT `once`, and it must stay attached for the client's whole life.
  //
  // ssh2 emits more than one error for a single failed connection: after a
  // socket-level failure (`read ECONNRESET`) it also emits a fatal
  // `Connection lost before handshake` from its own teardown path. With
  // `once`, the listener is gone by then and Node turns the second error into an
  // uncaught exception, which the host reports as `fatal uncaught exception` and
  // dies from. A connection to an unreachable host could therefore take down the
  // whole process — the worst possible outcome for a tool whose job is to reach
  // machines that may be offline.
  //
  // A permanent listener that only settles the first time keeps every later
  // error contained. Nothing is lost: the promise is already rejected, and the
  // caller has moved on.
  client.on('error', (error) => {
    rejected(describeConnectError(error, host));
  });

  let acceptedFingerprint = '';
  let recorded = false;

  client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
    // The same secret, offered as the challenge-response form some servers use
    // for passwords. `finish` with one answer per prompt: an empty answer array
    // would be rejected by a server that asks for the password again.
    finish(prompts.map(() => password));
  });

  client.connect({
    host: host.host,
    port: host.port,
    username: host.username,
    password,
    readyTimeout: CONNECT_TIMEOUT_MS,
    // Password first, then the challenge-response form that many servers use for
    // the same secret. Both are the same value: this plugin supports password
    // authentication only, and a server that offers only keyboard-interactive
    // for passwords would otherwise be unreachable.
    tryKeyboard: true,
    // An ARRAY handler, not a callback: ssh2 calls a callback handler before it
    // has heard which methods the server accepts, so `methodsLeft` is `null` on
    // that first call and any decision made from it refuses the connection
    // before a password is ever sent. The array form asks for each method in
    // turn and lets the server reject them.
    authHandler: ['password', 'keyboard-interactive'],
    hostVerifier: (key, verify) => {
      const verdict = judgeHostKey({ entries: knownHosts.entries, host: host.host, port: host.port, key });
      acceptedFingerprint = verdict.fingerprint;
      if (verdict.ok && verdict.firstUse && !recorded) {
        recorded = true;
        recordHostKey?.({ address: verdict.address, fingerprint: verdict.fingerprint });
      }
      verify(verdict.ok);
    },
  });

  try {
    return await settled;
  } catch (error) {
    client.end();
    throw error;
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Run one command and collect its output.
 *
 * @param options.client - a ready client.
 * @param options.command - the shell command, run by the server's login shell.
 * @param options.timeoutMs - budget for the command itself.
 * @param options.signal - caller cancellation.
 * @returns `{stdout, stderr, code, signal, timedOut}`.
 */
export async function runCommand({ client, command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, signal }) {
  return new Promise((resolve, reject) => {
    let timer;
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    const onAbort = () => {
      client.end();
      finish(reject, new Error('命令已取消'));
    };
    if (signal !== undefined) {
      if (signal.aborted) return finish(reject, new Error('命令已取消'));
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      // The channel is closed rather than merely abandoned: the remote process
      // keeps running either way, but an open channel would hold the client.
      client.end();
      finish(reject, new Error(`命令超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已断开连接（远端进程可能仍在运行）`));
    }, timeoutMs);

    client.exec(command, (error, stream) => {
      if (error) return finish(reject, error);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk) => {
        stdout += chunk;
      });
      stream.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      stream.once('close', (code, signalName) => {
        finish(resolve, { stdout: truncateStream(stdout), stderr: truncateStream(stderr), code, signal: signalName });
      });
      stream.on('error', (streamError) => finish(reject, streamError));
    });
  });
}

/**
 * Upload one local file to the remote host.
 *
 * @param options.client - a ready client.
 * @param options.localPath - absolute local path.
 * @param options.remotePath - absolute remote path.
 * @returns the number of bytes written.
 */
export async function uploadFile({ client, localPath, remotePath }) {
  const sftp = await openSftp(client);
  await new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()));
  });
  const stats = await stat(sftp, remotePath);
  return { bytes: stats.size };
}

/**
 * Download one remote file to the local machine.
 *
 * @param options.client - a ready client.
 * @param options.remotePath - absolute remote path.
 * @param options.localPath - absolute local path.
 * @returns the number of bytes written.
 */
export async function downloadFile({ client, remotePath, localPath }) {
  const sftp = await openSftp(client);
  const before = await stat(sftp, remotePath);
  await new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()));
  });
  return { bytes: before.size };
}

/**
 * Open an SFTP channel.
 *
 * @param client - a ready client.
 * @returns the SFTP session.
 */
async function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

/**
 * Stat one remote path.
 *
 * Checked before a download so a missing file reports `ENOENT` instead of
 * creating an empty local file that the next step would happily read.
 *
 * @param sftp - the SFTP session.
 * @param path - the remote path.
 * @returns the attributes.
 */
async function stat(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, attributes) => (error ? reject(error) : resolve(attributes)));
  });
}
