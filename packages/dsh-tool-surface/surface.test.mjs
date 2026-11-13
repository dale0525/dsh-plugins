import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDANCE_GROUPS } from './guidance.mjs';
import { DEFAULT_KEEP, filterAnnounced, renderWithdrawnGuidance } from './surface.mjs';

/** One tool definition as the assembly carries it. */
const defined = (name) => ({ name, description: '', parameters: {} });

test('the default whitelist is the 24 most-called tools plus the platform shell slot', () => {
  // Measured on this machine (2026-11-11, the `tool/call` records across 659
  // local sessions), in call-count order. Order is pinned: it is the only
  // record of WHY these and not one more.
  //
  // `pwsh` is the single addition after the measurement: it is the same shell
  // slot as `bash`, and the host enables exactly one of the two per platform
  // (`tool-bash` disabled on win32, `tool-pwsh` enabled). It therefore costs no
  // platform a definition it would otherwise have carried, and without it a
  // Windows install had no shell tool left in the prompt at all.
  assert.deepEqual(DEFAULT_KEEP, [
    'bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep',
    'web_fetch', 'web_search', 'read_image',
    'todo_write', 'ask_user_question', 'send_message', 'present',
    'subagent', 'list_agents', 'job_output', 'job_list', 'job_kill',
    'skill', 'ssh_exec', 'get_goal', 'update_goal',
    'mcp__openviking__read', 'mcp__openviking__find',
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

test('every guidance group names at least one of its tools', () => {
  const text = renderWithdrawnGuidance(GUIDANCE_GROUPS, DEFAULT_KEEP);
  assert.equal(GUIDANCE_GROUPS.length > 0, true);
  for (const group of GUIDANCE_GROUPS) {
    const named = group.tools.some((tool) => text.includes(`\`${tool.name}\``));
    assert.ok(named, `${group.title} must name at least one tool`);
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
 * Updated the same day `dsh-imagegen` was removed in favour of
 * `dsh-magpie-image`: `generate_image`, `edit_image` and the two
 * `*_image_generation_task` tools no longer exist, so keeping them here would
 * assert that prose names tools the host cannot execute. A list entry must
 * correspond to a real tool, or the assertion stops meaning anything.
 */
const WITHDRAWN_ON_2026_11_11 = [
  'browser_agent', 'config_sync_pull',
  'config_sync_push', 'create_goal', 'desktop_agent',
  'exit_plan_mode',
  'interrupt_agent', 'list_mcp_resource_templates', 'list_mcp_resources',
  'list_subagent_models', 'mcp__magpie__generate_image',
  'mcp__magpie__generation_result', 'mcp__modal_h3__accounts_status',
  'mcp__modal_h3__accounts_sync', 'mcp__modal_h3__cancel_generation_task',
  'mcp__modal_h3__get_generation_task', 'mcp__modal_h3__list_generation_tasks',
  'mcp__openviking__edit', 'mcp__openviking__forget', 'mcp__openviking__glob',
  'mcp__openviking__grep', 'mcp__openviking__health', 'mcp__openviking__list',
  'mcp__openviking__remember', 'mcp__openviking__search', 'mcp__openviking__write',
  'mcp__stitch__apply_design_system', 'mcp__stitch__create_design_system',
  'mcp__stitch__create_design_system_from_design_md', 'mcp__stitch__edit_screens',
  'mcp__stitch__generate_screen_from_text', 'mcp__stitch__generate_variants',
  'mcp__stitch__upload_design_md', 'read_mcp_resource', 'schedule_create',
  'schedule_delete', 'schedule_list', 'schedule_update', 'ssh_download',
  'ssh_list', 'ssh_read', 'ssh_upload', 'subagent_fork', 'workflow',
  'working_directory',
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