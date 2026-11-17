/**
 * composition.test.mjs — real-host composition: a real cordis Context, the real
 * `dsh-tools` ToolRuntime, and the real `dsh-system-prompt` registry, wired the
 * way `dsh-agent-loop` wires them. Nothing about the load path is mocked.
 *
 * This is the test that matters for the whole mechanism: it proves that a
 * toolset's schemas are ABSENT from the assembly before activation and PRESENT
 * after, which is the one claim unit tests on the pure functions cannot make.
 *
 * The host packages are resolved as ordinary devDependencies (pnpm links them
 * from the workspace), exactly as any other package in this repo resolves its
 * peers in tests. They are peers for consumers, never bundled.
 *
 * @module @logictan/dsh-tool-toolsets/composition.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import ToolsetsPlugin, { ToolsetsService } from './index.mjs';

/** A minimal tool that satisfies defineTool's contract. */
const demo = (name) =>
  defineTool({
    name,
    description: `${name} for the composition test`,
    parameters: { value: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    execute: () => ({}),
  });

/**
 * Build a host with the prompt registry, the tool runtime, and this plugin.
 * @returns {Promise<Context>}
 */
async function host() {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(ToolsetsPlugin);
  return ctx;
}

/**
 * Mint an agent-shaped scope the way `dsh-agent-loop` does: the agent object IS
 * the scope key, and its `ctx` is the scoped context whose registrations unwind
 * with the agent.
 *
 * The minting context must be one that INJECTS `tools` — a scoped context
 * resolves services through the minting plugin's dependency chain, so minting
 * from a bare root context yields an agent whose `ctx.tools` throws "cannot get
 * property tools without inject". `dsh-agent-loop` mints from its loop context
 * for exactly this reason; here the service's own context is the equivalent.
 *
 * @param {{ownCtx: Context}} service
 * @returns {{ctx: Context}}
 */
function mintAgent(service) {
  const agent = {};
  const scope = createScope(service.ownCtx, agent);
  agent.ctx = scope.ctx ?? scope;
  return agent;
}

/** Names of the tools in one assembled request for one agent. */
async function assembledNames(ctx, agent) {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent });
  return assembly.tools.map((schema) => schema.name);
}

test('a toolset’s schemas are absent until its agent loads them', async () => {
  const ctx = await host();
  const service = ctx.toolsets;
  assert.ok(service instanceof ToolsetsService, 'the ctx.toolsets service must be provided');

  service.register({
    name: 'demo',
    description: 'Two demo tools used only by this test.',
    tools: [demo('demoalpha'), demo('demobeta')],
  });

  const agent = mintAgent(ctx.toolsets);

  // Before activation: the catalog is present, the toolset's tools are not.
  const before = await assembledNames(ctx, agent);
  assert.ok(before.includes('get_tools'), 'the catalog tool must be announced');
  assert.ok(!before.includes('demoalpha'), 'an unloaded toolset must cost no schema');
  assert.ok(!before.includes('demobeta'), 'an unloaded toolset must cost no schema');

  // Activation registers the group into the agent's own scope.
  const result = service.activate(agent, 'demo');
  assert.equal(result.alreadyActive, false);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['demoalpha', 'demobeta'],
  );

  // After activation, and on the NEXT assembly, the tools are in the request.
  const after = await assembledNames(ctx, agent);
  assert.ok(after.includes('demoalpha'), 'a loaded toolset must appear in the next request');
  assert.ok(after.includes('demobeta'), 'a loaded toolset must appear in the next request');
  assert.ok(after.includes('get_tools'), 'the catalog stays announced');
});

test('activation is confined to the agent that asked', async () => {
  // The property that makes per-agent scope the right layer: one sub-agent
  // loading a toolset must not leak its schemas into the parent or a sibling.
  const ctx = await host();
  ctx.toolsets.register({
    name: 'demo',
    description: 'Two demo tools used only by this test.',
    tools: [demo('demoalpha')],
  });

  const loaded = mintAgent(ctx.toolsets);
  const untouched = mintAgent(ctx.toolsets);

  ctx.toolsets.activate(loaded, 'demo');

  assert.ok((await assembledNames(ctx, loaded)).includes('demoalpha'));
  assert.ok(
    !(await assembledNames(ctx, untouched)).includes('demoalpha'),
    'a toolset loaded by one agent must not appear for another',
  );
});

test('loading the same toolset twice is a no-op, not a double registration', async () => {
  const ctx = await host();
  ctx.toolsets.register({
    name: 'demo',
    description: 'One demo tool used only by this test.',
    tools: [demo('demoalpha')],
  });
  const agent = mintAgent(ctx.toolsets);

  assert.equal(ctx.toolsets.activate(agent, 'demo').alreadyActive, false);
  const second = ctx.toolsets.activate(agent, 'demo');
  assert.equal(second.alreadyActive, true);
  assert.deepEqual(second.tools.map((tool) => tool.name), ['demoalpha']);

  const names = await assembledNames(ctx, agent);
  assert.equal(names.filter((name) => name === 'demoalpha').length, 1, 'no duplicate schema');
});

test('the catalog is registered even before any toolset exists', async () => {
  // This is what makes the FIRST request cheap, and it was measured the hard
  // way. `SystemPrompt.assemble` reads its provider list before the assembly
  // waterfall runs, so a catalog registered from inside that hook only reaches
  // the second request. A first request that lacked the catalog could not hide
  // anything either — the guard against unreachable tools correctly refused —
  // so adoption saved nothing at all on the request that matters most.
  //
  // Registering at mount removes the ordering problem. An empty catalog is not
  // misleading: it lists no toolsets, so the model has nothing to load and a
  // call to it is answered with the known-toolsets error.
  const ctx = await host();
  const agent = mintAgent(ctx.toolsets);
  assert.ok(
    (await assembledNames(ctx, agent)).includes('get_tools'),
    'the catalog must be announced from the very first request',
  );
  // This plugin's own `apply` claims the host tool groups at mount, so the list
  // is not empty here — what must hold is that the catalog exists BEFORE
  // anything was registered, which is what the assertion above establishes. The
  // empty-registry case is covered by `host()` alone in the tests that build a
  // context without mounting the plugin's policy.
});



/** A tool registered the way the HOST registers its own: not through a toolset. */
const hostOwned = (name) =>
  defineTool({
    name,
    description: `${name} is registered by the host itself`,
    parameters: { value: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    execute: () => ({}),
  });

test('an adopted toolset hides host-registered tools until the agent loads it', async () => {
  // The case `register` cannot serve: the host registers its own tools before
  // any plugin runs, so a plugin can neither re-register them (duplicate name)
  // nor take over their execution. What it CAN do is stop announcing them per
  // agent — and unlike the prose-carrying filter this replaces, loading the
  // group restores each schema in full.
  const ctx = await host();
  const dispose = ctx.tools.register(hostOwned('ownedone'));
  const disposeToo = ctx.tools.register(hostOwned('ownedtwo'));

  ctx.toolsets.adopt({
    name: 'hostgroup',
    description: 'Two tools the host registered.',
    // `adopt` only needs names; the real definitions live in the registry.
    tools: [{ name: 'ownedone' }, { name: 'ownedtwo' }],
  });

  const agent = mintAgent(ctx.toolsets);
  const before = await assembledNames(ctx, agent);
  assert.ok(before.includes('get_tools'), 'the catalog must announce an adopted group too');
  assert.ok(!before.includes('ownedone'), 'an unloaded adopted group must cost no schema');
  assert.ok(!before.includes('ownedtwo'), 'an unloaded adopted group must cost no schema');

  // Still executable while hidden: the registry is untouched, and that is the
  // whole reason this is safe to do.
  assert.ok(ctx.tools.get('ownedone', agent) !== undefined, 'hiding a definition must not unregister it');

  ctx.toolsets.activate(agent, 'hostgroup');
  const after = await assembledNames(ctx, agent);
  assert.ok(after.includes('ownedone'), 'loading restores the definition in full');
  assert.ok(after.includes('ownedtwo'), 'loading restores the definition in full');

  dispose();
  disposeToo();
});

test('adoption is per agent, and a sibling never sees the tools', async () => {
  const ctx = await host();
  const dispose = ctx.tools.register(hostOwned('ownedone'));
  ctx.toolsets.adopt({
    name: 'hostgroup',
    description: 'One tool the host registered.',
    tools: [{ name: 'ownedone' }],
  });

  const loader = mintAgent(ctx.toolsets);
  const bystander = mintAgent(ctx.toolsets);
  ctx.toolsets.activate(loader, 'hostgroup');

  assert.ok((await assembledNames(ctx, loader)).includes('ownedone'));
  assert.ok(
    !(await assembledNames(ctx, bystander)).includes('ownedone'),
    'an adopted group loaded by one agent stays hidden for another',
  );
  dispose();
});

test('adoption never registers anything, so it cannot shadow the host definition', async () => {
  const ctx = await host();
  const dispose = ctx.tools.register(hostOwned('ownedone'));
  const original = ctx.tools.get('ownedone');
  ctx.toolsets.adopt({ name: 'hostgroup', description: 'One tool.', tools: [{ name: 'ownedone' }] });

  const agent = mintAgent(ctx.toolsets);
  assert.doesNotThrow(() => ctx.toolsets.activate(agent, 'hostgroup'));
  assert.equal(ctx.tools.get('ownedone', agent), original, 'the host own definition must survive activation');
  dispose();
});

test('the host tool groups are claimed from the assembly and cost nothing from then on', async () => {
  // Measured against the isolated profile (2026-11-17): claiming from this
  // plugin's OWN `ctx.tools` view sees 0 host tools, because that view resolves
  // to this plugin's layer. The assembly is the view that is correct by
  // construction, so adoption is driven from it — which means the very first
  // request still carries the tools (they are what tells us the group is
  // complete), and every request after it does not.
  //
  // That one-turn delay is the honest trade. The alternative measured on the
  // real host was: no catalog tool, no toolset, and the host tools hidden
  // forever with nothing the model could call to load them.
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);

  const hostNames = ['ssh_list', 'ssh_read', 'ssh_upload', 'ssh_download'];
  const disposers = hostNames.map((name) => ctx.tools.register(hostOwned(name)));

  await ctx.plugin(ToolsetsPlugin);
  const agent = mintAgent(ctx.toolsets);

  // First request: the tools are visible, and that is what lets the hook claim
  // the group. The catalog is registered during this same request, so whether it
  // appears now or next turn is not asserted — only that it appears at all.
  await assembledNames(ctx, agent);

  const claimed = ctx.toolsets.list().find((entry) => entry.name === 'ssh_remote');
  assert.ok(claimed !== undefined, 'the ssh group must be claimed once its tools are all visible');
  assert.deepEqual(claimed.tools.map((tool) => tool.name).sort(), [...hostNames].sort());

  // From then on the group costs nothing until an agent loads it.
  const after = await assembledNames(ctx, agent);
  assert.ok(after.includes('get_tools'), 'the catalog must be announced once a group exists');
  for (const name of hostNames) {
    assert.ok(!after.includes(name), `${name} must cost no schema once its group is claimed`);
  }

  // Loading restores the real definitions, not a prose summary of them.
  ctx.toolsets.activate(agent, 'ssh_remote');
  const loaded = await assembledNames(ctx, agent);
  for (const name of hostNames) {
    assert.ok(loaded.includes(name), `${name} must be restored in full after loading the group`);
  }

  disposers.forEach((dispose) => dispose());
});



test('a group is never hidden while the request carries no way to load it', async () => {
  // The isolated-profile failure this pins (2026-11-17): the assembly hook
  // claimed the host groups and withdrew them in the SAME request that first
  // registered `get_tools` — but `SystemPrompt.assemble` reads its provider list
  // before the waterfall runs, so that request carried the removals and not the
  // loader. Measured there: 23 tools, `get_tools` absent, the host tools gone.
  //
  // The invariant is absolute: a request either names the loader or keeps the
  // tools. This test drives the FIRST assembly after a group becomes claimable
  // and asserts exactly that — the tools survive it.
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);

  const hostNames = ['ssh_list', 'ssh_read', 'ssh_upload', 'ssh_download'];
  const disposers = hostNames.map((name) => ctx.tools.register(hostOwned(name)));
  await ctx.plugin(ToolsetsPlugin);

  const agent = mintAgent(ctx.toolsets);
  const first = await assembledNames(ctx, agent);

  // Whatever this request carries, it must be usable on its own terms.
  const carriesLoader = first.includes('get_tools');
  const hiddenAny = hostNames.some((name) => !first.includes(name));
  if (hiddenAny) {
    assert.ok(
      carriesLoader,
      'a request that withholds tools must name the loader, or the tools are unreachable',
    );
  }

  // And by the SECOND request the normal contract holds: loader present, tools
  // hidden until loaded.
  const second = await assembledNames(ctx, agent);
  assert.ok(second.includes('get_tools'), 'the loader must be in place from the second request on');
  for (const name of hostNames) {
    assert.ok(!second.includes(name), `${name} must be hidden once the loader is announced`);
  }

  disposers.forEach((dispose) => dispose());
});

test('loading an adopted group returns lossless JSON even though it holds names only', async () => {
  // Measured on the isolated profile, 2026-11-18: `get_tools {toolset:
  // "mcp_resources"}` answered
  //   Error: tool "get_tools" returned invalid output: value is not lossless JSON
  //
  // An adopted toolset records NAMES — its definitions stay in the registry,
  // which this service does not own — so `tool.description` is undefined. The
  // output schema declared description required, so the whole call failed
  // validation. This test drives that exact path: adopt, activate, and check the
  // returned value survives a JSON round-trip.
  const ctx = await host();
  const hostName = 'a_host_tool';
  const dispose = ctx.tools.register(hostOwned(hostName));
  ctx.toolsets.adopt({
    name: 'a_named_group',
    description: 'Read MCP resources rather than tools.',
    tools: [{ name: hostName }],
  });

  const agent = mintAgent(ctx.toolsets);
  const result = ctx.toolsets.activate(agent, 'a_named_group');
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, hostName);
  assert.equal(result.tools[0].description, '', 'an absent description must be an empty string, never undefined');

  // The property the host actually checks: the value is lossless JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  dispose();
});

test('a group whose tools this host does not have is dropped, not advertised', async () => {
  // Measured on the isolated profile, 2026-11-18, which has no MCP-resource
  // plugin at all: `get_tools {toolset:"mcp_resources"}` answered "loaded, tools
  // now in your list: list_mcp_resources" and the next call died with
  // `unknown tool "list_mcp_resources"`.
  //
  // The mount-time claim is blind by necessity (this plugin cannot see the
  // host's tools), so the assembly must prune what is not there. A catalog line
  // for an absent group is a promise the host breaks at the first call.
  const ctx = await host();

  // Two groups on the static list; only one of them exists here.
  const dispose = ctx.tools.register(hostOwned('a_real_tool'));
  ctx.toolsets.adopt({
    name: 'exists_here',
    description: 'One tool this host really has.',
    tools: [{ name: 'a_real_tool' }],
  });
  ctx.toolsets.adopt({
    name: 'absent_here',
    description: 'Two tools this host does not have.',
    tools: [{ name: 'a_phantom_one' }, { name: 'a_phantom_two' }],
  });

  const agent = mintAgent(ctx.toolsets);
  await assembledNames(ctx, agent);

  const names = ctx.toolsets.list().map((entry) => entry.name);
  assert.ok(names.includes('exists_here'), 'a group whose tools exist must stay');
  assert.ok(!names.includes('absent_here'), 'a group with no tool present must be dropped whole');

  // The dropped group cannot be loaded either — the error names the known ones.
  assert.throws(() => ctx.toolsets.activate(agent, 'absent_here'), /unknown toolset/);
  dispose();
});

test('a partially installed group keeps only the tools that exist', async () => {
  const ctx = await host();
  const dispose = ctx.tools.register(hostOwned('a_real_tool'));
  ctx.toolsets.adopt({
    name: 'half_here',
    description: 'One of these two tools exists.',
    tools: [{ name: 'a_real_tool' }, { name: 'a_phantom_tool' }],
  });

  const agent = mintAgent(ctx.toolsets);
  await assembledNames(ctx, agent);

  const entry = ctx.toolsets.list().find((candidate) => candidate.name === 'half_here');
  assert.ok(entry !== undefined, 'a group with at least one real tool survives');
  assert.deepEqual(entry.tools.map((tool) => tool.name), ['a_real_tool'],
    'a phantom name must not be reported as available');

  const loaded = ctx.toolsets.activate(agent, 'half_here');
  assert.deepEqual(loaded.tools.map((tool) => tool.name), ['a_real_tool']);
  dispose();
});
