/**
 * Task state under `$DSH_HOME/dsh-modal-h3/`.
 *
 * The layout is deliberately project-neutral: a task id is the only handle, and
 * nothing in a path names the project that asked for the video. Any repository
 * can call this plugin and its outputs stay under the harness home, which is
 * what makes the plugin a general service rather than one project's helper.
 *
 * ```
 * $DSH_HOME/dsh-modal-h3/
 *   tasks/<taskId>/
 *     job.json        the caller's request (prompt, duration, reference paths)
 *     meta.json       account, status, timestamps, error — the record this module owns
 *     request.json    canonical request + preflight, written by the runner before submit
 *     call.json       Modal function call id, written by the runner after submit
 *     output.mp4      delivered video (postprocessed, ffprobe-verified)
 *     report.json     the worker's own report
 *   pool.json         last probe result per account, last-used order
 * ```
 *
 * `meta.json` is the single source of truth for status as far as the model is
 * concerned. It is rewritten atomically, because a half-written record would
 * make an in-flight generation look unsubmitted — the one failure mode where a
 * user could lose money by retrying.
 *
 * @module @logictan/dsh-modal-h3/state
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Directory name under the harness home; the plugin's whole footprint. */
export const STATE_DIR_NAME = 'dsh-modal-h3';

/** Statuses a task record can carry, in the order a task moves through them. */
export const TASK_STATUSES = ['submitted', 'running', 'completed', 'failed', 'cancelled', 'expired', 'unknown'];

/** Statuses after which no further progress is possible. */
const FINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);

/**
 * Whether a status is final.
 *
 * @param status - a task status.
 * @returns true when polling can stop.
 */
export function isFinalStatus(status) {
  return FINAL_STATUSES.has(status);
}

/**
 * Root of this plugin's state.
 *
 * @param dshHome - resolved harness home.
 * @returns the plugin state root.
 */
export function stateRoot(dshHome) {
  return join(dshHome, STATE_DIR_NAME);
}

/**
 * Directory of one task.
 *
 * @param dshHome - resolved harness home.
 * @param taskId - task id.
 * @returns the task directory.
 */
export function taskDir(dshHome, taskId) {
  return join(stateRoot(dshHome), 'tasks', taskId);
}

/**
 * Create a fresh task id.
 *
 * Time-prefixed so `readdir` order is also chronological, and random-suffixed so
 * two concurrent submissions in the same millisecond cannot collide.
 *
 * @param now - epoch milliseconds; injectable for tests.
 * @returns a filesystem-safe id.
 */
export function createTaskId(now = Date.now()) {
  return `h3-${new Date(now).toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
}

/**
 * Reject a task id that could escape the tasks directory.
 *
 * Task ids arrive from the model, so they are untrusted input: without this a
 * `../` id would let a read or cancel reach any file the harness can read.
 *
 * @param taskId - candidate id.
 * @returns the id.
 * @throws when the id is not a single safe path segment.
 */
export function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) {
    throw new Error(`invalid task id: ${String(taskId)}`);
  }
  return taskId;
}

/**
 * Write one JSON file atomically.
 *
 * @param path - destination.
 * @param value - lossless JSON value.
 */
export async function writeJson(path, value) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

/**
 * Read one JSON file, or `undefined` when it does not exist.
 *
 * @param path - source.
 * @returns the parsed value.
 */
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Persist a task record.
 *
 * @param dshHome - resolved harness home.
 * @param record - the record; `record.id` names its directory.
 */
export async function saveTask(dshHome, record) {
  const directory = taskDir(dshHome, record.id);
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, 'meta.json'), record);
}

/**
 * Load one task record.
 *
 * @param dshHome - resolved harness home.
 * @param taskId - task id.
 * @returns the record, or `undefined` when no such task exists.
 */
export async function loadTask(dshHome, taskId) {
  return readJson(join(taskDir(dshHome, assertTaskId(taskId)), 'meta.json'));
}

/**
 * List task records, newest first.
 *
 * A task directory without a readable `meta.json` is skipped rather than
 * reported: it is the residue of a crash between `mkdir` and the first save, and
 * it carries no account or status to act on.
 *
 * @param dshHome - resolved harness home.
 * @param options.limit - maximum records to return.
 * @param options.status - keep only records with this status.
 * @returns the records.
 */
export async function listTasks(dshHome, options = {}) {
  const { limit = 20, status } = options;
  let entries;
  try {
    entries = await readdir(join(stateRoot(dshHome), 'tasks'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries.sort().reverse()) {
    const record = await readJson(join(stateRoot(dshHome), 'tasks', entry, 'meta.json'));
    if (record === undefined) continue;
    if (status !== undefined && record.status !== status) continue;
    records.push(record);
    if (records.length >= limit) break;
  }
  return records;
}
