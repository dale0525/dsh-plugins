import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGlobalRules } from './check-global-rules.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeTempRulesDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-global-rules-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'skills', 'demo-skill'), { recursive: true });
  await fs.writeFile(path.join(dir, 'AGENTS.global.md'), '# Global Rules\n\nClean content.\n', 'utf8');
  await fs.writeFile(
    path.join(dir, 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: Short valid description.\n---\n\n# Demo\n\n## Section\n\nBody.\n',
    'utf8',
  );
  return dir;
}

test('repository global-rules/ passes all checks', async () => {
  const result = await checkGlobalRules(path.join(REPO_ROOT, 'global-rules'));
  assert.deepEqual(result.errors, []);
  assert.ok(result.skills.length >= 15);
});

test('rejects invalid frontmatter, overlong description, and legacy keys', async (t) => {
  const dir = await makeTempRulesDir(t);
  await fs.writeFile(
    path.join(dir, 'skills', 'demo-skill', 'SKILL.md'),
    `---\nname: wrong-name\ndescription: ${'a'.repeat(501)}\ndisableModelInvocation: true\n---\n\n# Demo\n`,
    'utf8',
  );
  const { errors } = await checkGlobalRules(dir);
  assert.ok(errors.some((e) => e.includes('name mismatch')));
  assert.ok(errors.some((e) => e.includes('500')));
  assert.ok(errors.some((e) => e.includes('legacy key')));
});

test('rejects numbered headings, broken references, stray files, and privacy leaks', async (t) => {
  const dir = await makeTempRulesDir(t);
  await fs.writeFile(
    path.join(dir, 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: Valid.\n---\n\n## 1. Bad Heading\n\nSee references/missing.md and /Users/alice/secret.txt and alice@example.com and 192.168.1.50\n',
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'skills', 'demo-skill', 'SKILL.md.bak'), 'old', 'utf8');
  const { errors } = await checkGlobalRules(dir);
  assert.ok(errors.some((e) => e.includes('numbered heading')));
  assert.ok(errors.some((e) => e.includes('broken reference')));
  assert.ok(errors.some((e) => e.includes('stray file')));
  assert.ok(errors.some((e) => e.includes('privacy')));
});

test('rejects AGENTS.md inside global-rules/ to prevent host overlay collision', async (t) => {
  const dir = await makeTempRulesDir(t);
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# Collision\n', 'utf8');
  const { errors } = await checkGlobalRules(dir);
  assert.ok(errors.some((e) => e.includes('AGENTS.md')));
});
