/**
 * Tests for the runner seam: the argv and environment of the Python child.
 *
 * This seam has no logic worth testing except the two things that are silently
 * wrong when they are wrong. `-s` must be repeated once per package — a single
 * space-joined `--spec "a b c"` is parsed as ONE matchspec and fails to solve
 * with `No candidates were found for python ==3.11[build="pillow=..."]`, which
 * reads like a broken package rather than a broken argument. And the two token
 * variables must reach the child's environment and nothing else: no profile
 * path, no `--profile` flag, no token on the command line (where `ps` would show
 * it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PIXI_SPECS, RUNNER_SCRIPT, runnerArgv, runnerEnv } from '../src/runner.js';

const APP_DIR = '/opt/dsh-modal-h3';

test('the pinned environment covers interpreter, image decoding, media probing and the Modal client', () => {
  assert.deepEqual(PIXI_SPECS, ['python=3.11', 'pillow=12.3.0', 'ffmpeg=8.1.1', 'modal-client==1.5.5']);
});

test('each spec is passed as its own -s, never joined into one matchspec', () => {
  const argv = runnerArgv(APP_DIR, ['probe']);
  assert.equal(argv[0], 'exec');
  for (const spec of PIXI_SPECS) {
    assert.ok(argv.includes(spec), `missing ${spec}`);
    assert.equal(argv[argv.indexOf(spec) - 1], '-s');
  }
  // Every -s must come before the interpreter, or pixi reads it as a command arg.
  assert.ok(argv.lastIndexOf('-s') < argv.indexOf('python'));
});

test('the runner script is addressed from the package root, not the working directory', () => {
  const argv = runnerArgv(APP_DIR, ['poll', '--task-dir', '/tmp/t']);
  assert.equal(argv[argv.indexOf('python') + 1], `${APP_DIR}/${RUNNER_SCRIPT}`);
  assert.deepEqual(argv.slice(-3), ['poll', '--task-dir', '/tmp/t']);
});

test('the token variables are the only credential channel, and no token reaches argv', () => {
  const account = { name: 'acc1', tokenId: 'ak-secret-id', tokenSecret: 'super-secret' };
  const env = runnerEnv(APP_DIR, account);
  assert.equal(env.MODAL_TOKEN_ID, 'ak-secret-id');
  assert.equal(env.MODAL_TOKEN_SECRET, 'super-secret');
  assert.equal(env.PYTHONPATH, `${APP_DIR}/app`);
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  const argv = runnerArgv(APP_DIR, ['probe']).join(' ');
  assert.doesNotMatch(argv, /ak-secret-id|super-secret/);
  assert.doesNotMatch(argv, /--profile/);
});

test('a local-only command gets no token variables at all', () => {
  const env = runnerEnv(APP_DIR, undefined);
  assert.equal('MODAL_TOKEN_ID' in env, false);
  assert.equal('MODAL_TOKEN_SECRET' in env, false);
});
