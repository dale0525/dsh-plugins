/**
 * The binding file this plugin keeps inside a code project.
 *
 * `.stitch.json` records which Stitch project a code project owns. It is the
 * project's own file, not plugin state: it belongs to the repository, travels
 * with it through git, and is read by whoever implements the design — this
 * session, a later one, or a teammate on another machine. That is why it is
 * kept per repository rather than in any machine-local cache under `$HOME`.
 *
 * It is deliberately small and hand-editable: it is the escape hatch when a
 * Stitch project was deleted, or when the wrong one was recorded.
 *
 * @module @logictan/dsh-stitch-designer/project
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The binding file, at the code project's root. */
export const BINDING_FILE = '.stitch.json';

/**
 * Read the code project's binding.
 *
 * A missing or hand-broken file means "not bound yet", which is the normal
 * first-run state — not a failure worth surfacing. The file is user-editable
 * by design, so a bad edit has to degrade to "unbound" rather than break every
 * Stitch tool call in the project.
 *
 * Only the id is kept. The title is not: it would be a second copy of a fact
 * Stitch already owns, and it goes stale the moment the project is renamed
 * upstream — while the binding rule reads the id alone.
 *
 * @param directory - the code project's root.
 * @returns `{ projectId }`, or `undefined` when unbound.
 */
export async function readBinding(directory) {
  try {
    const parsed = JSON.parse(await readFile(join(directory, BINDING_FILE), 'utf8'));
    const projectId = parsed?.projectId;
    if (typeof projectId !== 'string' || projectId === '') return undefined;
    return { projectId };
  } catch {
    return undefined;
  }
}

/**
 * Record the Stitch project this code project owns.
 *
 * First writer wins. Overwriting would let a stray design silently re-point a
 * code project at a different Stitch project — the exact 1:1 rule this file
 * exists to enforce — so a caller that finds a different project already
 * recorded must report that instead of replacing it.
 *
 * @param directory - the code project's root.
 * @param projectId - the Stitch project id.
 * @returns whether the file was written.
 */
export async function writeBinding(directory, projectId) {
  if (await readBinding(directory)) return false;
  await writeFile(join(directory, BINDING_FILE), `${JSON.stringify({ projectId }, null, 2)}\n`);
  return true;
}

/**
 * Drop the binding, so the code project can bind again.
 *
 * Called when the recorded Stitch project is gone, or when it is deleted
 * through this plugin. Without it a binding to a deleted project would block
 * `create_project` from that directory forever, with no way back short of
 * hand-editing `.stitch.json`.
 *
 * @param directory - the code project's root.
 */
export async function clearBinding(directory) {
  await rm(join(directory, BINDING_FILE), { force: true });
}
