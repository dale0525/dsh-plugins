/**
 * The announced tool surface: what stays in the prompt, and the prose that
 * replaces the rest.
 *
 * The host assembles one tool list per step from every provider's schemas, and
 * the model reads that list. The registry that executes a call is a different
 * object: `tools.view(scope)` resolves a call through its registration layers
 * and never consults the assembly, so a tool absent from the assembly still
 * runs when it is named. That asymmetry is the whole mechanism — withdrawing a
 * definition costs the model its argument schema and nothing else.
 *
 * Measured on this machine (2026-11-11, 659 local sessions): the assembled tool
 * definitions were 81,473 characters of a one-request context, about 15.6% of
 * it; 63 calls went to tools that were no longer announced and 57 of them
 * succeeded — the six failures were the upstream tool's own errors, not
 * "unknown tool".
 *
 * @module @logictan/dsh-tool-surface/surface
 */

/**
 * The tool definitions that stay in the prompt.
 *
 * The first 24 names by measured call count on this machine (2026-11-11, the
 * `tool/call` records across 659 local sessions), in that order. Every
 * definition kept here is paid for on every request of every session, which is
 * why the list stays this short rather than being the full surface.
 */
export const DEFAULT_KEEP = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'read_image',
  'todo_write',
  'ask_user_question',
  'send_message',
  'present',
  'subagent',
  'list_agents',
  'job_output',
  'job_list',
  'job_kill',
  'skill',
  'ssh_exec',
  'get_goal',
  'update_goal',
  'mcp__openviking__read',
  'mcp__openviking__find',
];

/**
 * Normalize a configured whitelist into the shape the filter reads.
 *
 * @param keep - tool names, as configured or as an exported constant.
 * @returns the names as a Set.
 */
function namesOf(keep) {
  return keep instanceof Set ? keep : new Set(Array.isArray(keep) ? keep : DEFAULT_KEEP);
}

/**
 * Drop every tool definition outside the whitelist from an assembled list.
 *
 * A non-array passes through: the waterfall runs on assemblies that may carry
 * no tools at all, and a hook that throws there would fail the whole step. A
 * definition with no string `name` is kept too — it is not something this
 * filter can identify, so removing it would be a guess.
 *
 * An unchanged list is returned as the SAME array, not a copy: the assembly is
 * rebuilt on every step of every session, and a fresh array per step would make
 * the request header differ from the cached prefix for no reason, spending the
 * cache instead of saving context.
 *
 * @param tools - the assembly's tool definitions.
 * @param keep - the names that stay announced.
 * @returns the same array when nothing was withdrawn, otherwise a filtered copy.
 */
export function filterAnnounced(tools, keep = DEFAULT_KEEP) {
  if (!Array.isArray(tools)) return tools;
  const names = namesOf(keep);
  const kept = tools.filter((tool) => typeof tool?.name !== 'string' || names.has(tool.name));
  return kept.length === tools.length ? tools : kept;
}

/**
 * Render one group of withdrawn tools as a prompt line.
 *
 * @param group - a guidance group, already narrowed to its withdrawn tools.
 * @returns the rendered bullet, without the trailing newline.
 */
function renderGroup(group) {
  const clauses = group.tools.map((tool) => {
    const detail = tool.note === undefined ? tool.args : `${tool.args}；${tool.note}`;
    return `\`${tool.name}\`（${detail}）`;
  });
  return `- ${group.title}：${clauses.join('、')}。`;
}

/**
 * Render the guidance section from the groups that are still withdrawn.
 *
 * Rendered from the live whitelist instead of being one frozen string: a
 * deployment that puts `ssh_read` back into `keep` would otherwise keep reading
 * that the ssh tools' arguments are written out in prose — and the model would
 * consult a line describing a schema the prompt now carries in full.
 *
 * A group whose every tool is announced disappears; when no group survives the
 * section is empty, and the caller contributes no section at all rather than a
 * lead sentence with nothing under it.
 *
 * @param groups - the guidance document, one entry per functional group.
 * @param keep - the names that stay announced.
 * @param lead - the opening sentence, or `''` to omit it.
 * @returns the section text, or `''` when every group is announced.
 */
export function renderWithdrawnGuidance(groups, keep = DEFAULT_KEEP, lead = '') {
  const names = namesOf(keep);
  const lines = [];
  for (const group of groups) {
    const withdrawn = group.tools.filter((tool) => !names.has(tool.name));
    if (withdrawn.length === 0) continue;
    lines.push(renderGroup({ ...group, tools: withdrawn }));
  }
  if (lines.length === 0) return '';
  return lead === '' ? lines.join('\n') : [lead, '', ...lines].join('\n');
}