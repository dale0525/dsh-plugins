/**
 * Tests for the orchestration seam, with a fake Python runner.
 *
 * Three properties are tested here, and each one is a bug that a real
 * generation would surface only after money was spent:
 *
 *  - **No token reaches the state file.** `pool.json` is plaintext on disk; the
 *    cached probe result must therefore carry the status and nothing else. A
 *    cached copy of the account entry would quietly write the token there.
 *  - **A task is bound to the account that spawned it.** Polling with a pool that
 *    no longer contains that account must produce an explicit `unknown` with an
 *    explanation, not a crash and not a poll with the wrong credential.
 *  - **`dry_run` spends nothing and records nothing.** It must not touch the
 *    pool, must not create a task directory, and must not return a task id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createService } from '../src/tasks.js';

const POOL = JSON.stringify({
  tokens: [
    { name: 'acc1', token_id: 'ak-1', token_secret: 'secret-1' },
    { name: 'acc2', token_id: 'ak-2', token_secret: 'secret-2' },
  ],
});

/**
 * The admission result `preflight` prints, trimmed to what the service reads.
 *
 * The shape is the runner's, not this test's convenience: the receipt nests the
 * request id under `preflight` and repeats the request at the top level, and the
 * service reads both.
 */
const ADMITTED = {
  status: 'admitted',
  preflight: { request_id: 'req-1' },
  request: {
    duration_seconds: 4.0,
    output_frames: 96,
    generation_frames: 107,
    prompt_media_map: { pictures: [{ ordinal: 1, source: 'reference_image', source_ordinal: 1 }], videos: [], audios: [] },
  },
};

/**
 * A fake runner that records every call and answers from a script.
 *
 * @param handlers - subcommand name to `(call) => result`; a result may also be a
 *   thrown error to model a failing child.
 * @returns `{calls, runner}`.
 */
function fakeRunner(handlers) {
  const calls = [];
  const runner = async (call) => {
    const [command] = call.args;
    calls.push({ command, ...call });
    const handler = handlers[command];
    if (handler === undefined) throw new Error(`unexpected runner command ${command}`);
    return handler(call);
  };
  return { calls, runner };
}

/**
 * A service over a throwaway home.
 *
 * @param handlers - the fake runner's script.
 * @param accounts - the credential value to resolve.
 * @returns `{service, calls, home}`.
 */
async function harness(handlers, accounts = POOL) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-modal-h3-tasks-'));
  const { calls, runner } = fakeRunner(handlers);
  const service = createService({
    appDir: '/nonexistent-package-root',
    dshHome: home,
    resolveAccounts: async () => accounts,
    runner,
  });
  return { service, calls, home };
}

test('dry_run admits without a credential, a pool record or a task directory', async (t) => {
  const { service, calls, home } = await harness({ preflight: () => ADMITTED }, '');
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await service.generate({ prompt: 'p', dry_run: true }, {});
  assert.equal(result.status, 'dry-run');
  assert.equal(result.task_id, undefined, 'a dry run must not name a task that was never recorded');
  assert.equal(result.effective_duration_seconds, 4.0);
  assert.deepEqual(result.prompt_media_map.pictures.length, 1);
  assert.deepEqual(calls.map((call) => call.command), ['preflight']);
  // No task directory, and no pool.json either: a dry run writes nothing durable.
  assert.deepEqual(await readdir(join(home, 'dsh-modal-h3')), ['preflight']);
});

test('a submit records the account, and polling re-reads the token from the pool', async (t) => {
  const { service, calls, home } = await harness({
    preflight: () => ADMITTED,
    submit: () => ({ status: 'submitted', function_call_id: 'fc-1', request_id: 'req-1' }),
    poll: () => ({ status: 'running', message: 'Still generating.' }),
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const submitted = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.account, 'acc1');
  assert.match(submitted.task_id, /^h3-/);

  // The submit carried the token of the chosen account, as environment only.
  const submit = calls.find((call) => call.command === 'submit');
  assert.equal(submit.account.tokenSecret, 'secret-1');

  const polled = await service.get({ task_id: submitted.task_id }, {});
  assert.equal(polled.status, 'running');
  const poll = calls.find((call) => call.command === 'poll');
  assert.equal(poll.account.tokenSecret, 'secret-1', 'polling must use the current token for that account');
});

test('the cached probe result never carries the account, so no token reaches the state file', async (t) => {
  const { service, home } = await harness({ probe: () => ({ status: 'deployed' }) });
  t.after(() => rm(home, { recursive: true, force: true }));

  await service.accountsStatus({ live: true }, {});
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(join(home, 'dsh-modal-h3', 'pool.json'), 'utf8');
  assert.doesNotMatch(raw, /secret-1|secret-2|ak-1|ak-2/);
  assert.match(raw, /deployed/);
});

test('accounts_status puts the credit in the text the model reads, not only the rows', async (t) => {
  // The row carries `monthly_credit_usd`, but the tool's render is `value.message`
  // — a credit that appears only in the structured row is invisible to the model,
  // which is the only consumer.
  const pool = JSON.stringify({
    tokens: [{ name: 'acc1', token_id: 'ak-1', token_secret: 's1', monthly_credit_usd: 30 }],
  });
  const { service, home } = await harness({ preflight: () => ADMITTED }, pool);
  t.after(() => rm(home, { recursive: true, force: true }));

  const status = await service.accountsStatus({}, {});
  assert.match(status.message, /acc1: unknown, \$30\/cycle/);
  assert.equal(status.accounts[0].monthly_credit_usd, 30);
});

test('an account with no declared credit says nothing about credit', async (t) => {
  // Only 1 of the pool's entries may declare a credit; an absent value must not
  // render as "$undefined/cycle" or "$0/cycle".
  const pool = JSON.stringify({ tokens: [{ name: 'acc1', token_id: 'ak-1', token_secret: 's1' }] });
  const { service, home } = await harness({ preflight: () => ADMITTED }, pool);
  t.after(() => rm(home, { recursive: true, force: true }));

  const status = await service.accountsStatus({}, {});
  assert.doesNotMatch(status.message, /cycle/);
  assert.equal(status.accounts[0].monthly_credit_usd, undefined);
});

test('a live probe and a sync both keep the token out of the state file', async (t) => {
  // The earlier version cached the whole account entry beside the probe result,
  // which wrote both tokens into pool.json in plaintext. Every write path that
  // touches `state.accounts` is exercised here, because one is enough to leak.
  const { service, home } = await harness({
    probe: () => ({ status: 'deployed' }),
    sync: () => ({ status: 'synced' }),
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  await service.accountsStatus({ live: true }, {});
  await service.accountsSync({}, {});
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(join(home, 'dsh-modal-h3', 'pool.json'), 'utf8');
  assert.doesNotMatch(raw, /secret-1|secret-2|ak-1|ak-2|tokenSecret|tokenId/);
});

test('accounts_status without live reports cached state and touches nothing', async (t) => {
  const { service, calls, home } = await harness({});
  t.after(() => rm(home, { recursive: true, force: true }));

  const cold = await service.accountsStatus({}, {});
  assert.deepEqual(cold.accounts.map((row) => row.deployed), ['unknown', 'unknown']);
  assert.deepEqual(calls, [], 'a cached read must not run the runner');
});

test('a pool that no longer contains the task account yields unknown with an explanation', async (t) => {
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: () => ({ status: 'submitted', function_call_id: 'fc-1', request_id: 'req-1' }),
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const submitted = await service.generate({ prompt: 'p', wait_for_completion: false, account: 'acc2' }, {});
  assert.equal(submitted.account, 'acc2');

  // Rotate the pool so acc2 is gone; the in-flight call must stay reachable in
  // words even though it can no longer be polled.
  const narrowed = createService({
    appDir: '/nonexistent-package-root',
    dshHome: home,
    resolveAccounts: async () => JSON.stringify({ tokens: [{ name: 'acc1', token_id: 'ak-1', token_secret: 's' }] }),
    runner: async () => {
      throw new Error('the runner must not be called for an account that is gone');
    },
  });
  const polled = await narrowed.get({ task_id: submitted.task_id }, {});
  assert.equal(polled.status, 'unknown');
  assert.match(polled.error, /no longer in the MODAL_H3_ACCOUNTS credential/);
  assert.match(polled.error, /cancel the call from the Modal dashboard/);
});

test('a broken pool refuses to submit, and lists every problem', async (t) => {
  const { service, calls, home } = await harness({ preflight: () => ADMITTED }, '{"tokens":[{"name":""}]}');
  t.after(() => rm(home, { recursive: true, force: true }));

  await assert.rejects(
    () => service.generate({ prompt: 'p' }, {}),
    /MODAL_H3_ACCOUNTS credential is not usable: tokens\[0\]\.name is missing or empty; tokens\[0\]\.token_id is missing or empty; tokens\[0\]\.token_secret is missing or empty/,
  );
  assert.deepEqual(calls.map((call) => call.command), ['preflight'], 'the admission runs before the pool is read');
});

test('a submit that failed but left a call id is adopted instead of declared failed', async (t) => {
  // The runner writes call.json the moment the spawn returns, so a child killed
  // afterwards leaves a PAID call with no recorded handle. Adopting it is the
  // only way to keep that call reachable.
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: async (call) => {
      const { writeFile } = await import('node:fs/promises');
      // `submit --task-dir <dir>`: the directory is the third argv element.
      await writeFile(join(call.args[2], 'call.json'), JSON.stringify({ function_call_id: 'fc-orphan' }));
      throw new Error('the child was killed after the spawn');
    },
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  assert.equal(result.status, 'submitted');
  assert.match(result.error, /a Modal call was recorded/);
});

test('a submit that failed with no call id is a plain failure', async (t) => {
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: () => {
      throw new Error('NotFoundError: App is not deployed');
    },
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  assert.equal(result.status, 'failed');
  assert.match(result.error, /App is not deployed/);
});

test('an unsubmitted poll becomes a failure rather than a pollable status', async (t) => {
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: () => ({ status: 'submitted', function_call_id: 'fc-1', request_id: 'req-1' }),
    poll: () => ({ status: 'unsubmitted' }),
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const submitted = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  const polled = await service.get({ task_id: submitted.task_id }, {});
  assert.equal(polled.status, 'failed');
  assert.match(polled.error, /nothing was submitted/);
});

test('a completed task with out_dir copies the video and the report out', async (t) => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-modal-h3-out-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));

  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: () => ({ status: 'submitted', function_call_id: 'fc-1', request_id: 'req-1' }),
    // The runner writes the delivered files into the task directory; the
    // service is what copies them to `out_dir`, so the fake has to create them.
    wait: async (call) => {
      const directory = call.args[2];
      await writeFile(join(directory, 'output.mp4'), 'mp4-bytes');
      await writeFile(join(directory, 'report.json'), '{"ok":true}');
      return { status: 'completed', output_path: join(directory, 'output.mp4'), report_path: join(directory, 'report.json') };
    },
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await service.generate({ prompt: 'p', out_dir: outDir }, {});
  assert.equal(result.status, 'completed');
  assert.equal(result.output_path, join(outDir, 'output.mp4'));
  assert.equal(await readFile(result.output_path, 'utf8'), 'mp4-bytes');
  assert.equal(await readFile(join(outDir, 'report.json'), 'utf8'), '{"ok":true}');
});

test('a cancelled tool call is rethrown, not recorded as an unknown task', async (t) => {
  const controller = new AbortController();
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: () => ({ status: 'submitted', function_call_id: 'fc-1', request_id: 'req-1' }),
    // A non-blocking `get` uses `poll`, not `wait`.
    poll: () => {
      controller.abort();
      throw new Error('the child was killed');
    },
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const submitted = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  await assert.rejects(
    () => service.get({ task_id: submitted.task_id }, { signal: controller.signal }),
    /the child was killed/,
  );
});

test('an account that refused a submit is skipped by the next one', async (t) => {
  // A spent billing cycle rejects the call outright, so retrying the same
  // account fails forever. The refusal must steer the next submit elsewhere.
  const refused = [];
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: (call) => {
      if (call.account.name === 'acc1') {
        refused.push(call.account.name);
        throw new Error('ResourceExhaustedError: workspace billing cycle spend limit reached');
      }
      return { status: 'submitted', function_call_id: 'fc-1', request_id: 'req-1' };
    },
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const first = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  assert.equal(first.status, 'failed');
  assert.match(first.error, /billing cycle spend limit/);

  const second = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  assert.equal(second.status, 'submitted');
  assert.equal(second.account, 'acc2');
  assert.deepEqual(refused, ['acc1'], 'the refusing account must not be tried twice');
});

test('a refusal is reported by accounts_status, and cleared by a later success', async (t) => {
  let refuse = true;
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: (call) => {
      if (refuse && call.account.name === 'acc1') throw new Error('workspace billing cycle spend limit reached');
      return { status: 'submitted', function_call_id: 'fc-1', request_id: 'req-1' };
    },
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  await service.generate({ prompt: 'p', wait_for_completion: false, account: 'acc1' }, {});
  const reported = await service.accountsStatus({}, {});
  const acc1 = reported.accounts.find((row) => row.name === 'acc1');
  assert.equal(acc1.refusing, true);
  assert.match(acc1.refusal, /billing cycle spend limit/);
  assert.match(reported.message, /acc1: unknown, REFUSING submissions/);

  refuse = false;
  await service.generate({ prompt: 'p', wait_for_completion: false, account: 'acc1' }, {});
  const cleared = await service.accountsStatus({}, {});
  assert.equal(cleared.accounts.find((row) => row.name === 'acc1').refusing, undefined);
});

test('when every account refuses, the real Modal error is still raised', async (t) => {
  // Filtering on refusals must not turn a broken pool into "no account
  // available": the caller needs to see why nothing works.
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: () => {
      throw new Error('AuthError: invalid token');
    },
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const first = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  assert.equal(first.status, 'failed');
  const second = await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  assert.equal(second.status, 'failed');
  assert.match(second.error, /invalid token/);
});

test('list reports the newest tasks with their status, and an empty home says so', async (t) => {
  const { service, home } = await harness({
    preflight: () => ADMITTED,
    submit: () => ({ status: 'submitted', function_call_id: 'fc-1', request_id: 'req-1' }),
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.match((await service.list({})).message, /No video generation tasks/);
  await service.generate({ prompt: 'p', wait_for_completion: false }, {});
  const listed = await service.list({});
  assert.equal(listed.tasks.length, 1);
  assert.match(listed.message, /submitted/);
});
