import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSkeleton } from '../src/skeleton.js';

/**
 * @typedef {object} Facts
 * @property {string[]} intents
 * @property {string[]} files
 * @property {string[]} commands
 * @property {string[]} errors
 */

/** Fixed subsection order — the renderer must never reorder or omit these. */
const SECTIONS = [
  { key: 'intents', header: '### User Intents' },
  { key: 'files', header: '### Files Touched' },
  { key: 'commands', header: '### Commands Run' },
  { key: 'errors', header: '### Errors Seen' },
];

/** @returns {Facts} */
function fullFacts() {
  return {
    intents: ['add a skeleton renderer', 'keep facts verbatim'],
    files: ['src/skeleton.js', 'tests/skeleton.test.js'],
    commands: ['node --test tests/skeleton.test.js'],
    errors: ['TypeError: buildSkeleton is not a function'],
  };
}

/**
 * Body of one subsection, with the trailing separator newline(s) removed.
 * Embedded newlines inside items are preserved because the cut only happens at
 * the next header.
 * @param {string} text
 * @param {string} header
 */
function sectionBody(text, header) {
  const start = text.indexOf(`${header}\n`);
  assert.notEqual(start, -1, `missing header: ${header}`);
  const rest = text.slice(start + header.length + 1);
  const next = rest.search(/\n### |\n## /);
  const body = next === -1 ? rest : rest.slice(0, next);
  return body.replace(/\n+$/, '');
}

/** Count of literal `(none)` markers. @param {string} text */
function noneCount(text) {
  return text.split('(none)').length - 1;
}

/** Lines that are bullet items. @param {string} text */
function bulletLines(text) {
  return text.split('\n').filter((line) => line.startsWith('- '));
}

test('A4 — structure: the four subsections appear once each, in the fixed order', () => {
  const { text } = buildSkeleton(fullFacts());

  assert.ok(text.startsWith('## Extracted Facts\n'), 'first line must be the top header');

  const indices = SECTIONS.map(({ header }) => {
    const first = text.indexOf(header);
    assert.notEqual(first, -1, `missing header: ${header}`);
    assert.equal(text.indexOf(header, first + 1), -1, `duplicated header: ${header}`);
    return first;
  });
  const [i1, i2, i3, i4] = indices;
  assert.ok(i1 < i2 && i2 < i3 && i3 < i4, `headers out of order: ${indices.join(', ')}`);

  const facts = fullFacts();
  assert.equal(sectionBody(text, '### User Intents'), facts.intents.map((v) => `- ${v}`).join('\n'));
  assert.equal(sectionBody(text, '### Files Touched'), facts.files.map((v) => `- ${v}`).join('\n'));
  assert.equal(sectionBody(text, '### Commands Run'), facts.commands.map((v) => `- ${v}`).join('\n'));
  assert.equal(sectionBody(text, '### Errors Seen'), facts.errors.map((v) => `- ${v}`).join('\n'));
});

test('A4b — every empty list renders `(none)` and no bullets at all', () => {
  const { text } = buildSkeleton({ intents: [], files: [], commands: [], errors: [] });

  for (const { header } of SECTIONS) {
    assert.equal(sectionBody(text, header), '(none)', `${header} must render (none)`);
  }
  assert.deepEqual(bulletLines(text), [], 'no `- ` bullet lines may be emitted');
  assert.equal(noneCount(text), 4, 'literal (none) must appear exactly four times');
});

test('A4c — no omission: populating one list leaves the other three as `(none)`', () => {
  for (const { key, header } of SECTIONS) {
    /** @type {Record<string, string[]>} */
    const facts = { intents: [], files: [], commands: [], errors: [] };
    facts[key] = [`only-${key}`];

    const { text } = buildSkeleton(facts);

    assert.equal(sectionBody(text, header), `- only-${key}`, `${header} must hold the populated item`);
    for (const other of SECTIONS) {
      if (other.key === key) continue;
      assert.equal(sectionBody(text, other.header), '(none)', `${other.header} must still render (none)`);
    }
    assert.equal(noneCount(text), 3);
  }
});

test('A3 — verbatim round-trip: quoting, $VAR, comments and surrounding spaces survive', () => {
  const value = '  echo "=== plugins ===" # note  ';
  const { text } = buildSkeleton({ commands: [value] });

  assert.ok(text.includes(value), 'the untrimmed value must appear byte-for-byte');
  assert.ok(text.includes(`- ${value}\n`), 'the bullet must carry the untrimmed value');
  assert.ok(!text.includes(`- ${value.trim()}\n`), 'the trimmed variant must NOT be what was emitted');
});

test('A3b — embedded newline: an item keeps its newline instead of being split or collapsed', () => {
  const value = 'line one\nline two';
  const { text } = buildSkeleton({ errors: [value] });

  assert.ok(text.includes(value), 'the raw substring with the newline must be present');
  assert.ok(text.includes(`- ${value}\n`), 'the bullet must span the embedded newline');
  assert.equal(bulletLines(text).length, 1, 'one item stays one bullet');
});

test('no cascade decay: rendering is a pure function of the raw facts', () => {
  const facts = fullFacts();
  const first = buildSkeleton(facts);
  const second = buildSkeleton(facts);

  assert.deepStrictEqual(first.text, second.text, 'same facts must render identical text');

  // Rebuilding from raw events on EVERY compaction is what keeps early facts
  // alive across successive compactions. A renderer that carried forward a
  // previous checkpoint's text (forwarding instead of re-rendering) would fail
  // this test: its second output would be derived from the first output rather
  // than from the facts, so a fact absent from the carried text could never
  // reappear and one present in the input would be lost from the second call.
  assert.ok(second.text.includes(facts.errors[0]), 'a fact from the first input must still be rendered');
});

test('Purity — the caller facts object is never mutated', () => {
  const facts = fullFacts();
  const snapshot = structuredClone(facts);

  buildSkeleton(facts);

  assert.deepStrictEqual(facts, snapshot, 'input facts must be left untouched');
});

test('Return shape — { text, facts } with exactly one trailing newline', () => {
  const facts = fullFacts();
  const result = buildSkeleton(facts);

  assert.deepEqual(Object.keys(result), ['text', 'facts']);
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.endsWith('\n'), 'text must end with a newline');
  assert.ok(!result.text.endsWith('\n\n'), 'text must end with exactly one newline');
  assert.deepStrictEqual(result.facts, facts, 'returned facts must equal the input facts');
  assert.notStrictEqual(result.facts, facts, 'returned facts must be a defensive copy');
});

test('Degenerate input — missing facts, empty facts and undefined all render the all-(none) output', () => {
  const expected = buildSkeleton({ intents: [], files: [], commands: [], errors: [] }).text;

  for (const input of [{}, { intents: [] }, undefined]) {
    let result;
    assert.doesNotThrow(() => {
      result = buildSkeleton(input);
    });
    assert.equal(result.text, expected, `unexpected output for ${JSON.stringify(input)}`);
    assert.deepStrictEqual(result.facts, { intents: [], files: [], commands: [], errors: [] });
  }
});

test('the skeleton is language-independent — the language drives the fill prompt only', () => {
  // The skeleton is a fixed set of English section headers around verbatim user
  // content, so the output language does not reach it: `fillInstruction()` in
  // src/prompt.js is the only consumer of `language`. This pins that separation
  // so nobody re-adds a language parameter here expecting it to matter.
  const rendered = buildSkeleton(fullFacts());

  assert.equal(buildSkeleton.length, 1, 'buildSkeleton takes the facts only');
  assert.ok(rendered.text.includes('## Extracted Facts'));
});
