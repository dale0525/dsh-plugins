/**
 * Unit tests for the budget-driven renderer.
 *
 * The estimator is injected, so these tests price with the host's own
 * `estimateMessage` over a real frame — the same arithmetic the host guard
 * applies — rather than with a hand-rolled approximation that could drift from
 * it. `framePrice` below rebuilds exactly what `frameSummary` produces.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOOR_TIER, TIERS, isWriteLike, renderCheckpoint } from '../src/render.js';
import { framePrice } from './frame-price.js';

const estimate = (text) => framePrice(text);

/** A fact set large enough that T1 cannot hold it whole. */
function bigFacts() {
  return {
    intents: ['please fix the compaction guard'],
    files: ['/repo/src/index.js'],
    commands: Array.from({ length: 400 }, (_, i) => `grep -n "needle-${i}" /repo/src/file-${i}.js`),
    errors: Array.from({ length: 30 }, (_, i) => `bash: error number ${i} while doing the thing`),
  };
}

/* ------------------------------------------------------------ tier behaviour */

test('A2 — the rendering is strictly smaller than the budget it is given', () => {
  const facts = bigFacts();
  for (const budget of [40000, 24000, 12000, 4000, 1200]) {
    const { text } = renderCheckpoint(facts, budget, estimate);
    assert.ok(estimate(text) < budget, `budget ${budget}: price ${estimate(text)} must be < ${budget}`);
  }
})

test('A4 — intents and files survive verbatim at every budget', () => {
  const longIntent = `please ${'really '.repeat(200)}fix it`;
  const longPath = `/repo/${'deep/'.repeat(150)}file.js`;
  const facts = { ...bigFacts(), intents: [longIntent], files: [longPath] };

  for (const budget of [40000, 24000, 4000, 1200, 500]) {
    const { text } = renderCheckpoint(facts, budget, estimate);
    assert.ok(text.includes(longIntent), `budget ${budget}: the full intent must be present`);
    assert.ok(text.includes(longPath), `budget ${budget}: the full path must be present`);
  }
})

test('A5 — every truncation carries a marker with the exact dropped character count', () => {
  const command = `git commit -m "${'x'.repeat(5000)}"`;
  const facts = { intents: [], files: [], commands: [command], errors: [] };
  const { commands } = renderCheckpoint(facts, 40000, estimate);

  assert.equal(commands.length, 1);
  const marker = /…\[\+(\d+) chars\]$/.exec(commands[0]);
  assert.ok(marker, `a truncated command must carry the marker, got ${JSON.stringify(commands[0].slice(-40))}`);

  // The retained text must be a verbatim PREFIX of the original, and the marker
  // must state exactly how many characters were cut.
  const kept = commands[0].slice(0, -marker[0].length).trimEnd();
  assert.ok(command.startsWith(kept), 'the retained text must be a verbatim prefix of the original');
  assert.equal(command.length - kept.length, Number(marker[1]), 'the marker must count the dropped characters exactly');
})

test('A6 — the floor tier keeps intents and files only, and stays cheap', () => {
  const facts = bigFacts();
  // Below the floor's own price (132 framed tokens): even intents+files cannot fit.
  const { tier, commands, errors, floorHit } = renderCheckpoint(facts, 100, estimate);

  assert.equal(tier, FLOOR_TIER);
  assert.equal(floorHit, true);
  assert.deepEqual(commands, []);
  assert.deepEqual(errors, []);
})

test('A7 — a tiny budget returns the floor tier instead of throwing', () => {
  const facts = { intents: ['a'], files: ['b'], commands: ['c'], errors: ['d'] };
  let result;
  assert.doesNotThrow(() => {
    result = renderCheckpoint(facts, 10, estimate);
  });
  assert.equal(result.floorHit, true);
  assert.equal(result.tier, FLOOR_TIER);
})

/* --------------------------------------------------- retention and write-like */

test('A3 — the write-like discriminator keeps the mutating commands verbatim', () => {
  const mutating = [
    'git commit -m "x"',
    'git push origin main',
    'npm publish --access public',
    'pnpm install',
    'dsh-web restart',
    'node build.mjs',
    'mkdir -p /tmp/x',
    'rm -rf /tmp/x',
    'chmod +x ./run.sh',
    'echo hi > src/out.txt',
  ];
  const probing = [
    'ls -la',
    'grep -n foo bar.js',
    'sed -n "1,5p" file',
    'echo hello',
    'cat README.md',
    'echo hi > /tmp/out.txt',
    'ls -la | sort > /tmp/all-specs.txt',
  ];

  for (const command of mutating) assert.ok(isWriteLike(command), `${command} must be write-like`);
  for (const command of probing) assert.ok(!isWriteLike(command), `${command} must not be write-like`);
})

test('a probe is dropped outright and only a state-changing command is rendered', () => {
  // A probe's fact is its output, which the error and file lists already carry,
  // so the probe text itself never reaches the checkpoint — at any tier. The
  // discriminator is what decides: `grep` reads, `git commit` writes.
  const write = `git commit -m "${'y'.repeat(600)}"`;
  const probe = `grep -n "${'z'.repeat(600)}" /repo/file.js`;
  const { commands } = renderCheckpoint({ intents: [], files: [], commands: [probe, write], errors: [] }, 24000, estimate);

  assert.equal(commands.length, 1, `only the write-like command may render, got ${JSON.stringify(commands)}`);
  assert.ok(commands[0].startsWith('git commit'), 'the write-like command is the one kept');
})

test('retention is newest-first: the oldest entries are the ones dropped', () => {
  // Enough commands that the budget cannot hold them all, with T1 too small to
  // fit the whole set so the greedy path runs.
  const commands = Array.from({ length: 3000 }, (_, i) => `mkdir -p /repo/out/dir-${i}`);
  const { commands: kept } = renderCheckpoint(
    { intents: [], files: [], commands, errors: [] },
    3000,
    estimate,
  );

  assert.ok(kept.length > 0 && kept.length < commands.length, `expected a partial retention, got ${kept.length}`);
  assert.equal(kept[kept.length - 1], commands[commands.length - 1], 'the newest command must be kept');
  assert.ok(!kept.includes(commands[0]), 'the oldest command must be the first to go');
})

test('errors are placed before commands, because an error cannot be re-derived', () => {
  const facts = {
    intents: [],
    files: [],
    commands: Array.from({ length: 4000 }, (_, i) => `mkdir -p /repo/dir-${i}`),
    errors: ['bash: the one thing that actually failed'],
  };
  const { errors, commands } = renderCheckpoint(facts, 3000, estimate);

  assert.deepEqual(errors, ['bash: the one thing that actually failed']);
  assert.ok(commands.length < facts.commands.length, 'commands must be the ones that give way');
})

/* ------------------------------------------------------------ tier selection */

test('a fact set that fits T1 whole loses nothing and reports T1', () => {
  const facts = { intents: ['a'], files: ['b'], commands: ['mkdir -p /repo/x'], errors: ['e'] };
  const { tier, commands, errors, floorHit } = renderCheckpoint(facts, 40000, estimate);

  assert.equal(tier, 'T1');
  assert.equal(floorHit, false);
  assert.deepEqual(commands, ['mkdir -p /repo/x']);
  assert.deepEqual(errors, ['e']);
})

test('the fidelity ladder degrades the tier before it drops a fact', () => {
  // Sized so T1's 4000-char cap overflows the budget (45458) but T2's
  // 2000-char cap does not (30175): no fact may be lost, only detail.
  const commands = Array.from({ length: 60 }, (_, i) => `git commit -m "${'c'.repeat(3000)}-${i}"`);
  const facts = { intents: [], files: [], commands, errors: [] };

  const { tier, commands: kept } = renderCheckpoint(facts, 40000, estimate);

  assert.equal(kept.length, commands.length, 'no command may be dropped while a poorer tier still fits');
  assert.equal(tier, 'T2');
})

test('a write-like command survives a flood of newer probes', () => {
  // The write-like command is the OLDEST and a flood of newer probes would
  // evict it under plain newest-first retention. Probes are never rendered, so
  // the retention walk skips straight past them to the fact that matters.
  const facts = {
    intents: [],
    files: [],
    commands: [`git commit -m "${'w'.repeat(9000)}"`, ...Array.from({ length: 500 }, (_, i) => `probe ${i} ${'p'.repeat(200)}`)],
    errors: [],
  };
  const { commands } = renderCheckpoint(facts, 5000, estimate);

  assert.ok(commands.every((c) => isWriteLike(c)), `only write-like commands may render, got ${JSON.stringify(commands.slice(0, 3))}`);
  assert.ok(commands.some((c) => c.startsWith('git commit')), 'the older write-like command must survive the probe flood');
})

test('T3 keeps a write-like command whose marker is off the first line, so it still reads as write-like', () => {
  // Discriminating fixture: the state-changing marker (`git commit`) sits on
  // the SECOND line, behind a plain `echo setup`. Pre-fix, T3 degraded a
  // write-like command to its first line only, so the rendering was
  // `echo setup …` — a bare `echo` that reads as a probe and silently drops
  // the state change. Keeping the first line AND the marker line is what keeps
  // the command recognisable as the write it was.
  const cmd = `echo setup\ngit commit -m "${'w'.repeat(4000)}"`;
  const facts = { intents: [], files: [], commands: [cmd, ...Array.from({ length: 200 }, (_, i) => `probe ${i} ${'p'.repeat(200)}`)], errors: [] };

  for (const budget of [200, 300, 400, 500, 600]) {
    const { tier, commands } = renderCheckpoint(facts, budget, estimate);
    assert.equal(tier, 'T3', `budget ${budget}: T3 must rescue the write-like command`);
    assert.equal(commands.length, 1, `budget ${budget}: only the write-like command may survive`);
    assert.ok(isWriteLike(commands[0]), `budget ${budget}: the rendered command must still read as write-like, got ${JSON.stringify(commands[0].slice(0, 60))}`);
    assert.ok(commands[0].startsWith('echo setup'), `budget ${budget}: the first line must be kept`);
    assert.ok(commands[0].includes('git commit'), `budget ${budget}: the marker line must be kept`);
    assert.match(commands[0], /…\[\+\d+ chars\]$/, `budget ${budget}: the dropped characters must be marked`);
  }
})

test('a tie in retained state-changing commands is broken by the richer tier', () => {
  // Two tiers can retain the same NUMBER of commands when the budget sits in a
  // window where neither can afford one more. Each command here is 200 chars:
  // T1 keeps it verbatim, T3 keeps its first line plus its marker line (~133),
  // so `base + 60` holds exactly one command at BOTH tiers and the tie must be
  // settled by fidelity rather than by entry count.
  const commands = Array.from({ length: 300 }, () => `git commit -m "${'p'.repeat(184)}"`);
  const facts = { intents: [], files: [], commands, errors: [] };
  const base = estimate(renderCheckpoint({ intents: [], files: [], commands: [], errors: [] }, 1e9, estimate).text);

  // The window's upper edge: one more command becomes affordable at T3, so T3
  // overtakes on count and wins. Pinning that edge is what makes the budget
  // below a genuine 1-vs-1 tie rather than a "T3 could not afford any" case.
  const edge = renderCheckpoint(facts, base + 70, estimate);
  assert.equal(edge.tier, 'T3');
  assert.equal(edge.commands.length, 2, 'the edge must be where T3 overtakes on count');

  const { tier, commands: kept } = renderCheckpoint(facts, base + 60, estimate);
  assert.equal(tier, 'T1', 'the richer tier must win the tie, not the tier with more entries');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].length, 200, 'the richer tier keeps the command verbatim');
})

test('a probe flood never evicts a state-changing command', () => {
  // The budget is ample, so nothing has to give way — but a probe still does
  // not render. Its fact is its output, which the error and file lists carry.
  const facts = {
    intents: [],
    files: [],
    commands: [`git commit -m "${'w'.repeat(500)}"`, ...Array.from({ length: 300 }, (_, i) => `probe ${i}`)],
    errors: [],
  };
  const { commands } = renderCheckpoint(facts, 3000, estimate);

  assert.ok(commands.some((c) => c.startsWith('git commit')), 'the write-like command must be retained');
  assert.ok(!commands.some((c) => c.startsWith('probe')), 'a probe is never rendered, however recent');
})

test('a missing estimator renders the richest tier whole rather than degrading silently', () => {
  const facts = { intents: ['a'], files: ['b'], commands: ['git commit -m x'], errors: ['e'] };
  const { tier, commands, errors } = renderCheckpoint(facts, 100, undefined);

  assert.equal(tier, 'T1');
  assert.deepEqual(commands, ['git commit -m x']);
  assert.deepEqual(errors, ['e']);
})

test('degenerate facts render the all-(none) skeleton without throwing', () => {
  for (const facts of [undefined, null, {}, { intents: null, commands: 'x' }]) {
    const { text, floorHit } = renderCheckpoint(facts, 24000, estimate);
    assert.ok(text.startsWith('## Extracted Facts'));
    assert.equal(floorHit, false);
  }
})

test('non-string and nullish fact entries are coerced, never thrown on', () => {
  // The capping helpers are string operations. `src/extract.js` only pushes
  // strings today, but this is a public pure function whose contract says it
  // never throws — a stray non-string must degrade, not blow up a compaction
  // the host has already committed to.
  const facts = {
    intents: ['keep me', 7, undefined, null],
    files: [{ toString: () => '/coerced.js' }],
    commands: [{ toString: () => 'git commit -m coerced' }, 'git commit -m x'],
    errors: [null, 'boom'],
  };

  const result = renderCheckpoint(facts, 100000, estimate);

  assert.ok(result.text.includes('keep me'));
  assert.ok(result.text.includes('7'), 'a non-string intent is coerced via String()');
  assert.ok(result.text.includes('/coerced.js'), 'a non-string file is coerced via String()');
  assert.ok(result.text.includes('git commit -m coerced'), 'a non-string command is coerced via String()');
  assert.ok(result.text.includes('boom'));
  assert.ok(!result.text.includes('undefined'), 'nullish entries are dropped, not stringified');
})

test('the tier table is frozen and covers T1–T3', () => {
  assert.deepEqual(Object.keys(TIERS), ['T1', 'T2', 'T3']);
  assert.ok(Object.isFrozen(TIERS));
  for (const tier of Object.values(TIERS)) assert.ok(Object.isFrozen(tier));
})

/* --------------------------------------------- S6: paired intent context */

test('A20 — the context line is capped but the intent itself is never truncated', () => {
  const intent = 'please ' + 'really '.repeat(300) + 'fix it'
  const context = 'C'.repeat(5000)
  const facts = { intents: [intent], contexts: [context], files: [], commands: [], errors: [] }

  const { text } = renderCheckpoint(facts, 40000, estimate)

  assert.ok(text.includes(intent), 'the intent must survive verbatim, however long')
  assert.ok(!text.includes(context), 'the context must not be emitted whole')
  const marker = /\u2191 (C+)/.exec(text)
  assert.ok(marker, 'the context line must be present and carry the marker')
  assert.equal(marker[1].length, TIERS.T1.contextCap, 'the context is capped at the tier contextCap')
})

test('A20 — a capped context states how many characters it dropped', () => {
  const context = 'D'.repeat(1000)
  const facts = { intents: ['go'], contexts: [context], files: [], commands: [], errors: [] }

  const { text } = renderCheckpoint(facts, 40000, estimate)
  const dropped = context.length - TIERS.T1.contextCap
  const expected = '\u2191 ' + 'D'.repeat(TIERS.T1.contextCap) + ' \u2026[+' + dropped + ' chars]'

  assert.ok(text.includes(expected), text)
})

test('an intent with no paired context renders exactly as it did before', () => {
  const bare = renderCheckpoint({ intents: ['just an intent'], files: [], commands: [], errors: [] }, 40000, estimate)
  const paired = renderCheckpoint(
    { intents: ['just an intent'], contexts: [''], files: [], commands: [], errors: [] },
    40000,
    estimate,
  )

  assert.equal(paired.text, bare.text, 'an empty context must add no line at all')
  assert.ok(bare.text.includes('- just an intent'), 'the intent still renders as one bullet')
})

test('a paired context is a continuation of its intent, not a second entry', () => {
  const { text } = renderCheckpoint(
    { intents: ['continue'], contexts: ['I finished the refactor.'], files: [], commands: [], errors: [] },
    40000,
    estimate,
  )

  const expected = '- continue\n  \u2191 I finished the refactor.\n'
  assert.ok(text.includes(expected), text)
})

test('paired context is truncated to its first non-empty line, discarding remaining lines', () => {
  const context = '\n\n## 结论\n\nctx-mem 检查点可读性计划...\n\n### 关键发现'
  const facts = { intents: ['deploy'], contexts: [context], files: [], commands: [], errors: [] }

  const { text } = renderCheckpoint(facts, 40000, estimate)

  assert.ok(text.includes('- deploy\n  \u2191 ## 结论\n'), text)
  assert.ok(!text.includes('ctx-mem 检查点可读性计划'), 'subsequent lines must be discarded')
  assert.ok(!text.includes('### 关键发现'), 'markdown headings in later lines must not appear')
})

test('a multi-line context applies contextCap only to the retained first line', () => {
  const head = 'E'.repeat(500)
  const context = `${head}\nsecond line\nthird line`
  const facts = { intents: ['review'], contexts: [context], files: [], commands: [], errors: [] }

  const { text } = renderCheckpoint(facts, 40000, estimate)
  const dropped = head.length - TIERS.T1.contextCap
  const expected = '\u2191 ' + 'E'.repeat(TIERS.T1.contextCap) + ' \u2026[+' + dropped + ' chars]'

  assert.ok(text.includes(expected), text)
  assert.ok(!text.includes('second line'), 'later lines are discarded without inflating dropped char count')
})

