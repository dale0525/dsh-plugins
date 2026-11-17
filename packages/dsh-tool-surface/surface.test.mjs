import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDANCE_GROUPS } from './guidance.mjs';
import { DEFAULT_KEEP, filterAnnounced, renderWithdrawnGuidance } from './surface.mjs';

/** One tool definition as the assembly carries it. */
const defined = (name) => ({ name, description: '', parameters: {} });

test('the default whitelist is the most-called tools, plus every tool an owning plugin announces', () => {
  // Two rules, and the second one is the fix for 2026-11-17:
  //
  // 1. Order is pinned for the call-count picks: it is the only record of WHY
  //    these and not one more.
  // 2. Every tool an owning plugin announces is appended, because both that
  //    plugin and this one filter `system-prompt:assemble` and the two compose
  //    to the INTERSECTION. The owner knows which of its tools have arguments a
  //    model cannot guess; this list is an outside layer with statistics.
  //
  // `pwsh` is the single addition that is neither: same shell slot as `bash`,
  // and the host enables exactly one per platform (`tool-bash` disabled on
  // win32, `tool-pwsh` enabled). Without it a Windows install had no shell tool
  // left in the prompt at all (2026-11-13).
  assert.deepEqual(DEFAULT_KEEP, [
    'bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep',
    'web_fetch', 'web_search', 'read_image',
    'todo_write', 'ask_user_question', 'send_message', 'present',
    'subagent', 'list_agents', 'job_output', 'job_list', 'job_kill',
    'skill', 'ssh_exec', 'get_goal', 'update_goal',
    'mcp__openviking__read', 'mcp__openviking__find',
    'mcp__openviking__write', 'mcp__openviking__edit',
    'mcp__openviking__search', 'mcp__openviking__list',
    'mcp__openviking__remember', 'mcp__openviking__forget',
    'mcp__openviking__glob', 'mcp__openviking__grep',
    'mcp__openviking__health',
    'mcp__stitch__create_design_system',
    'mcp__stitch__create_design_system_from_design_md',
    'mcp__stitch__apply_design_system',
    'mcp__stitch__upload_design_md',
    'mcp__stitch__generate_screen_from_text',
    'mcp__stitch__edit_screens',
    'mcp__stitch__generate_variants',
    'mcp__modal_h3__get_generation_task',
    'mcp__modal_h3__cancel_generation_task',
    'mcp__modal_h3__list_generation_tasks',
    'mcp__modal_h3__accounts_status',
    'mcp__modal_h3__accounts_sync',
  ]);
});

test('the two shell slots are both kept, so neither platform loses its shell', () => {
  // bash and pwsh are mutually exclusive on any single host; the failure this
  // pins is the Windows half being withdrawn while bash was kept by name.
  assert.ok(DEFAULT_KEEP.includes('bash') && DEFAULT_KEEP.includes('pwsh'));
});

test('nothing in the whitelist is removed', () => {
  const tools = DEFAULT_KEEP.map(defined);
  assert.equal(filterAnnounced(tools).length, tools.length);
});

test('a tool outside the whitelist is removed', () => {
  const tools = ['bash', 'ssh_read', 'mcp__stitch__list_projects'].map(defined);
  assert.deepEqual(filterAnnounced(tools).map((tool) => tool.name), ['bash']);
});

test('nothing withdrawn returns the same array', () => {
  // The assembly is rebuilt every step; a fresh array per step would change the
  // cached request header and spend the cache the filter exists to save.
  const tools = ['bash', 'read'].map(defined);
  assert.equal(filterAnnounced(tools), tools);
});

test('a non-array passes through', () => {
  assert.equal(filterAnnounced(undefined), undefined);
  assert.equal(filterAnnounced(null), null);
  assert.deepEqual(filterAnnounced({ tools: [] }), { tools: [] });
});

test('a definition without a string name is kept', () => {
  const anonymous = { description: '', parameters: {} };
  assert.deepEqual(filterAnnounced([anonymous, defined('ssh_read')]), [anonymous]);
});

test('every guidance group that survives names at least one of its tools', () => {
  // A group whose every tool is announced disappears from the prose entirely
  // (`renderWithdrawnGuidance` skips it), so the assertion is about the groups
  // that still appear. 2026-11-17 made that a real state rather than a
  // hypothetical: the whitelist now keeps all eleven of openviking's announced
  // tools, so its group is gone — asserting the group's title appears would
  // demand prose describing schemas the prompt already carries in full.
  const text = renderWithdrawnGuidance(GUIDANCE_GROUPS, DEFAULT_KEEP);
  assert.equal(GUIDANCE_GROUPS.length > 0, true);
  for (const group of GUIDANCE_GROUPS) {
    const withdrawn = group.tools.filter((tool) => !DEFAULT_KEEP.includes(tool.name));
    if (withdrawn.length === 0) continue;
    assert.ok(text.includes(group.title), `${group.title} has withdrawn tools and must appear`);
    const named = withdrawn.some((tool) => text.includes(`\`${tool.name}\``));
    assert.ok(named, `${group.title} must name at least one of its withdrawn tools`);
  }
});

test('a guidance group whose tools are all announced disappears', () => {
  const ssh = GUIDANCE_GROUPS.find((group) => group.title === 'SSH 传输组');
  const text = renderWithdrawnGuidance([ssh], [...DEFAULT_KEEP, ...ssh.tools.map((tool) => tool.name)]);
  assert.equal(text, '', 'prose about a schema the prompt carries would be a stale second copy');
});

test('guidance names only the withdrawn member of a partially kept group', () => {
  const ssh = GUIDANCE_GROUPS.find((group) => group.title === 'SSH 传输组');
  const text = renderWithdrawnGuidance([ssh], [...DEFAULT_KEEP, 'ssh_list'], 'lead');
  assert.match(text, /`ssh_read`/);
  assert.doesNotMatch(text, /`ssh_list`/);
  assert.match(text, /^lead\n\n- SSH 传输组：/);
});

/**
 * Every tool the default whitelist withdraws, frozen from the live assembly of
 * 2026-11-11 (73 announced tools minus the 24 kept then).
 *
 * Frozen rather than read from a header at test time: a test that needs this
 * machine's session log cannot run in CI, and the point is not "what is
 * announced today" but "nothing may fall through the prose". An addition to the
 * surface that nobody classified fails the next assertion, which is exactly the
 * reminder wanted — a withdrawn tool named nowhere is a tool the model cannot
 * know exists, and it fails silently at call time instead of at review time.
 *
 * Updated 2026-11-17: twenty-one entries moved OUT of this list because the
 * whitelist now keeps them — every tool its owning plugin announces. They are
 * no longer withdrawn, so asserting the prose names them would assert that prose
 * describes tools the prompt already carries in full.
 *
 * Updated the same day `dsh-imagegen` was removed in favour of
 * `dsh-magpie-image`: `generate_image`, `edit_image` and the two
 * `*_image_generation_task` tools no longer exist, so keeping them here would
 * assert that prose names tools the host cannot execute. A list entry must
 * correspond to a real tool, or the assertion stops meaning anything.
 */
const WITHDRAWN_ON_2026_11_11 = [
  'browser_agent', 'config_sync_pull', 'config_sync_push',
  'create_goal', 'desktop_agent', 'exit_plan_mode',
  'interrupt_agent', 'list_mcp_resource_templates', 'list_mcp_resources',
  'list_subagent_models', 'mcp__magpie__generate_image', 'mcp__magpie__generation_result',
  'read_mcp_resource', 'schedule_create', 'schedule_delete',
  'schedule_list', 'schedule_update', 'ssh_download',
  'ssh_list', 'ssh_read', 'ssh_upload',
  'subagent_fork', 'workflow', 'working_directory',
];

test('every available tool the whitelist withdraws is named in the guidance', () => {
  // The failure this pins: on 2026-11-11 `mcp__openviking__search` was withdrawn
  // by the whitelist but missing from the prose, so the model would have lost
  // both its schema and its name. Nothing errored — the tool simply became
  // unknowable. A tool named nowhere cannot be called from intent.
  const text = renderWithdrawnGuidance(GUIDANCE_GROUPS, DEFAULT_KEEP);
  const unnamed = WITHDRAWN_ON_2026_11_11.filter((toolName) => !text.includes(`\`${toolName}\``));
  assert.deepEqual(unnamed, [], 'a withdrawn tool must be named or the model cannot know it exists');
});

test('a withdrawn write tool carries the sibling warning in its own note', () => {
  // The failure this pins (2026-11-17, session-5a49b173): the model announced
  // "now writing the decision memory" four times and called `read` each time —
  // the write-class tools were withdrawn while `read` and `find` stayed
  // announced, so the nearest visible sibling absorbed the intent. Naming the
  // tool (the assertion above) is not enough; the prose has to say the sibling
  // will not do the job. Nothing errored, and the memory was never written.
  //
  // Asserted on the group entries, not on the rendered line: every group renders
  // as ONE line separated by `、`, so a text regex from `write` to `不要用`
  // reaches `edit`'s note and passes even when `write` lost its own warning.
  // That fake assertion was written first and survived the defect, which is the
  // whole reason this reads the note field instead.
  //
  // Only the tools `read` can be mistaken for carry this warning. `forget`
  // deletes and `list`/`glob`/`grep`/`search` are reads themselves: a sibling
  // substitution there loses nothing silently, so a warning would be noise.
  const notes = new Map(
    GUIDANCE_GROUPS.flatMap((group) => group.tools).map((tool) => [tool.name, tool.note]),
  );
  for (const name of ['mcp__openviking__write', 'mcp__openviking__edit', 'mcp__openviking__remember']) {
    assert.match(notes.get(name) ?? '', /不要用 `mcp__openviking__read`/, `${name} lost its sibling warning`);
  }
});

test('the global whitelist never withdraws a tool its owning plugin announces', () => {
  // The composition failure this pins (2026-11-17, session-5a49b173): both
  // `dsh-openviking` and this plugin keep an announcement whitelist, both filter
  // `system-prompt/assemble`, and the two compose to the INTERSECTION. This
  // plugin's `DEFAULT_KEEP` held only `read` and `find`, so nine of openviking's
  // eleven announced tools were withdrawn anyway — `write` among them.
  //
  // What that cost: the model said "now writing the decision memory" four times
  // and called `read` each time. It was TOLD the tool existed (the prose names
  // it) and had NO definition for it (this list removed it). Nothing errored, so
  // nobody noticed the memory was never written. The same shape silently dropped
  // all seven of stitch's announced tools, including the three-deep
  // `create_design_system` schema it keeps announced precisely because prose
  // cannot replace it.
  //
  // The rule is that a plugin's own list wins: it knows which of its tools have
  // arguments a model cannot guess. This list only gets to withdraw a tool when
  // no owning plugin announces it. `modal_h3` is deliberately absent below — it
  // withdraws `generate_video` itself and announces the other five, and those
  // five are listed here.
  const OWNERS_ANNOUNCE = {
    'mcp__openviking__': ['read', 'write', 'edit', 'find', 'search', 'list', 'remember', 'forget', 'glob', 'grep', 'health'],
    'mcp__stitch__': ['create_design_system', 'create_design_system_from_design_md', 'apply_design_system', 'upload_design_md', 'generate_screen_from_text', 'edit_screens', 'generate_variants'],
    'mcp__modal_h3__': ['get_generation_task', 'cancel_generation_task', 'list_generation_tasks', 'accounts_status', 'accounts_sync'],
  };
  const missing = [];
  for (const [prefix, names] of Object.entries(OWNERS_ANNOUNCE)) {
    for (const name of names) if (!DEFAULT_KEEP.includes(prefix + name)) missing.push(prefix + name);
  }
  assert.deepEqual(missing, [], 'a tool its owner announces must not be withdrawn here — the model hears about it and cannot call it');
});
