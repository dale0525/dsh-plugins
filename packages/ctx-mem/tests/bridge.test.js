/**
 * Tests for the host-plane `ctx-mem` bridge (slice S1).
 *
 * Group 1 pins the pure functions: preset-id extraction, the injected patch
 * list, and the in-place `applyBridge` decision (identity preserved, no write
 * on a non-covered preset).
 *
 * Group 2 is the real-composition contract: the shipped `standard`/`ptc`/
 * `cordis` presets are parsed with the loader's own YAML dialect and run
 * through the include package's real `applyEntryPatches`, so an upstream change
 * to the preset structure turns these red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import plugin, {
  COVERED_PRESETS,
  applyBridge,
  buildPatches,
  name,
  onInternalConfig,
  presetIdFromPath,
} from '../src/bridge.js';
import { SETTINGS_NAMESPACE, SettingsSection } from '../src/config.js';

/* ------------------------------------------------------------------ helpers */

const require = createRequire(import.meta.url);
const PRESETS_ROOT = join(
  dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json')),
  'presets',
);

/** Parse a shipped preset with the loader's own entry-list dialect. */
async function loadPreset(id) {
  const text = await readFile(join(PRESETS_ROOT, id, 'agent.cordis.yml'), 'utf8');
  return yaml.load(text, { schema: entryListSchema });
}

/** Find a row by id, searching the top level and one level into every group. */
function findRow(entries, id) {
  for (const entry of entries) {
    if (entry.id === id) return entry;
    if (entry.group && Array.isArray(entry.config)) {
      const nested = findRow(entry.config, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Drive plugin.apply with a fake context and record both seams.
 *
 * inject is resolved synchronously so the registered body runs against a fake
 * settings service: the test observes exactly what installSection was handed
 * without a real settings provider in the process.
 * @param {Record<string, unknown>} [engine] the bridge row's config.engine.
 * @returns {{ctx: object, events: unknown[][], installs: unknown[][]}}
 */
function applyBridgePlugin(engine) {
  const events = [];
  const installs = [];
  const settingsCtx = { settings: { installSection: (...args) => installs.push(args) } };
  const ctx = {
    on: (...args) => events.push(args),
    inject: (services, body) => {
      assert.deepEqual(services, ['settings']);
      body(settingsCtx);
    },
  };
  plugin.apply(ctx, engine === undefined ? undefined : { engine });
  return { ctx, events, installs };
}

/* ------------------------------------------------------------------ group 1 */

test('presetIdFromPath resolves every covered preset id from a file URL', () => {
  for (const id of ['standard', 'ptc', 'cordis', 'minimal']) {
    assert.equal(presetIdFromPath(`file:///Users/x/.dsh/presets/${id}/agent.cordis.yml`), id);
  }
});

test('presetIdFromPath accepts a plain absolute path', () => {
  assert.equal(presetIdFromPath('/a/b/ptc/agent.cordis.yml'), 'ptc');
});

test('presetIdFromPath returns null for the profile-plane composition', () => {
  assert.equal(presetIdFromPath('file:///Users/x/.dsh/cordis.yml'), null);
  assert.equal(presetIdFromPath('/Users/x/.dsh/cordis.yml'), null);
});

test('presetIdFromPath returns null for non-strings', () => {
  assert.equal(presetIdFromPath(undefined), null);
  assert.equal(presetIdFromPath(null), null);
  assert.equal(presetIdFromPath(42), null);
});

test('presetIdFromPath returns null (never throws) for a malformed file URL', () => {
  assert.equal(presetIdFromPath('file:///a/%/agent.cordis.yml'), null);
});

test('presetIdFromPath is not special-cased when there is no preset directory', () => {
  assert.equal(presetIdFromPath('file:///x/agent.cordis.yml'), 'x');
});

test('buildPatches returns the exact patch list', () => {
  assert.deepEqual(buildPatches(), [
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
    { id: 'compaction', insert: [{ id: 'ctx-mem', name: '@logictan/dsh-ctx-mem' }] },
  ]);
});

test('buildPatches returns a fresh, unshared tree on every call', () => {
  const first = buildPatches();
  const second = buildPatches();
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[1], second[1]);
  assert.notEqual(first[1].insert, second[1].insert);
  assert.notEqual(first[1].insert[0], second[1].insert[0]);

  first[0].disabled = false;
  first[1].insert.push({ id: 'mutant' });
  first[1].insert[0].id = 'mutant';

  assert.deepEqual(second, [
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
    { id: 'compaction', insert: [{ id: 'ctx-mem', name: '@logictan/dsh-ctx-mem' }] },
  ]);
});

test('applyBridge patches a covered preset in place and preserves identity', () => {
  const input = { path: 'file:///Users/x/.dsh/presets/standard/agent.cordis.yml' };
  const result = applyBridge(input);
  assert.equal(result.patched, true);
  assert.equal(result.config, input);
  assert.deepEqual(input.patches, buildPatches());
});

test('applyBridge leaves an uncovered preset untouched', () => {
  const input = { path: 'file:///Users/x/.dsh/presets/minimal/agent.cordis.yml' };
  const result = applyBridge(input);
  assert.equal(result.patched, false);
  assert.equal(result.config, input);
  assert.ok(!('patches' in input));
});

test('applyBridge leaves a profile-plane composition untouched', () => {
  const input = { path: 'file:///Users/x/.dsh/cordis.yml' };
  const result = applyBridge(input);
  assert.equal(result.patched, false);
  assert.equal(result.config, input);
  assert.ok(!('patches' in input));
});

test('applyBridge is idempotent when a top-level ctx-mem row is already present', () => {
  const patches = [{ id: 'ctx-mem', name: '@logictan/dsh-ctx-mem' }];
  const input = { path: 'file:///Users/x/.dsh/presets/ptc/agent.cordis.yml', patches };
  const result = applyBridge(input);
  assert.equal(result.patched, false);
  assert.equal(result.config, input);
  assert.equal(input.patches, patches);
  assert.deepEqual(input.patches, [{ id: 'ctx-mem', name: '@logictan/dsh-ctx-mem' }]);
});

test('applyBridge is idempotent when ctx-mem is nested inside an insert', () => {
  const patches = [{ id: 'compaction', insert: [{ id: 'ctx-mem', name: '@logictan/dsh-ctx-mem' }] }];
  const input = { path: 'file:///Users/x/.dsh/presets/cordis/agent.cordis.yml', patches };
  const result = applyBridge(input);
  assert.equal(result.patched, false);
  assert.equal(result.config, input);
  assert.equal(input.patches, patches);
});

test('applyBridge appends to a pre-existing patch list instead of replacing it', () => {
  const foreign = { id: 'someone-elses-row', disabled: true };
  const input = {
    path: 'file:///Users/x/.dsh/presets/standard/agent.cordis.yml',
    patches: [foreign],
  };
  const result = applyBridge(input);
  assert.equal(result.patched, true);
  assert.equal(result.config, input);
  assert.deepEqual(input.patches, [foreign, ...buildPatches()]);
});

test('applyBridge tolerates null and undefined configs', () => {
  assert.deepEqual(applyBridge(null), { config: null, patched: false });
  assert.deepEqual(applyBridge(undefined), { config: undefined, patched: false });
});

test('onInternalConfig patches the object returned by next()', () => {
  const input = { path: 'file:///Users/x/.dsh/presets/standard/agent.cordis.yml' };
  let calls = 0;
  const out = onInternalConfig(input, () => {
    calls += 1;
    return input;
  });
  assert.equal(calls, 1);
  assert.equal(out, input);
  assert.deepEqual(input.patches, buildPatches());
});

test('onInternalConfig returns a non-object next() result unchanged', () => {
  assert.equal(onInternalConfig(null, () => undefined), undefined);
});

test('plugin registers the global internal/config waterfall', () => {
  assert.equal(name, 'ctx-mem-bridge');
  assert.equal(plugin.name, name);
  const { events } = applyBridgePlugin();
  assert.equal(events.length, 1);
  const [event, listener, options] = events[0];
  assert.equal(event, 'internal/config');
  assert.equal(typeof listener, 'function');
  assert.deepEqual(options, { global: true });

  // The registered listener must still patch through to the same decision.
  const input = { path: 'file:///Users/x/.dsh/presets/standard/agent.cordis.yml' };
  assert.equal(listener(input, () => input), input);
  assert.deepEqual(input.patches, buildPatches());
});

test('A17: the bridge row config is forwarded onto the injected ctx-mem row', () => {
  const { events } = applyBridgePlugin({ fillModel: 'deepseek-v4.1-flash' });
  const listener = events[0][1];
  const input = { path: 'file:///Users/x/.dsh/presets/standard/agent.cordis.yml' };
  listener(input, () => input);
  const injected = input.patches[1].insert[0];
  assert.deepEqual(injected.config, { fillModel: 'deepseek-v4.1-flash' });
});

test('A17: the settings namespace is registered exactly once, on the bridge row', () => {
  // The bridge covers three presets and every mount runs the waterfall again,
  // but settings.register fails loud on a second registration of one namespace
  // -- so the registration must belong to the profile-plane bridge fiber, which
  // is mounted once per process, and not to the engine row the bridge injects.
  const { ctx, installs } = applyBridgePlugin({ fillModel: 'deepseek-v4.1-flash' });
  assert.equal(installs.length, 1);

  const [owner, ns, schema, base, hooks] = installs[0];
  assert.equal(owner, ctx, 'the namespace must be owned by the bridge fiber');
  assert.equal(ns, SETTINGS_NAMESPACE);
  assert.equal(schema, SettingsSection);
  assert.deepEqual(base, {}, 'an engine config without the knob contributes no base value');
  assert.equal(typeof hooks.setSource, 'function');
  assert.equal(typeof hooks.onChange, 'function');
});

test('A17: the composition base is the knob the bridge row already carries', () => {
  const { installs } = applyBridgePlugin({ maxCheckpointTokens: 3000, fillModel: 'x' });
  assert.deepEqual(installs[0][3], { maxCheckpointTokens: 3000 });
});

test('A17: the resolved settings section drives the injected row config', () => {
  const { events, installs } = applyBridgePlugin({ fillModel: 'deepseek-v4.1-flash' });
  const listener = events[0][1];
  const inject = (extra) => {
    const input = { path: 'file:///Users/x/.dsh/presets/standard/agent.cordis.yml', ...extra };
    listener(input, () => input);
    return input.patches[1].insert[0].config;
  };

  // Before the settings service resolves, the row's own engine config stands.
  assert.deepEqual(inject(), { fillModel: 'deepseek-v4.1-flash' });

  // After installSection hands over its source, the section wins the knob while
  // the row config keeps supplying everything the section does not own.
  installs[0][4].setSource(() => ({ maxCheckpointTokens: 12345 }));
  assert.deepEqual(inject(), { fillModel: 'deepseek-v4.1-flash', maxCheckpointTokens: 12345 });
});

test('A17: an absent or empty engine config adds no config key to the injected row', () => {
  for (const engine of [undefined, {}, null]) {
    const patches = buildPatches(engine);
    assert.ok(!('config' in patches[1].insert[0]), `engine=${JSON.stringify(engine)} must add no config`);
  }
  // A non-empty engine config must not be shared with the caller's object.
  const engine = { fillModel: 'x' };
  const patches = buildPatches(engine);
  assert.notEqual(patches[1].insert[0].config, engine);
});

test('COVERED_PRESETS covers the three compaction-bearing presets', () => {
  assert.deepEqual([...COVERED_PRESETS].sort(), ['cordis', 'ptc', 'standard']);
});

/* ------------------------------------------------------------------ group 2 */

for (const id of ['standard', 'ptc', 'cordis']) {
  test(`A15 ${id}: the bridge patch list applies cleanly to the shipped composition`, async () => {
    const data = await loadPreset(id);
    const warnings = [];
    const out = applyEntryPatches(data, buildPatches(), (...args) => warnings.push(args));
    assert.deepEqual(warnings, []);

    const basic = findRow(out, 'compaction-basic');
    assert.ok(basic, `${id} must contain a compaction-basic row`);
    assert.equal(basic.disabled, true);

    const group = findRow(out, 'compaction');
    assert.ok(Array.isArray(group?.config), `${id} compaction row must be a group with a config list`);
    const inserted = group.config.find((row) => row.id === 'ctx-mem');
    assert.ok(inserted, `${id} compaction group must gain a ctx-mem row`);
    assert.equal(inserted.name, '@logictan/dsh-ctx-mem');
  });
}

test('A16 minimal: the bridge patch list changes nothing', async () => {
  const original = await loadPreset('minimal');
  const warnings = [];
  const out = applyEntryPatches(original, buildPatches(), (...args) => warnings.push(args));
  assert.deepEqual(out, original);
});
