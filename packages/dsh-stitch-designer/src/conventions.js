/**
 * The one design convention that is enforced rather than announced.
 *
 * "One code project owns exactly one Stitch project" is the only one of the
 * three with a computable predicate, so it is the only one implemented here.
 * The other two (TailwindCSS; implement from the exported HTML and ask before
 * deviating) are prose, and live in `src/guidance.js` as the plugin's
 * system-prompt announcement — a validator for them would be a lie.
 *
 * The rule is enforced rather than stated because a convention the model can
 * silently break is not a convention. The id is recorded in the code project's
 * own `.stitch.json`, and a second `create_project` from an already-bound
 * directory is refused with the existing id — a refusal the model does not
 * control. A recorded project that no longer exists upstream is cleared rather
 * than obeyed, so the refusal can never become a permanent dead end.
 *
 * @module @logictan/dsh-stitch-designer/conventions
 */
import { clearBinding, readBinding, writeBinding } from './project.js';

/**
 * Resolve the code project a tool call is running on behalf of.
 *
 * The session's working directory is the code project's identity here. A call
 * with no agent (a probe, a nested dispatch) has no directory, so it gets no
 * enforcement — that is not an error, it just has no project to bind.
 *
 * @param exec - the tool execution context.
 * @returns the absolute directory, or `undefined`.
 */
function codeDirectory(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

/**
 * The Stitch project id inside a `projects/<id>` resource name.
 *
 * Stitch is inconsistent about this: `create_project`'s result carries the full
 * resource name, while other payloads carry the bare id. Both shapes are
 * accepted here rather than at each call site.
 *
 * @param value - a resource name, a bare id, or anything else.
 * @returns the bare id, or `undefined`.
 */
function projectIdOf(value) {
  const text = String(value ?? '');
  if (text === '') return undefined;
  return text.startsWith('projects/') ? text.split('/').pop() : text;
}

/**
 * Whether a recorded project still exists upstream.
 *
 * Measured against the live server: an unknown or deleted project is answered
 * with `content: [{ text: 'Requested entity was not found.' }]` and NO
 * `structuredContent` — it is not an error response. That absence is the whole
 * liveness signal.
 *
 * @param stitch - the Stitch client.
 * @param projectId - the recorded project id.
 * @returns whether the project is still there.
 */
async function projectExists(stitch, projectId) {
  const result = await stitch.callTool('get_project', { name: `projects/${projectId}` }, undefined);
  return result?.structuredContent?.name !== undefined;
}

/**
 * Build the wrapper that keeps one code project on one Stitch project.
 *
 * The wrapper is the seam that sees the code project a call belongs to, which
 * is what makes the refusal possible at all — the Stitch tools themselves have
 * no idea which repository is calling them.
 *
 * @param options - the Stitch client.
 * @returns the `(rawName, args, exec)` invoker the tool definitions use.
 */
export function createInvoker(options) {
  const { stitch } = options;

  return async function invoke(rawName, args, exec) {
    const directory = codeDirectory(exec);
    const recorded = directory === undefined ? undefined : await readBinding(directory);

    if (rawName === 'create_project' && directory !== undefined && recorded !== undefined) {
      // A record pointing at a project that is gone must not be a dead end.
      if (await projectExists(stitch, recorded.projectId)) {
        throw new Error(
          `This code project is already bound to Stitch project ${recorded.projectId} ` +
            `(projects/${recorded.projectId}), recorded in ${directory}/.stitch.json. ` +
            'One code project owns exactly one Stitch project, so no second one may be created for it. ' +
            'Continue the existing project instead — list its screens, or generate into it with that projectId.',
        );
      }
      await clearBinding(directory);
    }

    const result = await stitch.callTool(rawName, args, exec);

    if (rawName === 'create_project') {
      const created = projectIdOf(result?.structuredContent?.name);
      if (created !== undefined && directory !== undefined) {
        await writeBinding(directory, created);
      }
      return result;
    }

    if (rawName === 'delete_project') {
      // The record is cleared only when it points at the project being deleted.
      if (recorded !== undefined && projectIdOf(args?.name) === recorded.projectId) await clearBinding(directory);
    }

    return result;
  };
}
