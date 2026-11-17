/**
 * Toolset registration against a real host composition: real cordis Context,
 * real `dsh-tools` ToolRuntime, real `dsh-system-prompt` registry, the real
 * `dsh-tool-toolsets` service, and this plugin. Nothing on the load path is
 * mocked.
 *
 * The claim these tests make is the one a unit test on `createToolDefinitions`
 * cannot: the two `mcp__magpie__*` schemas are ABSENT from every request until
 * an agent loads the `magpie_image` toolset, and only `get_tools` is paid.
 *
 * @module @logictan/dsh-magpie-image/tests/toolsets
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ToolsetsPlugin from '@logictan/dsh-tool-toolsets';

import * as plugin from '../src/index.js';
import { TOOLSET_NAME } from '../src/index.js';

const GENERATE = 'mcp__magpie__generate_image';
const RESULT = 'mcp__magpie__generation_result';

/**
 * Build the host: the prompt registry, the tool runtime, the toolset service,
 * and this plugin.
 *
 * `attachments` and `credentials` are provided on the root context because the
 * plugin injects the first and reads the second; neither is touched before a
 * tool body runs, which these tests never reach.
 *
 * @returns {Promise<Context>}
 */
async function host() {
  const ctx = new Context();
  ctx.provide('credentials', { resolve: async () => ({ value: 'test-key' }) });
  ctx.provide('attachments', {
    saveImages: async () => [],
    readImage: async () => ({ path: '/dev/null' }),
  });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(ToolsetsPlugin);
  await ctx.plugin(plugin);
  await waitFor('the magpie_image toolset to register', () => toolsetEntry(ctx) !== undefined);
  return ctx;
}

/** The registered `magpie_image` toolset, if the plugin has finished loading. */
function toolsetEntry(ctx) {
  return ctx.toolsets.list().find((entry) => entry.name === TOOLSET_NAME);
}

/**
 * Poll until `predicate` holds.
 *
 * The plugin registers through a nested `ctx.inject`, whose fiber settles
 * asynchronously after `ctx.plugin(plugin)` resolves, so an assertion made
 * immediately would race the registration.
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

/**
 * Mint an agent-shaped scope the way `dsh-agent-loop` does. The agent object IS
 * the scope key, and minting from the service's own context is what gives its
 * `ctx.tools` the `tools` dependency.
 */
function mintAgent(service) {
  const agent = {};
  const scope = createScope(service.ownCtx, agent);
  agent.ctx = scope.ctx ?? scope;
  return agent;
}

/** Names in one assembled request for one agent. */
async function assembledNames(ctx, agent) {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent });
  return assembly.tools.map((schema) => schema.name);
}

test('the two magpie tools are not global; only the catalog is', async () => {
  const ctx = await host();
  const names = ctx.tools.schemas().map((schema) => schema.name);
  assert.ok(names.includes('get_tools'), 'the toolset catalog must be announced');
  assert.ok(!names.includes(GENERATE), 'generate_image must cost no schema until the toolset is loaded');
  assert.ok(!names.includes(RESULT), 'generation_result must cost no schema until the toolset is loaded');
});

test('the toolset lists both tools, and the request omits them until loaded', async () => {
  const ctx = await host();
  const entry = toolsetEntry(ctx);
  assert.ok(entry, 'magpie_image must be registered as one toolset');
  assert.deepEqual(
    entry.tools.map((tool) => tool.name).sort(),
    [GENERATE, RESULT].sort(),
  );
  assert.match(entry.description, /image/i, 'the toolset needs a model-facing when-to-use line');

  const agent = mintAgent(ctx.toolsets);
  const before = await assembledNames(ctx, agent);
  assert.ok(before.includes('get_tools'));
  assert.ok(!before.includes(GENERATE), 'an unloaded toolset costs no schema');

  ctx.toolsets.activate(agent, TOOLSET_NAME);
  const after = await assembledNames(ctx, agent);
  assert.ok(after.includes(GENERATE), 'a loaded toolset is in the next request');
  assert.ok(after.includes(RESULT), 'a loaded toolset is in the next request');
  assert.ok(
    !ctx.tools.schemas().some((schema) => [GENERATE, RESULT].includes(schema.name)),
    'activation stays in the agent scope and never becomes global',
  );
});