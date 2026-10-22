/**
 * Orchestration: pool + task state + the Python runner.
 *
 * This module is where the three seams meet, so it is also where the decisions
 * that span them live:
 *
 *  - **A task is bound to one account at submission.** A Modal function call id
 *    only resolves inside the workspace that spawned it, so moving a task to a
 *    different account mid-flight is not possible — not merely unwise. The
 *    record therefore stores the account name, and an account removed from the
 *    pool leaves its in-flight tasks readable but unpollable, which is reported
 *    explicitly instead of crashing.
 *
 *  - **Waiting is a loop over one long-poll, not a second submission.** The
 *    runner's `wait` subcommand blocks inside Modal's own long-poll, so a
 *    generation costs a handful of requests rather than one per second.
 *
 *  - **`dry_run` never touches credentials.** It runs the same local admission
 *    the real submission would, which is the point: the model can learn the
 *    frame contract and the media map before deciding to spend money.
 *
 * @module @logictan/dsh-modal-h3/tasks
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { ACCOUNTS_REF, parseAccountPool, selectAccount } from './pool.js';
import { runRunner } from './runner.js';
import { GENERATION_TIMEOUT_MS, SYNC_TIMEOUT_MS } from './tools.js';
import {
  createTaskId,
  isFinalStatus,
  listTasks,
  loadTask,
  readJson,
  saveTask,
  stateRoot,
  taskDir,
  writeJson,
} from './state.js';

/** Probe outcomes that mean "this account can generate right now". */
const USABLE_PROBE = 'deployed';

/**
 * Statuses that mean an account is currently spending a container.
 */
const ACTIVE_STATUSES = new Set(['submitted', 'running']);

/**
 * Build the service the tool definitions call into.
 *
 * @param options.appDir - absolute package root containing `app/`.
 * @param options.dshHome - resolved harness home.
 * @param options.resolveAccounts - async () => the raw pool credential value.
 * @param options.runner - override for the Python runner, for tests.
 * @returns the service methods.
 */
export function createService(options) {
  const { appDir, dshHome, resolveAccounts, runner = runRunner } = options;

  const poolFile = () => join(stateRoot(dshHome), 'pool.json');

  /**
   * Read and validate the pool, refusing to run with a broken one.
   *
   * @returns the parsed accounts.
   * @throws when the credential is missing or malformed, with every problem listed.
   */
  const accounts = async () => {
    const text = await resolveAccounts();
    const parsed = parseAccountPool(text);
    if (parsed.errors.length > 0) {
      throw new Error(
        `the ${ACCOUNTS_REF} credential is not usable: ${parsed.errors.join('; ')}. ` +
          'Set it from Settings → Plugins → modal-h3.',
      );
    }
    return parsed.accounts;
  };

  /**
   * Cached probe results and last-use order, keyed by account name.
   *
   * @returns the persisted pool state.
   */
  const poolState = async () => {
    const stored = await readJson(poolFile());
    return {
      accounts: stored?.accounts ?? {},
      lastUsedAt: stored?.lastUsedAt ?? {},
      refusing: stored?.refusing ?? {},
    };
  };

  const savePoolState = async (state) => {
    await mkdir(stateRoot(dshHome), { recursive: true });
    await writeJson(poolFile(), state);
  };

  /**
   * Unfinished tasks per account, from the local records.
   *
   * @returns a map of account name to active task count.
   */
  const inFlight = async () => {
    const records = await listTasks(dshHome, { limit: 200 });
    const counts = new Map();
    for (const record of records) {
      if (record.account === undefined || !ACTIVE_STATUSES.has(record.status)) continue;
      counts.set(record.account, (counts.get(record.account) ?? 0) + 1);
    }
    return counts;
  };

  /**
   * Resolve reference paths against the session working directory.
   *
   * @param paths - caller-supplied paths.
   * @param cwd - the session directory, if any.
   * @returns absolute paths.
   */
  const resolvePaths = (paths, cwd) => {
    if (!Array.isArray(paths)) return [];
    return paths.map((entry) => {
      const text = String(entry);
      if (isAbsolute(text)) return text;
      if (cwd === undefined) throw new Error(`reference path ${text} is relative and the session has no working directory`);
      return resolve(cwd, text);
    });
  };

  /**
   * Build the job spec the runner reads.
   *
   * @param args - tool arguments.
   * @param cwd - the session directory.
   * @returns the job spec.
   */
  const jobSpec = (args, cwd) => ({
    prompt: args.prompt,
    duration_seconds: args.duration_seconds ?? 4.0,
    references: {
      images: resolvePaths(args.reference_images, cwd),
      videos: resolvePaths(args.reference_videos, cwd),
      audios: resolvePaths(args.reference_audios, cwd),
    },
  });

  /**
   * Run the local admission check without credentials or writes.
   *
   * @param spec - the job spec.
   * @param signal - caller cancellation.
   * @returns the runner's admission result.
   */
  const preflight = async (spec, signal) => {
    const scratch = join(stateRoot(dshHome), 'preflight');
    await mkdir(scratch, { recursive: true });
    const path = join(scratch, `${createTaskId()}.json`);
    await writeJson(path, spec);
    try {
      return await runner({ appDir, args: ['preflight', '--spec', path], signal, timeoutMs: 300_000 });
    } finally {
      // A preflight is a pure function of the spec; keeping it would accumulate
      // one file per validation with nothing to read it back.
      await rm(path, { force: true });
    }
  };

  /**
   * Copy the delivered files to a caller-chosen directory.
   *
   * @param record - the completed task record.
   * @param outDir - destination directory.
   * @returns the updated record.
   */
  const deliverTo = async (record, outDir) => {
    await mkdir(outDir, { recursive: true });
    const directory = taskDir(dshHome, record.id);
    const video = join(outDir, 'output.mp4');
    await copyFile(join(directory, 'output.mp4'), video);
    let report = record.report_path;
    if (record.report_path !== undefined) {
      report = join(outDir, 'report.json');
      await copyFile(join(directory, 'report.json'), report);
    }
    return { ...record, output_path: video, report_path: report };
  };

  /**
   * Project a runner outcome into a task record.
   *
   * @param record - the record being updated.
   * @param outcome - the runner's JSON result.
   * @returns the updated record.
   */
  const applyOutcome = (record, outcome) => {
    // `unsubmitted` means the runner found no call.json: the submission never
    // completed. It is a failure of THIS task, and it must not be handed back as
    // a status the model could poll again — there is nothing to poll.
    if (outcome.status === 'unsubmitted') {
      return {
        ...record,
        status: 'failed',
        error:
          'no Modal call was recorded for this task, so nothing was submitted. ' +
          'The submission did not complete; submit again.',
        updated_at: new Date().toISOString(),
      };
    }
    const status = typeof outcome.status === 'string' ? outcome.status : 'unknown';
    const next = { ...record, status, updated_at: new Date().toISOString() };
    if (typeof outcome.message === 'string') next.error = outcome.message;
    if (typeof outcome.output_path === 'string') {
      next.output_path = outcome.output_path;
      delete next.error;
    }
    if (typeof outcome.report_path === 'string') next.report_path = outcome.report_path;
    if (typeof outcome.elapsed_seconds === 'number') next.elapsed_seconds = outcome.elapsed_seconds;
    if (typeof outcome.estimated_gpu_cost_usd === 'number') next.estimated_gpu_cost_usd = outcome.estimated_gpu_cost_usd;
    if (outcome.ffprobe !== undefined) next.ffprobe = outcome.ffprobe;
    if (typeof outcome.function_call_id === 'string') next.function_call_id = outcome.function_call_id;
    if (status === 'completed') delete next.error;
    return next;
  };

  /**
   * Message for one task record, phrased for the model.
   *
   * @param record - the record.
   * @returns the message.
   */
  const describe = (record) => {
    switch (record.status) {
      case 'submitted':
        return 'Submitted to Modal. Poll with get_generation_task; a generation typically takes several minutes.';
      case 'running':
        return 'Still generating. Poll again later.';
      case 'completed':
        return `Generation completed. The delivered MP4 is at ${record.output_path}.`;
      case 'cancelled':
        return 'Generation cancelled. GPU time already spent is not refunded.';
      case 'expired':
        return 'The Modal function call expired before its output was collected; the result is no longer retrievable.';
      case 'failed':
        return `Generation failed${record.error === undefined ? '.' : `: ${record.error}`}`;
      default:
        return record.error === undefined
          ? 'The task state is unknown; poll it again or check accounts_status.'
          : `The task state is unknown: ${record.error}`;
    }
  };

  /**
   * Shape one record into the tool result value.
   *
   * @param record - the record.
   * @returns the tool result value.
   */
  const present = (record) => ({
    task_id: record.id,
    status: record.status,
    message: describe(record),
    ...(record.account === undefined ? {} : { account: record.account }),
    ...(record.error === undefined || record.status === 'completed' ? {} : { error: record.error }),
    ...(record.output_path === undefined ? {} : { output_path: record.output_path }),
    ...(record.report_path === undefined ? {} : { report_path: record.report_path }),
    ...(record.effective_duration_seconds === undefined
      ? {}
      : { effective_duration_seconds: record.effective_duration_seconds }),
    ...(record.output_frames === undefined ? {} : { output_frames: record.output_frames }),
    ...(record.generation_frames === undefined ? {} : { generation_frames: record.generation_frames }),
    ...(record.prompt_media_map === undefined ? {} : { prompt_media_map: record.prompt_media_map }),
    ...(record.ffprobe === undefined ? {} : { ffprobe: record.ffprobe }),
    ...(record.elapsed_seconds === undefined ? {} : { elapsed_seconds: record.elapsed_seconds }),
    ...(record.estimated_gpu_cost_usd === undefined
      ? {}
      : { estimated_gpu_cost_usd: record.estimated_gpu_cost_usd }),
  });

  /**
   * Poll one task and persist what the poll learned.
   *
   * @param record - the current record.
   * @param signal - caller cancellation.
   * @param blocking - block inside Modal's long-poll until the task settles.
   * @returns the updated record.
   */
  const pollOnce = async (record, signal, blocking) => {
    const directory = taskDir(dshHome, record.id);
    const args = blocking
      ? ['wait', '--task-dir', directory, '--timeout', '900']
      : ['poll', '--task-dir', directory];
    // The credential is re-read here rather than stored with the task: a task
    // submitted days ago must be polled with the CURRENT token for its account,
    // which is what makes rotating a token in the pool take effect immediately.
    const live = (await accounts()).find((entry) => entry.name === record.account);
    if (live === undefined) {
      const next = {
        ...record,
        status: 'unknown',
        error:
          `account ${record.account} is no longer in the ${ACCOUNTS_REF} credential, so its in-flight call cannot be polled. ` +
          'Restore the account to resume, or cancel the call from the Modal dashboard.',
        updated_at: new Date().toISOString(),
      };
      await saveTask(dshHome, next);
      return next;
    }
    let outcome;
    try {
      outcome = await runner({
        appDir,
        args,
        account: live,
        signal,
        timeoutMs: blocking ? 1_000_000 : 300_000,
      });
    } catch (error) {
      // A cancelled tool call is not a broken task: the generation is still
      // running on Modal and must keep its record, or the caller loses the only
      // handle to it. Only a real failure becomes task state.
      if (signal?.aborted === true) throw error;
      const next = { ...record, status: 'unknown', error: error.message, updated_at: new Date().toISOString() };
      await saveTask(dshHome, next);
      return next;
    }
    const next = applyOutcome(record, outcome);
    if (next.status === 'completed' && record.out_dir !== undefined) {
      const delivered = await deliverTo(next, record.out_dir);
      await saveTask(dshHome, delivered);
      return delivered;
    }
    await saveTask(dshHome, next);
    return next;
  };

  /**
   * Advance one task, waiting across several long-polls when asked to block.
   *
   * The runner's `wait` blocks inside Modal's own long-poll for up to 900 s,
   * which is longer than any single generation but shorter than the tool budget.
   * Looping is what makes `wait_for_completion: true` actually mean "until it is
   * done" instead of "until the first poll happens to return"; the deadline stops
   * it short of the tool's own timeout so the model gets an answer either way.
   *
   * @param record - the current record.
   * @param signal - caller cancellation.
   * @param blocking - wait for a final state instead of polling once.
   * @returns the updated record.
   */
  const advance = async (record, signal, blocking) => {
    if (!blocking) return pollOnce(record, signal, false);
    // Stopping short of the tool's own budget is what makes the wait return a
    // status instead of being cancelled: the postprocess and the result write
    // still have to fit after the last poll.
    const deadline = Date.now() + GENERATION_TIMEOUT_MS - 150_000;
    let current = record;
    for (;;) {
      current = await pollOnce(current, signal, true);
      // Anything that is not still spending a container ends the wait: a final
      // status, a failure, or an unknown state that a further poll cannot change.
      if (!ACTIVE_STATUSES.has(current.status)) return current;
      if (Date.now() >= deadline) return current;
    }
  };

  return {
    /**
     * `generate_video`.
     *
     * @param args - tool arguments.
     * @param exec - tool execution context.
     * @returns the tool result value.
     */
    async generate(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd;
      const spec = jobSpec(args, typeof cwd === 'string' && cwd !== '' ? cwd : undefined);
      const admitted = await preflight(spec, exec?.signal);

      if (args.dry_run === true) {
        // No task id: nothing was recorded, so an id here would name a task that
        // `get_generation_task` could never find.
        return {
          status: 'dry-run',
          message:
            'Dry run passed: the prompt and reference set are admitted. Nothing was submitted and nothing was charged.',
          effective_duration_seconds: admitted.request.duration_seconds,
          output_frames: admitted.request.output_frames,
          generation_frames: admitted.request.generation_frames,
          prompt_media_map: admitted.request.prompt_media_map,
        };
      }

      const pooled = await accounts();
      const state = await poolState();
      const chosen = selectAccount(pooled, {
        requested: args.account,
        inFlight: await inFlight(),
        lastUsedAt: new Map(Object.entries(state.lastUsedAt).map(([key, value]) => [key, Number(value)])),
        refusing: new Set(Object.keys(state.refusing)),
      });

      const id = createTaskId();
      const directory = taskDir(dshHome, id);
      await mkdir(directory, { recursive: true });
      await writeJson(join(directory, 'job.json'), spec);

      const record = {
        id,
        status: 'submitted',
        account: chosen.name,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        request_id: admitted.preflight.request_id,
        effective_duration_seconds: admitted.request.duration_seconds,
        output_frames: admitted.request.output_frames,
        generation_frames: admitted.request.generation_frames,
        prompt_media_map: admitted.request.prompt_media_map,
        ...(args.out_dir === undefined ? {} : { out_dir: String(args.out_dir) }),
      };
      // Saved before the spawn so a crash mid-submit still leaves a record whose
      // call.json (written by the runner) can be reconciled later.
      await saveTask(dshHome, record);

      let submitted;
      try {
        submitted = await runner({
          appDir,
          args: ['submit', '--task-dir', directory],
          account: chosen,
          signal: exec?.signal,
          timeoutMs: GENERATION_TIMEOUT_MS,
        });
      } catch (error) {
        // The runner writes `call.json` the instant the spawn returns, so a
        // failed submit usually means no call exists — but not always: a child
        // killed between the spawn and that write leaves a PAID call with no
        // handle. Adopting whatever the runner recorded is the only way to keep
        // it reachable; declaring failure here would orphan it silently.
        const recorded = await readJson(join(directory, 'call.json'));
        if (recorded?.function_call_id === undefined) {
          // No call exists, so this account refused the submission outright — a
          // spent billing cycle, a revoked token, a deleted App. Recording it is
          // what stops the next submit from picking the same dead account and
          // failing again; the message is kept so `accounts_status` can say why.
          state.refusing[chosen.name] = { message: error.message.slice(0, 500), at: new Date().toISOString() };
          await savePoolState(state);
          const failed = { ...record, status: 'failed', error: error.message, updated_at: new Date().toISOString() };
          await saveTask(dshHome, failed);
          return present(failed);
        }
        const recovered = {
          ...record,
          status: 'submitted',
          function_call_id: recorded.function_call_id,
          error: `submission reported ${error.message}, but a Modal call was recorded; poll it to learn its state`,
          updated_at: new Date().toISOString(),
        };
        await saveTask(dshHome, recovered);
        return present(recovered);
      }

      state.lastUsedAt[chosen.name] = Date.now();
      // A successful submit clears the refusal: the account works, whatever it
      // said last time (a spent cycle can be topped up).
      delete state.refusing[chosen.name];
      await savePoolState(state);

      const submittedRecord = {
        ...record,
        status: 'submitted',
        function_call_id: submitted.function_call_id,
        request_id: submitted.request_id,
      };
      await saveTask(dshHome, submittedRecord);

      if (args.wait_for_completion === false) return present(submittedRecord);
      const settled = await advance(submittedRecord, exec?.signal, true);
      return present(settled);
    },

    /**
     * `get_generation_task`.
     *
     * @param args - tool arguments.
     * @param exec - tool execution context.
     * @returns the tool result value.
     */
    async get(args, exec) {
      const record = await loadTask(dshHome, args.task_id);
      if (record === undefined) throw new Error(`task ${args.task_id} was not found`);
      if (isFinalStatus(record.status)) return present(record);
      const advanced = await advance(record, exec?.signal, false);
      return present(advanced);
    },

    /**
     * `list_generation_tasks`.
     *
     * @param args - tool arguments.
     * @returns the tool result value.
     */
    async list(args) {
      const records = await listTasks(dshHome, {
        limit: typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 20,
        ...(typeof args.status === 'string' && args.status !== '' ? { status: args.status } : {}),
      });
      if (records.length === 0) {
        return { tasks: [], message: 'No video generation tasks recorded yet.' };
      }
      const lines = records.map((record) => {
        const account = record.account === undefined ? '' : ` [${record.account}]`;
        return `${record.id}${account} ${record.status} ${record.updated_at}`;
      });
      return {
        tasks: records.map((record) => present(record)),
        message: `${records.length} task(s), newest first:\n${lines.join('\n')}`,
      };
    },

    /**
     * `cancel_generation_task`.
     *
     * @param args - tool arguments.
     * @param exec - tool execution context.
     * @returns the tool result value.
     */
    async cancel(args, exec) {
      const record = await loadTask(dshHome, args.task_id);
      if (record === undefined) throw new Error(`task ${args.task_id} was not found`);
      if (isFinalStatus(record.status)) return present(record);
      const live = (await accounts()).find((entry) => entry.name === record.account);
      if (live === undefined) {
        throw new Error(`account ${record.account} is no longer in the ${ACCOUNTS_REF} credential; cancel the call from the Modal dashboard`);
      }
      const outcome = await runner({
        appDir,
        args: ['cancel', '--task-dir', taskDir(dshHome, record.id)],
        account: live,
        signal: exec?.signal,
        timeoutMs: 300_000,
      });
      const next = applyOutcome(record, { ...outcome, status: outcome.status === 'cancelled' ? 'cancelled' : outcome.status });
      await saveTask(dshHome, next);
      return present(next);
    },

    /**
     * `accounts_status`.
     *
     * @param args - tool arguments.
     * @param exec - tool execution context.
     * @returns the tool result value.
     */
    async accountsStatus(args, exec) {
      const parsed = parseAccountPool(await resolveAccounts());
      if (parsed.accounts.length === 0) {
        return {
          accounts: [],
          pool_errors: parsed.errors,
          message:
            `The ${ACCOUNTS_REF} credential is not usable: ${parsed.errors.join('; ')}. ` +
            'Set it from Settings → Plugins → modal-h3.',
        };
      }
      const state = await poolState();
      const counts = await inFlight();
      const rows = [];
      for (const account of parsed.accounts) {
        const cached = state.accounts[account.name];
        let deployed = cached?.status ?? 'unknown';
        let detail = cached?.message;
        let probedAt = cached?.probed_at;
        if (args.live === true) {
          const outcome = await runner({
            appDir,
            args: ['probe'],
            account,
            signal: exec?.signal,
            timeoutMs: 300_000,
          });
          deployed = outcome.status;
          detail = outcome.message;
          probedAt = new Date().toISOString();
          // Only the probe RESULT is cached, never the account itself: this file
          // is plaintext on disk, and copying the entry here would write the
          // token to it — the one thing this design exists to avoid.
          state.accounts[account.name] = { status: deployed, message: detail, probed_at: probedAt };
        }
        // A refused account is still `deployed` — the App is there, the workspace
        // just will not spend. Reporting only the probe result would say "fine"
        // about an account that fails every submission, which is the one answer
        // that sends the caller back to the same wall.
        const refusal = state.refusing[account.name];
        rows.push({
          name: account.name,
          deployed,
          in_flight: counts.get(account.name) ?? 0,
          ...(refusal === undefined ? {} : { refusing: true, refusal: refusal.message }),
          ...(detail === undefined ? {} : { detail }),
          ...(account.monthlyCreditUsd === undefined ? {} : { monthly_credit_usd: account.monthlyCreditUsd }),
          ...(probedAt === undefined ? {} : { probed_at: probedAt }),
        });
      }
      if (args.live === true) await savePoolState(state);
      const usable = rows.filter((row) => row.deployed === USABLE_PROBE && row.refusing !== true).length;
      const busy = rows.reduce((total, row) => total + row.in_flight, 0);
      const lines = rows.map(
        (row) =>
          `${row.name}: ${row.deployed}` +
          `${row.in_flight > 0 ? `, ${row.in_flight} in flight` : ''}` +
          `${row.refusing === true ? ', REFUSING submissions' : ''}` +
          `${row.monthly_credit_usd === undefined ? '' : `, $${row.monthly_credit_usd}/cycle`}` +
          `${row.detail === undefined ? '' : ` (${row.detail})`}` +
          `${row.refusal === undefined ? '' : ` [last submit failed: ${row.refusal}]`}`,
      );
      return {
        accounts: rows,
        ...(parsed.errors.length === 0 ? {} : { pool_errors: parsed.errors }),
        message:
          `${rows.length} account(s), ${usable} usable, ${busy} generation(s) in flight. ` +
          `Each account runs one generation at a time.\n${lines.join('\n')}`,
      };
    },

    /**
     * `accounts_sync`.
     *
     * @param args - tool arguments.
     * @param exec - tool execution context.
     * @returns the tool result value.
     */
    async accountsSync(args, exec) {
      const parsed = parseAccountPool(await resolveAccounts());
      if (parsed.errors.length > 0) {
        return {
          synced: [],
          failed: [],
          message: `The ${ACCOUNTS_REF} credential is not usable: ${parsed.errors.join('; ')}`,
        };
      }
      const state = await poolState();
      const targets =
        args.account === undefined || String(args.account).trim() === ''
          ? parsed.accounts
          : parsed.accounts.filter((entry) => entry.name === String(args.account).trim());
      if (targets.length === 0) {
        const known = parsed.accounts.map((entry) => entry.name).join(', ');
        return { synced: [], failed: [], message: `No pooled account named ${args.account}; pooled accounts: ${known}` };
      }
      if (args.dry_run === true) {
        const lines = targets.map((entry) => {
          const cached = state.accounts[entry.name];
          return `${entry.name}: ${cached?.status === USABLE_PROBE ? 'already deployed (re-running sync is still safe)' : 'would deploy and bootstrap'}`;
        });
        return {
          synced: [],
          failed: [],
          message: `Dry run: nothing was deployed.\n${lines.join('\n')}`,
        };
      }
      const synced = [];
      const failed = [];
      for (const entry of targets) {
        try {
          await runner({
            appDir,
            args: ['sync'],
            account: entry,
            signal: exec?.signal,
            timeoutMs: SYNC_TIMEOUT_MS - 60_000,
          });
          synced.push(entry.name);
          state.accounts[entry.name] = { status: USABLE_PROBE, probed_at: new Date().toISOString() };
          // A sync deploys and bootstraps, which is a real, authenticated round
          // trip: an account that gets through it is working again.
          delete state.refusing[entry.name];
        } catch (error) {
          failed.push({ name: entry.name, error: error.message });
          state.accounts[entry.name] = {
            ...(state.accounts[entry.name] ?? {}),
            status: 'unknown',
            message: error.message,
            probed_at: new Date().toISOString(),
          };
        }
        await savePoolState(state);
      }
      const summary = [
        synced.length === 0 ? 'No account was synced.' : `Synced: ${synced.join(', ')}.`,
        ...(failed.length === 0 ? [] : [`Failed: ${failed.map((item) => `${item.name} (${item.error})`).join('; ')}`]),
      ];
      return { synced, failed, message: summary.join(' ') };
    },

  };
}
