/**
 * Tests for the causal-section normalizer.
 *
 * A checkpoint whose structure depends on the model's mood is not a checkpoint.
 * These pin the property that the four sections exist, in order, with `(none)`
 * for empties, no matter how the model shaped its answer (A4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCausal, CAUSAL_SECTIONS } from '../src/causal.js';

/** Index of each section heading in a text, in document order. */
function headingOrder(text) {
  return CAUSAL_SECTIONS.map((heading) => text.indexOf(heading));
}

test('A4 — a well-formed answer passes through with all four sections in order', () => {
  const text = normalizeCausal(
    [
      '## Why This Approach',
      '- because it is cheap',
      '',
      '## Errors and Their Causes',
      '- the port was taken',
      '',
      '## Open Decisions',
      '- which profile to use',
      '',
      '## Next Step',
      '- run the tests',
    ].join('\n'),
  );

  const order = headingOrder(text);
  assert.ok(order.every((index) => index >= 0), 'every section is present');
  assert.ok(
    order[0] < order[1] && order[1] < order[2] && order[2] < order[3],
    'sections appear in the fixed order',
  );
  assert.ok(text.includes('- because it is cheap'));
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
})

test('A4b — a missing section is re-established as (none), never dropped', () => {
  const text = normalizeCausal('## Why This Approach\n- only this one\n');

  for (const heading of CAUSAL_SECTIONS) {
    assert.ok(text.includes(heading), `missing ${heading}`);
  }
  assert.equal(text.split('(none)').length - 1, 3, 'the three absent sections render (none)');
})

test('A4c — empty model output still yields the full structure', () => {
  for (const raw of ['', '   ', 'no headings at all', undefined, null]) {
    const text = normalizeCausal(raw);
    for (const heading of CAUSAL_SECTIONS) assert.ok(text.includes(heading), `missing ${heading}`);
    assert.equal(text.split('(none)').length - 1, 4, 'all four sections are empty');
  }
})

test('A4d — a restated fact skeleton is dropped, not duplicated', () => {
  // The model was told not to restate the facts; when it does anyway, the
  // program-owned facts must not appear twice in the checkpoint.
  const text = normalizeCausal(
    [
      '## Extracted Facts',
      '### Files Touched',
      '- /repo/should-not-appear.txt',
      '',
      '## Why This Approach',
      '- the real answer',
    ].join('\n'),
  );

  assert.ok(!text.includes('should-not-appear'), 'pre-heading prose is discarded');
  assert.ok(!text.includes('## Extracted Facts'));
  assert.ok(text.includes('- the real answer'));
})

test('A4e — an invented heading ends the section instead of leaking into it', () => {
  const text = normalizeCausal(
    ['## Why This Approach', '- real reason', '## Some Other Thing', '- stray text'].join('\n'),
  );

  const why = text.slice(text.indexOf('## Why This Approach'), text.indexOf('## Errors and Their Causes'));
  assert.ok(why.includes('- real reason'));
  assert.ok(!why.includes('stray text'), 'text under an invented heading must not leak upward');
})

test('A4f — a code fence around the answer is unwrapped', () => {
  const text = normalizeCausal('```markdown\n## Why This Approach\n- fenced\n```\n');

  assert.ok(!text.includes('```'), 'the fence must not survive into the checkpoint');
  assert.ok(text.includes('- fenced'));
})

test('A4g — the model prose inside a section is preserved verbatim', () => {
  const prose = '- kept   spacing, `code`, and "quotes" exactly';
  const text = normalizeCausal(`## Next Step\n${prose}\n`);

  assert.ok(text.includes(prose), 'the normalizer must not rewrite what the model said');
})

test('A4h — a trailing colon on a heading is tolerated', () => {
  const text = normalizeCausal('## Next Step:\n- go\n');

  assert.ok(text.includes('## Next Step\n- go'), 'the colon is normalized away');
  assert.equal(text.split('(none)').length - 1, 3);
})

test('A4i — normalization is idempotent', () => {
  const once = normalizeCausal('## Why This Approach\n- a\n## Next Step\n- b\n');
  const twice = normalizeCausal(once);

  assert.equal(twice, once, 're-normalizing a normalized checkpoint changes nothing');
})
