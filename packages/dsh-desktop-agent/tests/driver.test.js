import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_PREFIX, mountDriver } from '../src/driver.js';

/** Two catalog entries: one action, one capture. */
const CATALOG = [
  {
    name: 'get_window_state',
    description: 'Capture one window.',
    inputSchema: { type: 'object', properties: { pid: { type: 'integer' } }, required: ['pid'] },
    outputSchema: { type: 'object' },
  },
  {
    name: 'click',
    description: 'Click a point.',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
  },
];

/**
 * A stand-in for the native SDK module.
 *
 * @param options - the catalog to serve and an optional call failure.
 * @returns the module namespace plus the driver handle and its call log.
 */
function sdk(options = {}) {
  const { catalog = CATALOG, callError } = options;
  const log = { calls: [], shutdowns: 0, destroys: 0 };
  const driver = {
    async listToolsJson() {
      return JSON.stringify({ tools: catalog });
    },
    async callTool(name, argsJson) {
      log.calls.push({ name, args: JSON.parse(argsJson) });
      if (callError !== undefined) throw callError;
      return {
        rawJson: JSON.stringify({
          content: [{ type: 'text', text: 'clicked' }],
          structuredContent: { clicked: true },
        }),
      };
    },
    async shutdown() {
      log.shutdowns += 1;
    },
    uniffiDestroy() {
      log.destroys += 1;
    },
  };
  return { module: { CuaDriver: { create: () => driver } }, driver, log };
}

/**
 * A stand-in plugin context.
 *
 * @param options - which optional services exist.
 * @returns the context, the registered definitions, and the recorded effects.
 */
function host(options = {}) {
  const { systemPrompt = true } = options;
  const registered = [];
  const effects = [];
  const warnings = [];
  const sections = [];

  const prompt = {
    getSectionOrder: (kind) => (kind === 'TOOL_COMPUTER_USE' ? 40 : 0),
    section(definition) {
      sections.push(definition);
      return () => {};
    },
  };

  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (definition) => registered.push(definition) };
      if (name === 'systemPrompt') return systemPrompt ? prompt : undefined;
      return undefined;
    },
    effect(fn, label) {
      const disposer = fn();
      effects.push({ label, disposer });
      return async () => {
        if (typeof disposer === 'function') await disposer();
      };
    },
    logger: { warn: (message) => warnings.push(message) },
  };

  return { ctx, registered, effects, warnings, sections };
}

test('the runtime publishes one prefixed tool per catalog entry', async () => {
  const { ctx, registered } = host();
  await mountDriver(ctx, async () => sdk().module);

  assert.deepEqual(registered.map((definition) => definition.name), [
    TOOL_PREFIX + 'get_window_state',
    TOOL_PREFIX + 'click',
  ]);
});

test('a catalog entry\'s input schema becomes the tool\'s parameters', async () => {
  const { ctx, registered } = host();
  await mountDriver(ctx, async () => sdk().module);

  assert.deepEqual(registered[0].parameters, CATALOG[0].inputSchema);
  assert.equal(registered[0].description, 'Capture one window.');
});

test('a call reaches the native driver and returns its canonical result', async () => {
  const { module, log } = sdk();
  const { ctx, registered } = host();
  await mountDriver(ctx, async () => module);

  const value = await registered[1].execute({ x: 3, y: 4 }, { signal: new AbortController().signal });

  assert.deepEqual(log.calls, [{ name: 'click', args: { x: 3, y: 4 } }]);
  assert.deepEqual(value, {
    content: [{ type: 'text', text: 'clicked' }],
    structuredContent: { clicked: true },
  });
});

test('an MCP error result is reported as the call\'s own failure', async () => {
  const failure = sdk({
    catalog: CATALOG,
  });
  failure.driver.callTool = async () => ({
    rawJson: JSON.stringify({ content: [{ type: 'text', text: 'window is gone' }], isError: true }),
  });
  const { ctx, registered } = host();
  await mountDriver(ctx, async () => failure.module);

  await assert.rejects(
    () => registered[0].execute({ pid: 1 }, { signal: new AbortController().signal }),
    /window is gone/,
  );
});

test('the guidance section registers at the computer-use order', async () => {
  const { ctx, sections } = host();
  await mountDriver(ctx, async () => sdk().module);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'computer-use:cua-driver-native');
  assert.equal(sections[0].order, 40);
  assert.match(sections[0].text, /facility_unavailable/u);
});

test('a host without the system prompt service warns instead of throwing', async () => {
  const { ctx, registered, warnings } = host({ systemPrompt: false });
  await mountDriver(ctx, async () => sdk().module);

  assert.equal(registered.length, CATALOG.length, 'the tools still publish');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /guidance was not registered/u);
});

test('unloading aborts the runtime and releases the native handle', async () => {
  const { module, log } = sdk();
  const { ctx } = host();
  const dispose = await mountDriver(ctx, async () => module);

  await dispose();

  assert.equal(log.shutdowns, 1);
  assert.equal(log.destroys, 1);
});

test('a tool name outside the function-name alphabet fails the mount', async () => {
  const { ctx, registered } = host();
  await assert.rejects(
    () => mountDriver(ctx, async () => sdk({ catalog: [{ name: 'a'.repeat(64), inputSchema: {} }] }).module),
    /exceeds the supported function-name format/u,
  );
  assert.equal(registered.length, 0);
});

test('a tool listed twice fails the mount', async () => {
  const { ctx } = host();
  const duplicated = [{ name: 'click', inputSchema: {} }, { name: 'click', inputSchema: {} }];
  await assert.rejects(
    () => mountDriver(ctx, async () => sdk({ catalog: duplicated }).module),
    /more than once/u,
  );
});

test('a catalog that is not a catalog fails the mount', async () => {
  const { ctx } = host();
  const broken = {
    CuaDriver: { create: () => ({ listToolsJson: async () => '{"nope":1}', shutdown: async () => {}, uniffiDestroy: () => {} }) },
  };
  await assert.rejects(() => mountDriver(ctx, async () => broken), /no tool catalog/u);
});

test('a failed mount still releases the native handle', async () => {
  const { module, log } = sdk({ catalog: [{ name: '', inputSchema: {} }] });
  const { ctx } = host();

  await assert.rejects(() => mountDriver(ctx, async () => module), /without a name/u);

  assert.equal(log.shutdowns, 1);
  assert.equal(log.destroys, 1);
});

test('an SDK that cannot be loaded releases nothing and reports the loader\'s failure', async () => {
  const { ctx } = host();
  const failure = new Error("Cannot find package '@trycua/cua-driver'");

  await assert.rejects(() => mountDriver(ctx, async () => { throw failure; }), failure);
});
