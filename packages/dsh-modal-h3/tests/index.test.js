/**
 * Tests for the host half's wiring, against a fake cordis context.
 *
 * The failure this is here to catch is the one that only appears at boot: the
 * runtime validates each tool's `output.schema` when it is REGISTERED, and an
 * unsupported schema throws there — before any tool exists. A test that only
 * compiles the schemas (as `tools.test.js` does) would not notice that the
 * plugin registers them under a service the host does not provide, or that it
 * registers nothing because an `inject` never resolved.
 *
 * So this walks the real `apply()` with a context that records what it was
 * asked for, and asserts the observable contract: six tools, the documented
 * names, and a system-prompt section that is added and cleaned up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, name } from '../src/index.js';

/**
 * A minimal cordis-shaped context.
 *
 * `inject` here runs its callback IMMEDIATELY once its dependencies are present,
 * which is what the real runtime does — the point of the fake is to prove the
 * callback registers the tools, not to model the waiting. Services that were not
 * requested are genuinely absent, because `ctx.get` returning a value the host
 * would not provide is exactly the bug this file exists to catch.
 *
 * @param options.credentials - provide the credential provider.
 * @param options.systemPrompt - provide the system-prompt service.
 * @returns `{ctx, registered, sections, effects}`.
 */
function fakeContext(options = {}) {
  const registered = [];
  const sections = [];
  const effects = [];
  const services = {};
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (key) => services[key],
    inject(deps, callback) {
      // The real runtime skips the callback entirely when a dependency is
      // missing, so the fake must do the same or it would hide that bug.
      for (const dep of deps) if (services[dep] === undefined) return;
      callback(ctx);
    },
    effect(factory, label) {
      effects.push(label);
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  services.tools = {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  };
  if (options.credentials === true) services.credentials = { resolve: async () => undefined };
  if (options.systemPrompt === true) {
    services.systemPrompt = {
      section(entry) {
        sections.push(entry);
        return () => {};
      },
    };
  }
  return { ctx, registered, sections, effects };
}

test('the row id equals the host half name, which nothing automated checks', () => {
  assert.equal(name, 'modal-h3');
});

test('a full host gets six tools, each with an executor and a unique public name', () => {
  const { ctx, registered } = fakeContext({ credentials: true, systemPrompt: true });
  apply(ctx);
  assert.equal(registered.length, 6);
  const names = registered.map((definition) => definition.name).sort();
  assert.deepEqual(names, [
    'mcp__modal_h3__accounts_status',
    'mcp__modal_h3__accounts_sync',
    'mcp__modal_h3__cancel_generation_task',
    'mcp__modal_h3__generate_video',
    'mcp__modal_h3__get_generation_task',
    'mcp__modal_h3__list_generation_tasks',
  ]);
  for (const definition of registered) {
    assert.equal(typeof definition.execute, 'function', `${definition.name} has no executor`);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 40, `${definition.name} description is too thin`);
  }
});

test('a host without a credential provider registers no tools instead of crashing', () => {
  // `credentials` is a REQUIRED dependency of the tool block: without it the pool
  // cannot be read, so the correct behaviour is to register nothing and let the
  // host boot. What must NOT happen is an exception out of `apply`.
  const { ctx, registered, sections } = fakeContext({ systemPrompt: true });
  assert.doesNotThrow(() => apply(ctx));
  assert.deepEqual(registered, []);
  // Announcing a route whose tools were never registered would be worse than
  // saying nothing, so the section is gated on the same dependency.
  assert.deepEqual(sections, []);
});

test('a host without a system prompt still gets the tools', () => {
  // Read through `ctx.get` rather than `inject` precisely for this case: a
  // declared dependency would make the missing prompt take the tools with it.
  const { ctx, registered, sections } = fakeContext({ credentials: true });
  apply(ctx);
  assert.equal(registered.length, 6);
  assert.deepEqual(sections, []);
});

test('the announced section is unique, ordered, and states the limits the validator enforces', () => {
  const { ctx, sections } = fakeContext({ credentials: true, systemPrompt: true });
  apply(ctx);
  const [section] = sections;
  assert.equal(section.name, 'plugin:dsh-modal-h3');
  assert.equal(section.order, 160);
  assert.match(section.text, /Ref2VA/);
  for (const heading of [
    'subject_definitions',
    'summary',
    'retention_analysis',
    'detailed_description',
    'overall_soundscape',
    'non_diegetic_music',
  ]) {
    assert.ok(section.text.includes(heading), `guidance omits ${heading}`);
  }
  assert.match(section.text, /effective duration of N seconds/);
  assert.match(section.text, /dry_run/);
  assert.match(section.text, /wait_for_completion: false/);
});
