/**
 * Tests for the task-state seam.
 *
 * Two properties are load-bearing and both are about what happens when things go
 * wrong, not when they go right:
 *
 *  - `meta.json` is written atomically. A half-written record would make an
 *    in-flight generation look unsubmitted, and the obvious reaction to that —
 *    submit again — costs money for a second GPU run of the same prompt.
 *  - a task id is a single safe path segment. Task ids come back from the model,
 *    so `../` in one must not reach outside the tasks directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertTaskId,
  createTaskId,
  isFinalStatus,
  listTasks,
  loadTask,
  readJson,
  saveTask,
  stateRoot,
  taskDir,
  writeJson,
} from '../src/state.js';

/** A throwaway harness home. */
async function home() {
  return mkdtemp(join(tmpdir(), 'dsh-modal-h3-state-'));
}

/** One record shaped like the ones `src/tasks.js` writes. */
function record(id, status = 'submitted') {
  return { id, status, account: 'acc1', created_at: '2026-10-22T00:00:00.000Z', updated_at: '2026-10-22T00:00:00.000Z' };
}

test('the state root is project-neutral: it names the plugin, never a project', () => {
  const root = stateRoot('/home/u/.dsh');
  assert.equal(root, '/home/u/.dsh/dsh-modal-h3');
  assert.doesNotMatch(root, /novel/i);
});

test('a task id is time-prefixed and unique across same-millisecond calls', () => {
  const ids = new Set(Array.from({ length: 50 }, () => createTaskId(1_750_000_000_000)));
  assert.equal(ids.size, 50);
  // `2025-06-15T15:06:40.000Z` with the separators stripped.
  for (const id of ids) assert.match(id, /^h3-20250615150640000-[0-9a-f]{8}$/);
});

test('a task id that could escape the tasks directory is refused', () => {
  for (const bad of ['../escape', 'a/b', '', '.', '..', '-lead', 'x'.repeat(129), null, 42]) {
    assert.throws(() => assertTaskId(bad), /invalid task id/);
  }
  assert.equal(assertTaskId('h3-20250615T150640000-deadbeef'), 'h3-20250615T150640000-deadbeef');
});

test('a record round-trips, and reading a missing one yields undefined rather than throwing', async (t) => {
  const dir = await home();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await loadTask(dir, 'h3-x'), undefined);
  await saveTask(dir, record('h3-x'));
  assert.deepEqual(await loadTask(dir, 'h3-x'), record('h3-x'));
});

test('saving is atomic: no temporary file is left behind', async (t) => {
  const dir = await home();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveTask(dir, record('h3-x'));
  await saveTask(dir, record('h3-x', 'running'));
  const entries = await readdir(taskDir(dir, 'h3-x'));
  assert.deepEqual(entries, ['meta.json']);
  assert.equal((await loadTask(dir, 'h3-x')).status, 'running');
});

test('listTasks returns newest first, honours the limit, and filters by status', async (t) => {
  const dir = await home();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveTask(dir, record('h3-a', 'completed'));
  await saveTask(dir, record('h3-b', 'running'));
  await saveTask(dir, record('h3-c', 'failed'));
  assert.deepEqual((await listTasks(dir)).map((item) => item.id), ['h3-c', 'h3-b', 'h3-a']);
  assert.deepEqual((await listTasks(dir, { limit: 2 })).map((item) => item.id), ['h3-c', 'h3-b']);
  assert.deepEqual((await listTasks(dir, { status: 'running' })).map((item) => item.id), ['h3-b']);
});

test('listTasks on a fresh home is empty, and a directory without meta.json is skipped', async (t) => {
  const dir = await home();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await listTasks(dir), []);
  await saveTask(dir, record('h3-real'));
  // Residue of a crash between mkdir and the first save.
  await mkdir(taskDir(dir, 'h3-orphan'), { recursive: true });
  await writeJson(join(taskDir(dir, 'h3-orphan'), 'job.json'), { prompt: 'x' });
  assert.deepEqual((await listTasks(dir)).map((item) => item.id), ['h3-real']);
});

test('the final-status set is exactly the four states that stop polling', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'expired']) assert.equal(isFinalStatus(status), true);
  for (const status of ['submitted', 'running', 'unknown', 'nonsense']) assert.equal(isFinalStatus(status), false);
});

test('readJson rethrows a corrupt file instead of reporting it as missing', async (t) => {
  const dir = await home();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bad.json');
  await writeFile(path, '{ truncated', 'utf8');
  // `ENOENT` means "no such task"; a corrupt file is a different failure and
  // must not be swallowed into the same answer.
  await assert.rejects(() => readJson(path), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), '{ truncated');
});
