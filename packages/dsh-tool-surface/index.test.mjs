import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, name } from './index.mjs';
import { DEFAULT_GUIDANCE, SECTION_NAME } from './guidance.mjs';
import { DEFAULT_KEEP, filterAnnounced } from './surface.mjs';

/** A cordis-shaped context covering exactly the seams this plugin touches. */
function harness(options = {}) {
  const listeners = new Map();
  const sections = [];
  const systemPrompt =
    options.systemPrompt === false
      ? undefined
      : { section: (section) => (sections.push(section), () => {}) };
  const ctx = {
    get: (service) => (service === 'systemPrompt' ? systemPrompt : undefined),
    effect: (factory) => factory(),
    on: (event, handler) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
    logger: { info() {}, warn() {} },
  };
  apply(ctx, options.config);
  return { listeners, sections };
}

/** Run one assembly waterfall, whose listener takes (assembly, context, next). */
async function assemble(listeners, assembly) {
  const handlers = listeners.get('system-prompt/assemble');
  assert.ok(handlers, 'no listener registered for system-prompt/assemble');
  const dispatch = (index) =>
    index >= handlers.length ? assembly : handlers[index](assembly, {}, () => dispatch(index + 1));
  return dispatch(0);
}

test('the row id matches the patch row this plugin ships', () => {
  assert.equal(name, 'tool-surface');
});

test('the guidance section is registered with interpolation off', () => {
  const { sections } = harness();
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, SECTION_NAME);
  assert.equal(sections[0].interpolate, false, 'literal {{...}} would throw at assembly');
  assert.equal(sections[0].text, DEFAULT_GUIDANCE);
});

test('an empty guidance injects no section', () => {
  const { sections } = harness({ config: { guidance: '' } });
  assert.equal(sections.length, 0);
});

test('a missing systemPrompt service still filters', async () => {
  const { listeners, sections } = harness({ systemPrompt: false });
  assert.equal(sections.length, 0);
  const assembly = { sections: [], contexts: [], tools: [{ name: 'ssh_read', parameters: {} }], variables: {} };
  const assembled = await assemble(listeners, assembly);
  assert.deepEqual(assembled.tools, [], 'the filter must not be lost with the prompt service');
});

test('the hook leaves exactly the whitelist in the assembly', async () => {
  const { listeners } = harness();
  const tools = [
    ...DEFAULT_KEEP.map((toolName) => ({ name: toolName, parameters: {} })),
    { name: 'ssh_read', parameters: {} },
    { name: 'mcp__stitch__list_projects', parameters: {} },
    { name: 'mcp__modal_h3__generate_video', parameters: {} },
  ];
  const assembly = { sections: [], contexts: [], tools, variables: {} };
  const assembled = await assemble(listeners, assembly);
  assert.deepEqual(assembled.tools.map((tool) => tool.name), DEFAULT_KEEP);
  // The rest of the assembly is passed through untouched: this hook owns the
  // tool list and nothing else.
  assert.equal(assembled.sections, assembly.sections);
  assert.equal(assembled.variables, assembly.variables);
});

test('an assembly with nothing to withdraw is returned as-is', async () => {
  const { listeners } = harness();
  const assembly = { sections: [], contexts: [], tools: [{ name: 'bash', parameters: {} }], variables: {} };
  assert.equal(await assemble(listeners, assembly), assembly);
});

test('a configured whitelist replaces the default', async () => {
  const { listeners } = harness({ config: { keep: ['bash', 'ssh_read'] } });
  const assembly = {
    sections: [], contexts: [], variables: {},
    tools: ['bash', 'read', 'ssh_read'].map((toolName) => ({ name: toolName, parameters: {} })),
  };
  const assembled = await assemble(listeners, assembly);
  assert.deepEqual(assembled.tools.map((tool) => tool.name), ['bash', 'ssh_read']);
});

test('a guidance string replacing the default is used verbatim', () => {
  const { sections } = harness({ config: { guidance: 'custom prose' } });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].text, 'custom prose');
});

test('a definition without a name survives the filter', () => {
  const anonymous = { description: '', parameters: {} };
  assert.deepEqual(filterAnnounced([anonymous, { name: 'ssh_read' }]), [anonymous]);
});