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
 *
 * `pwsh` is the one entry that is not a call-count pick: it is the SAME shell
 * slot as `bash`, mutually exclusive by platform. The host's profile disables
 * `tool-bash` on win32 and enables `dsh-tool-pwsh` there instead, so a machine
 * announces exactly one of the two — keeping both names costs no platform a
 * definition it would not have carried anyway. With only `bash` kept, a Windows
 * install lost the shell tool's schema AND its name: `pwsh` was withdrawn and
 * named nowhere (2026-11-13), leaving no shell tool the model could call.
 */
export const DEFAULT_KEEP = [
  'bash',
  'pwsh',
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
  // Everything below is a tool its OWNING plugin already announces, listed here
  // because both that plugin and this one filter `system-prompt/assemble` and
  // the two compose to the INTERSECTION. This list is the outer layer with
  // statistics; the owning plugin knows which of its tools have arguments a
  // model cannot guess, so its list wins. 2026-11-17 cost nine of openviking's
  // eleven announced tools, `write` among them: the model said "now writing the
  // decision memory" four times and called `read` each time — told the tool
  // exists, given no definition for it, and nothing errored.
  'mcp__openviking__write',
  'mcp__openviking__edit',
  'mcp__openviking__search',
  'mcp__openviking__list',
  'mcp__openviking__remember',
  'mcp__openviking__forget',
  'mcp__openviking__glob',
  'mcp__openviking__grep',
  'mcp__openviking__health',
  // Stitch announces these seven, three of them because their arguments are
  // structures prose cannot carry (`create_design_system` is three `$defs` deep
  // with a 68-value font enum). Withdrawing them here was a silent regression
  // of the reason stitch-drawer withdrew the other ten.
  'mcp__stitch__create_design_system',
  'mcp__stitch__create_design_system_from_design_md',
  'mcp__stitch__apply_design_system',
  'mcp__stitch__upload_design_md',
  'mcp__stitch__generate_screen_from_text',
  'mcp__stitch__edit_screens',
  'mcp__stitch__generate_variants',
  // modal_h3 withdraws `generate_video` itself and announces these five: they
  // are how a model reads a task's state, and their arguments are not
  // prose-guessable either.
  'mcp__modal_h3__get_generation_task',
  'mcp__modal_h3__cancel_generation_task',
  'mcp__modal_h3__list_generation_tasks',
  'mcp__modal_h3__accounts_status',
  'mcp__modal_h3__accounts_sync',
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