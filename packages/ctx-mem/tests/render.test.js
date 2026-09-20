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
    'echo hi > /tmp/out.txt',
  ];
  const probing = ['ls -la', 'grep -n foo bar.js', 'sed -n "1,5p" file', 'echo hello', 'cat README.md'];

  for (const command of mutating) assert.ok(isWriteLike(command), `${command} must be write-like`);
  for (const command of probing) assert.ok(!isWriteLike(command), `${command} must not be write-like`);
})

test('write-like commands keep more text than probes when both are truncated', () => {
  const write = `git commit -m "${'y'.repeat(600)}"`;
  const probe = `grep -n "${'z'.repeat(600)}" /repo/file.js`;
  const { commands } = renderCheckpoint({ intents: [], files: [], commands: [probe, write], errors: [] }, 24000, estimate);

  const kept = (c) => c.replace(/…\[\+\d+ chars\]$/, '').length;
  const writeOut = commands.find((c) => c.startsWith('git commit'));
  const probeOut = commands.find((c) => c.startsWith('grep'));
  assert.ok(writeOut && probeOut, 'both commands must be present');
  assert.ok(kept(writeOut) > kept(probeOut), 'the write-like command must retain more text');
})

test('retention is newest-first: the oldest entries are the ones dropped', () => {
  // Enough commands that the budget cannot hold them all, with T1 too small to
  // fit the whole set so the greedy path runs.
  const commands = Array.from({ length: 3000 }, (_, i) => `probe number ${i}`);
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
    commands: Array.from({ length: 4000 }, (_, i) => `probe ${i}`),
    errors: ['bash: the one thing that actually failed'],
  };
  const { errors, commands } = renderCheckpoint(facts, 3000, estimate);

  assert.deepEqual(errors, ['bash: the one thing that actually failed']);
  assert.ok(commands.length < facts.commands.length, 'commands must be the ones that give way');
})

/* ------------------------------------------------------------ tier selection */

test('a fact set that fits T1 whole loses nothing and reports T1', () => {
  const facts = { intents: ['a'], files: ['b'], commands: ['ls'], errors: ['e'] };
  const { tier, commands, errors, floorHit } = renderCheckpoint(facts, 40000, estimate);

  assert.equal(tier, 'T1');
  assert.equal(floorHit, false);
  assert.deepEqual(commands, ['ls']);
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

test('T3 reaches past a probe flood to keep the older write-like command', () => {
  // The write-like command is the OLDEST and a flood of newer probes would
  // evict it under newest-first retention at T1/T2. T3 discards probes
  // entirely, so it can still reach it — this is the whole point of T3.
  const facts = {
    intents: [],
    files: [],
    commands: [`git commit -m "${'w'.repeat(9000)}"`, ...Array.from({ length: 500 }, (_, i) => `probe ${i} ${'p'.repeat(200)}`)],
    errors: [],
  };
  const { tier, commands } = renderCheckpoint(facts, 5000, estimate);

  assert.equal(tier, 'T3');
  assert.ok(commands.every((c) => isWriteLike(c)), `T3 must keep only write-like commands, got ${JSON.stringify(commands.slice(0, 3))}`);
  assert.ok(commands.some((c) => c.startsWith('git commit')), 'the older write-like command must survive the probe flood');
})

test('a probe flood never evicts a state-changing command at T1', () => {
  // Same shape, but the budget is large enough that T1 can hold the write-like
  // command after dropping probes — it must prefer that over an empty list.
  const facts = {
    intents: [],
    files: [],
    commands: [`git commit -m "${'w'.repeat(500)}"`, ...Array.from({ length: 300 }, (_, i) => `probe ${i}`)],
    errors: [],
  };
  const { commands } = renderCheckpoint(facts, 3000, estimate);

  assert.ok(commands.some((c) => c.startsWith('git commit')), 'the write-like command must be retained');
  assert.ok(commands.some((c) => c.startsWith('probe')), 'the recent probes must be retained too when they fit');
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
    intents: ['keep me', undefined, null],
    files: [{ toString: () => '/coerced.js' }],
    commands: [7, 'git commit -m x'],
    errors: [null, 'boom'],
  };

  const result = renderCheckpoint(facts, 100000, estimate);

  assert.ok(result.text.includes('keep me'));
  assert.ok(result.text.includes('/coerced.js'), 'a non-string file is coerced via String()');
  assert.ok(result.text.includes('7'), 'a non-string command is coerced via String()');
  assert.ok(result.text.includes('git commit -m x'));
  assert.ok(result.text.includes('boom'));
  assert.ok(!result.text.includes('undefined'), 'nullish entries are dropped, not stringified');
})

test('the tier table is frozen and covers T1–T3', () => {
  assert.deepEqual(Object.keys(TIERS), ['T1', 'T2', 'T3']);
  assert.ok(Object.isFrozen(TIERS));
  for (const tier of Object.values(TIERS)) assert.ok(Object.isFrozen(tier));
})
