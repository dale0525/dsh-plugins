import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOOLSET_NAME,
  collapseToOneLine,
  renderCatalogDescription,
  validateToolset,
} from './registry.mjs';

/** A tool that satisfies the registry's execute requirement. */
const tool = (name) => ({ name, description: `${name} does a thing`, parameters: {}, execute() {} });

/** A well-formed toolset with the given overrides applied last. */
const toolset = (overrides = {}) => ({
  name: 'mobile',
  description: 'Drive a real phone over ADB.',
  tools: [tool('tap'), tool('swipe')],
  ...overrides,
});

/** Assert that `fn` throws with a message containing `fragment`. */
function throwsMatching(fn, fragment) {
  assert.throws(fn, (error) => {
    assert.ok(
      error.message.includes(fragment),
      `expected message to contain ${JSON.stringify(fragment)}, got ${JSON.stringify(error.message)}`,
    );
    return true;
  });
}

test('a well-formed toolset registers', () => {
  assert.doesNotThrow(() => validateToolset(toolset(), []));
});

test('a toolset name must be lowercase-letter-led and match the pattern', () => {
  // The name is a model-facing token it will type back verbatim, so the shape
  // is enforced rather than normalized: silently lowercasing "Mobile" would
  // register a name the plugin's author never wrote down and cannot grep for.
  for (const name of ['Mobile', '2fa', 'has space', '', '-lead', 'a'.repeat(MAX_TOOLSET_NAME + 1)]) {
    throwsMatching(() => validateToolset(toolset({ name }), []), 'name must match');
  }
});

test('a description is required because it is the whole reason the model can pick the toolset', () => {
  throwsMatching(() => validateToolset(toolset({ description: '   ' }), []), 'description must be a non-empty string');
});

test('an empty toolset is rejected — it would advertise a group with nothing in it', () => {
  throwsMatching(() => validateToolset(toolset({ tools: [] }), []), 'tools must be a non-empty array');
});

test('a tool without execute is rejected at registration, not at first call', () => {
  // The failure this stops: a toolset activates, the model calls the tool, and
  // the registry throws on a missing execute — three turns after the mistake.
  throwsMatching(
    () => validateToolset(toolset({ tools: [{ name: 'tap', description: 'x' }] }), []),
    'must declare an execute function',
  );
});

test('the catalog tool name is reserved', () => {
  throwsMatching(
    () => validateToolset(toolset({ tools: [tool('get_tools')] }), []),
    'reserved for the catalog tool',
  );
});

test('a tool name repeated inside one toolset is rejected', () => {
  throwsMatching(
    () => validateToolset(toolset({ tools: [tool('tap'), tool('tap')] }), []),
    'duplicate tool name "tap"',
  );
});

test('a second toolset cannot reuse a name', () => {
  throwsMatching(() => validateToolset(toolset(), [toolset()]), 'is already registered');
});

test('two toolsets cannot claim the same tool name', () => {
  // Cross-toolset uniqueness is what keeps "which one did the model load?"
  // answerable: a name that exists in two groups makes the catalog ambiguous.
  const first = toolset({ name: 'mobile', tools: [tool('tap')] });
  const second = toolset({ name: 'tablet', tools: [tool('tap')] });
  throwsMatching(() => validateToolset(second, [first]), 'already claimed by toolset "mobile"');
});

test('collapseToOneLine folds wrapping prose into one trimmed line', () => {
  assert.equal(collapseToOneLine('  Drive a\n  real phone.\t'), 'Drive a real phone.');
});

test('collapseToOneLine truncates past 200 chars with an ellipsis', () => {
  // The contract is "a catalog line stays at most 200 chars", not "exactly
  // 200": the ellipsis is part of the budget, so a line one char short of the
  // cap is correct. Asserting the exact length would pin an off-by-one that no
  // reader depends on.
  const line = collapseToOneLine('x'.repeat(250));
  assert.ok(line.length <= 200, `expected at most 200 chars, got ${line.length}`);
  assert.ok(line.endsWith('…'));
  assert.equal(collapseToOneLine('y'.repeat(50)), 'y'.repeat(50));
});

test('the catalog states how to load, when it takes effect, and that reloading is safe', () => {
  // These three sentences are behaviour, not advice: a model that reads only
  // the list of names cannot know any of them, and getting the timing wrong
  // (expecting the tool callable in the SAME turn) is the one mistake that
  // makes the whole mechanism look broken.
  const text = renderCatalogDescription([toolset()]);
  assert.match(text, /"toolset": "<name>"/);
  assert.match(text, /next turn/);
  assert.match(text, /no-op/);
});

test('every toolset gets exactly one catalog line carrying its count', () => {
  const text = renderCatalogDescription([
    toolset({ name: 'mobile', tools: [tool('tap'), tool('swipe')] }),
    toolset({ name: 'desk', description: 'One thing.', tools: [tool('click')] }),
  ]);
  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.deepEqual(lines, [
    '- mobile: Drive a real phone over ADB. (2 tools)',
    '- desk: One thing. (1 tool)',
  ]);
});
