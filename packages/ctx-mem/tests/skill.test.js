/**
 * Tests for the bundled usage/config skill.
 *
 * The guide is a deliverable in its own right (plan §2.1), and it is served
 * through the host skill registry rather than read off disk, so what needs
 * pinning is: the body actually ships inside the package, the served content is
 * the body with frontmatter removed, and the provider satisfies the registry's
 * own candidate contract (name/description/invocation/rank/provider identity)
 * without the engine needing `skills` in `static inject`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import CtxMemEngine from '../src/index.js';
import { SKILL_DESCRIPTION, SKILL_PROVIDER_NAME, skillProvider, stripFrontmatter } from '../src/skill.js';
import { registerSkill } from '../src/index.js';

/* ------------------------------------------------------------------ helpers */

const SKILL_URL = new URL('../skills/ctx-mem-config/SKILL.md', import.meta.url);

/** Parse the YAML frontmatter block of the packaged SKILL.md. */
async function frontmatter() {
  const raw = await readFile(SKILL_URL, 'utf8');
  const end = raw.indexOf('\n---', 3);
  assert.ok(raw.startsWith('---\n'), 'SKILL.md must open with a frontmatter block');
  assert.ok(end > 0, 'SKILL.md frontmatter block must be closed');
  const block = raw.slice(4, end);
  const fields = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^([a-z-]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim().replace(/^"|"$/g, '');
  }
  return { raw, fields };
}

/* ------------------------------------------------------------ packaged body */

test('the guide ships inside the package', async () => {
  const { raw } = await frontmatter();
  assert.ok(raw.length > 1000, 'the guide must carry real content, not a stub');
});

test('the routing description is identical in the frontmatter and the provider', async () => {
  // The frontmatter is what the GitHub/manual install paths read; the constant is
  // what the registry serves. Drift between them means the skill routes on one
  // description and is catalogued under another.
  const { fields } = await frontmatter();
  assert.equal(fields.name, SKILL_PROVIDER_NAME);
  assert.equal(fields.description, SKILL_DESCRIPTION);
});

/* ------------------------------------------------------------ served content */

test('the served body drops the frontmatter block', async () => {
  const { raw } = await frontmatter();
  const served = (await skillProvider.get(skillProvider.list()[0])).content;

  assert.ok(!served.startsWith('---'), 'served content must not carry frontmatter');
  assert.ok(!served.includes('name: ctx-mem-config'), 'served content must not carry metadata keys');
  assert.equal(served, stripFrontmatter(raw));
  assert.ok(served.includes('# ctx-mem 使用指南'), 'the body must survive intact');
});

test('frontmatter stripping is tolerant of non-frontmatter input', () => {
  assert.equal(stripFrontmatter('# plain\nbody\n'), '# plain\nbody\n');
  assert.equal(stripFrontmatter('---\nunclosed\n'), '---\nunclosed\n');
  assert.equal(stripFrontmatter('---\r\nname: x\r\n---\r\nbody'), 'body');
});

/* ------------------------------------------------------ registry candidate */

test('the provider satisfies the registry candidate contract', async () => {
  const [candidate] = await skillProvider.list();

  assert.equal(skillProvider.name, SKILL_PROVIDER_NAME);
  assert.equal(candidate.provider, skillProvider.name, 'candidate.provider must equal the provider name');
  assert.match(candidate.name, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(candidate.description.length > 0);
  assert.equal(typeof candidate.rank, 'number');
  assert.equal(candidate.source, 'bundled');
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(candidate.resourceBase.kind, 'directory');
});

/* ------------------------------------------------------------ engine wiring */

test('the engine registers the guide without declaring skills in static inject', async () => {
  // Redeclaring `inject` on the subclass would silently drop whatever the host
  // engine adds to its list later; the child fiber is how the guide reaches the
  // registry without that. Both halves are asserted here so the choice cannot be
  // undone by accident.
  assert.deepEqual(CtxMemEngine.inject, ['llm', 'tokenMeter', 'sessions']);

  const registered = [];
  const ctx = new Context();
  ctx.provide('llm', {});
  ctx.provide('tokenMeter', {});
  ctx.provide('sessions', {});
  ctx.provide('skills', { registerProvider: (create) => registered.push(create()) });

  const fiber = registerSkill(ctx);
  await fiber;

  assert.equal(registered.length, 1, 'exactly one provider must be registered');
  assert.equal(registered[0].name, SKILL_PROVIDER_NAME);
});

test('constructing the engine is what publishes the guide', async () => {
  // The constructor's own call site: `registerSkill` returning a fiber is an
  // implementation detail, but the engine must still ask for the registry.
  const registered = [];
  const ctx = new Context();
  ctx.provide('llm', {});
  ctx.provide('tokenMeter', {});
  ctx.provide('sessions', {});
  ctx.provide('skills', { registerProvider: (create) => registered.push(create()) });

  const engine = new CtxMemEngine(ctx, {});
  await engine.skillFiber;

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, SKILL_PROVIDER_NAME);
});

test('a host with no skill registry still constructs the engine', () => {
  // Losing a documentation skill must never fail a compaction engine.
  const ctx = new Context();
  ctx.provide('llm', {});
  ctx.provide('tokenMeter', {});
  ctx.provide('sessions', {});

  assert.doesNotThrow(() => new CtxMemEngine(ctx, {}));
});
