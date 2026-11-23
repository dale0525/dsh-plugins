import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linkGlobalRules } from './link-global-rules.mjs';

async function setupFixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'link-global-rules-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const repoRoot = path.join(tmp, 'repo');
  const dshHome = path.join(tmp, 'dsh-home');
  await fs.mkdir(path.join(repoRoot, 'global-rules', 'skills', 'alpha'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'global-rules', 'AGENTS.global.md'), '# Repo Global\n', 'utf8');
  await fs.writeFile(
    path.join(repoRoot, 'global-rules', 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: alpha\n---\n',
    'utf8',
  );
  await fs.mkdir(dshHome, { recursive: true });
  return { repoRoot, dshHome };
}

test('backs up existing regular files/dirs and creates symlinks', async (t) => {
  const { repoRoot, dshHome } = await setupFixture(t);
  await fs.writeFile(path.join(dshHome, 'AGENTS.md'), '# Old Local\n', 'utf8');
  await fs.mkdir(path.join(dshHome, 'skills', 'old'), { recursive: true });
  await fs.writeFile(path.join(dshHome, 'skills', 'old', 'SKILL.md'), 'old', 'utf8');

  const res = await linkGlobalRules({ repoRoot, dshHome });
  assert.equal(res.ok, true);
  assert.ok(res.backupDir);

  const agentsStat = await fs.lstat(path.join(dshHome, 'AGENTS.md'));
  const skillsStat = await fs.lstat(path.join(dshHome, 'skills'));
  assert.equal(agentsStat.isSymbolicLink(), true);
  assert.equal(skillsStat.isSymbolicLink(), true);
  assert.equal(await fs.realpath(path.join(dshHome, 'AGENTS.md')), await fs.realpath(path.join(repoRoot, 'global-rules', 'AGENTS.global.md')));
  assert.equal(await fs.realpath(path.join(dshHome, 'skills')), await fs.realpath(path.join(repoRoot, 'global-rules', 'skills')));

  // Backup preserved old contents
  assert.equal(await fs.readFile(path.join(res.backupDir, 'AGENTS.md'), 'utf8'), '# Old Local\n');
  assert.equal(await fs.readFile(path.join(res.backupDir, 'skills', 'old', 'SKILL.md'), 'utf8'), 'old');

  // Re-running is idempotent and creates no extra backup
  const second = await linkGlobalRules({ repoRoot, dshHome });
  assert.equal(second.ok, true);
  assert.equal(second.backupDir, null);

  // --check passes
  const check = await linkGlobalRules({ repoRoot, dshHome, checkOnly: true });
  assert.equal(check.ok, true);
});

test('--check fails when target is missing or not a symlink to repo', async (t) => {
  const { repoRoot, dshHome } = await setupFixture(t);
  await fs.writeFile(path.join(dshHome, 'AGENTS.md'), '# Regular File\n', 'utf8');
  const check = await linkGlobalRules({ repoRoot, dshHome, checkOnly: true });
  assert.equal(check.ok, false);
  assert.ok(check.issues.length >= 2);
});
