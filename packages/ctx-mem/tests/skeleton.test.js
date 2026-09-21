import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSkeleton } from '../src/skeleton.js';

/**
 * @typedef {object} Facts
 * @property {string[]} intents
 * @property {string[]} contexts
 * @property {string[]} files
 * @property {string[]} commands
 * @property {string[]} errors
 */

/**
 * Fixed subsection order — the renderer must never reorder or omit these.
 *
 * Errors precede commands because an error cannot be re-derived from anything
 * else in the checkpoint, while a command is reflected in the file list; the
 * budget gives commands away first for the same reason.
 */
const SECTIONS = [
  { key: 'intents', header: '### User Intents' },
  { key: 'files', header: '### Files Touched' },
  { key: 'errors', header: '### Errors Seen' },
  { key: 'commands', header: '### Commands Run' },
];

/** @returns {Facts} */
function fullFacts() {
  return {
    intents: ['add a skeleton renderer', 'keep facts verbatim'],
    contexts: [],
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
    const facts = { intents: [], contexts: [], files: [], commands: [], errors: [] };
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

test('A3b — embedded newline: an item keeps its newline and indents the continuation', () => {
  const value = 'line one\nline two';
  const { text } = buildSkeleton({ errors: [value] });

  assert.ok(
    text.includes('- line one\n  line two\n'),
    'the item must span the embedded newline with the continuation indented',
  );
  assert.ok(text.includes('line one'), 'the first line is kept verbatim');
  assert.ok(text.includes('line two'), 'the continuation line is kept verbatim');
  assert.equal(bulletLines(text).length, 1, 'one item stays one bullet');
});

test('A8 — a multi-line item is not counted as several entries', () => {
  const heredoc = "cat > f <<'EOF'\n- not an item\n- also not\nEOF";
  const { text } = buildSkeleton({ commands: [heredoc, 'git commit -m x'] });

  assert.equal(bulletLines(text).length, 2, 'two items must read as two bullets');
  assert.equal(
    sectionBody(text, '### Commands Run').split('\n').filter((l) => l.startsWith('- ')).length,
    2,
    'no continuation line may look like a top-level bullet',
  );
});

test('A8b — a continuation that looks like a heading cannot truncate its section', () => {
  const { text } = buildSkeleton({ errors: ['boom\n# CI lines look like: x', 'second'] });

  assert.equal(
    sectionBody(text, '### Errors Seen'),
    '- boom\n  # CI lines look like: x\n- second',
    'an indented continuation is not a Markdown heading',
  );
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
    assert.deepStrictEqual(result.facts, { intents: [], contexts: [], files: [], commands: [], errors: [] });
  }
});


/* ------------------------------------------- S6: paired intent context */

test('A19 — an intent renders its paired context on an indented arrow line', () => {
  const { text } = buildSkeleton({
    intents: ['continue', 'authorize enabling it'],
    contexts: ['I finished the refactor.', 'Do you want me to enable the row?'],
  });

  assert.equal(
    sectionBody(text, '### User Intents'),
    '- continue\n  ↑ I finished the refactor.\n- authorize enabling it\n  ↑ Do you want me to enable the row?',
  );
  assert.equal(bulletLines(text).length, 2, 'each intent stays one bullet');
});

test('A19 — an empty context adds no line and changes nothing', () => {
  const bare = buildSkeleton({ intents: ['continue'] }).text;
  const paired = buildSkeleton({ intents: ['continue'], contexts: [''] }).text;

  assert.equal(paired, bare, 'an empty context must be indistinguishable from none');
});

test('A19 — contexts shorter than intents leave the extra intents unpaired', () => {
  // copyFacts tolerates a partial shape; a context list that does not cover
  // every intent must degrade to unpaired rather than throw or misalign.
  const { text } = buildSkeleton({ intents: ['a', 'b'], contexts: ['only for a'] });

  assert.equal(sectionBody(text, '### User Intents'), '- a\n  ↑ only for a\n- b');
});

test('A20 — the skeleton never truncates the intent, only the context', () => {
  const intent = 'please ' + 'really '.repeat(200) + 'fix it';
  const { text } = buildSkeleton({ intents: [intent], contexts: ['short'] });

  assert.ok(text.includes(intent), 'the intent must be emitted byte-for-byte');
});

test('A3b — a paired context is a continuation, so it cannot look like a bullet or heading', () => {
  const { text } = buildSkeleton({ intents: ['go'], contexts: ['# not a heading\n- not a bullet'] });

  assert.equal(
    sectionBody(text, '### User Intents'),
    '- go\n  ↑ # not a heading\n  - not a bullet',
  );
  assert.equal(bulletLines(text).length, 1, 'the context lines stay inside the intent item');
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
