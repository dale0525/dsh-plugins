/**
 * Composition test: the plugin's whole tool surface is ONE toolset.
 *
 * What the unit tests cannot state, and this one must: after `apply`, the
 * global tool list holds `get_tools` and NONE of the seventeen
 * `mcp__stitch__*` definitions — and after the agent loads `stitch_design`,
 * they are in that agent's request. That is the entire saving, and it is
 * invisible to any test that inspects a definition in isolation.
 *
 * The host is real (cordis, `dsh-tools`'s ToolRuntime, `dsh-tool-toolsets`,
 * `dsh-system-prompt`). Only the network is stubbed: the Stitch transports are
 * factories over `fetch`, and a live API key is the one dependency a test must
 * not need.
 *
 * @module @logictan/dsh-stitch-designer/tests/toolset
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ToolsetsPlugin from '@logictan/dsh-tool-toolsets';

import { apply, inject, name as pluginName } from '../src/index.js';

const TOOLSET = 'stitch_design';

/**
 * The upstream `tools/list` catalog, reduced to what the bridge reads.
 *
 * `outputSchema` is deliberately unsupported (`$defs`) so the measured drop
 * path is the one exercised.
 */
const UPSTREAM = [
  'create_project', 'get_project', 'delete_project', 'list_projects',
  'list_screens', 'get_screen', 'generate_screen_from_text', 'edit_screens',
  'generate_variants', 'upload_design_md', 'create_design_system',
  'create_design_system_from_design_md', 'update_design_system',
  'list_design_systems', 'apply_design_system', 'download_file',
].map((raw) => ({
  name: raw,
  description: `${raw} from Stitch`,
  inputSchema: { type: 'object', properties: {} },
  outputSchema: { $defs: { X: {} }, type: 'object' },
}));

/**
 * Stub `globalThis.fetch` for the plugin's two transports.
 *
 * @returns a restore function.
 */
function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'tools/list') {
      return { ok: true, json: async () => ({ jsonrpc: '2.0', result: { tools: UPSTREAM } }) };
    }
    return {
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      }),
    };
  };
  return () => {
    globalThis.fetch = original;
  };
}

/** A credentials service whose key is always present. */
const credentials = { resolve: async () => ({ value: 'test-key' }) };

/**
 * Build a host with the plugin mounted, everything real except the network.
 *
 * @returns the mounted context and the fetch restore function.
 */
async function host() {
  const restore = stubFetch();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(ToolsetsPlugin);
  ctx.provide('credentials', credentials);
  // The `inject` above is a module-level declaration, so the plugin VALUE (not a
  // bare apply) is what must be handed to `ctx.plugin` — the same shape the
  // aggregate patch row loads.
  await ctx.plugin({ name: pluginName, inject, apply });
  await waitFor(`the ${TOOLSET} toolset to register`, () => entry(ctx) !== undefined);
  return { ctx, restore };
}

/** The registered toolset, once the boot fetch has completed. */
function entry(ctx) {
  return ctx.toolsets.list().find((candidate) => candidate.name === TOOLSET);
}

/**
 * Poll until `predicate` holds.
 *
 * The toolset is built from an async `tools/list`, so an assertion made right
 * after `ctx.plugin` would race the fetch.
 *
 * @param label - what is being waited for, named in the failure.
 * @param predicate - condition to poll.
 */
async function waitFor(label, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} did not happen within ${timeoutMs}ms`);
}

/** Mint an agent-shaped scope the way `dsh-agent-loop` does. */
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

test('the whole Stitch surface is one toolset, absent from the global list', async (t) => {
  const { ctx, restore } = await host();
  t.after(restore);

  const agent = mintAgent(ctx.toolsets);
  const names = await assembledNames(ctx, agent);

  assert.ok(names.includes('get_tools'), 'the catalog tool must be announced');
  assert.equal(
    names.filter((name) => name.startsWith('mcp__stitch__')).length,
    0,
    'no Stitch schema may cost anything before the toolset is loaded',
  );

  const registered = entry(ctx);
  assert.ok(registered !== undefined, `toolset ${TOOLSET} must be registered`);
  assert.equal(registered.tools.length, 17);
  assert.equal(new Set(registered.tools.map((tool) => tool.name)).size, 17);
  assert.ok(
    registered.tools.some((tool) => tool.name === 'mcp__stitch__remove_screens_from_canvas'),
    'the local canvas tool travels with the group',
  );
});

test("loading the toolset puts the definitions in that agent's request only", async (t) => {
  const { ctx, restore } = await host();
  t.after(restore);

  const loader = mintAgent(ctx.toolsets);
  const bystander = mintAgent(ctx.toolsets);

  const loaded = ctx.toolsets.activate(loader, TOOLSET);
  assert.equal(loaded.alreadyActive, false);
  assert.equal(loaded.tools.length, 17);

  const names = await assembledNames(ctx, loader);
  assert.ok(names.includes('mcp__stitch__generate_screen_from_text'));
  assert.ok(names.includes('mcp__stitch__remove_screens_from_canvas'));
  assert.ok(
    !(await assembledNames(ctx, bystander)).includes('mcp__stitch__generate_screen_from_text'),
    'activation is per-agent, never global',
  );
});

test('a loaded tool executes through the invoicing wrapper, not around it', async (t) => {
  // The `.stitch.json` enforcement is the one behaviour that must not be lost by
  // moving the tools behind a toolset: the wrapper stays the only call path.
  const { ctx, restore } = await host();
  t.after(restore);

  const agent = mintAgent(ctx.toolsets);
  ctx.toolsets.activate(agent, TOOLSET);

  const tool = ctx.tools.get('mcp__stitch__get_project', agent);
  assert.ok(tool !== undefined, 'a loaded tool resolves for its agent');
  const result = await tool.execute(
    { name: 'projects/1' },
    { agent, signal: new AbortController().signal },
  );
  assert.deepEqual(result.content, [{ type: 'text', text: '{"ok":true}' }]);
});

test('a redundant credential update leaves exactly one toolset', async (t) => {
  // What this pins, measured rather than assumed: a second entry into the sync
  // after a successful one must not leave two catalog entries. `toolsets.register`
  // rejects a duplicate NAME outright (`registry.mjs`: "is already registered"),
  // so the outcome that must hold is "one entry, still intact" — reached here via
  // the `disposers.length > 0` guard, which makes the listener a no-op once a
  // toolset exists.
  //
  // Deliberately NOT asserted: that the implementation disposes before
  // re-registering. A probe that removed the guard left exactly one entry as
  // well, so a dispose-before-register step is not what produces this property
  // and claiming it would be a test that documents a mechanism the code does not
  // need.
  const { ctx, restore } = await host();
  t.after(restore);

  const before = entry(ctx);
  assert.ok(before !== undefined, 'the boot sync succeeded');

  ctx.emit('credentials/reference-updated', 'STITCH_API_KEY');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const entries = ctx.toolsets.list().filter((candidate) => candidate.name === TOOLSET);
  assert.equal(entries.length, 1, 'exactly one toolset survives a redundant credential update');
  assert.equal(entries[0].tools.length, 17, 'the surviving toolset is intact');
});


test('a boot fetch that fails still lets a later credential update build the toolset', async (t) => {
  // The gap the first sync's retry covers: on a cold start the credential store
  // may not be live yet, so the ONE boot attempt fails and nothing registers.
  // Setting the key afterwards must build it, or the catalog stays empty for the
  // whole process lifetime.
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (_url, init) => {
    attempts += 1;
    if (attempts === 1) throw new Error('credential store not live yet');
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', result: { tools: UPSTREAM } }) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(ToolsetsPlugin);
  ctx.provide('credentials', credentials);
  await ctx.plugin({ name: pluginName, inject, apply });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(entry(ctx), undefined, 'a failed boot fetch leaves no toolset');

  ctx.emit('credentials/reference-updated', 'STITCH_API_KEY');
  await waitFor('the recovered toolset', () => entry(ctx) !== undefined);

  const entries = ctx.toolsets.list().filter((candidate) => candidate.name === TOOLSET);
  assert.equal(entries.length, 1, 'exactly one toolset after recovery, never two');
  assert.equal(entries[0].tools.length, 17);
});
