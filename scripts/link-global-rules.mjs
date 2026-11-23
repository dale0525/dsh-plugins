#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveDefaultDshHome() {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function isLinkedTo(linkPath, expectedTarget) {
  try {
    const lst = await fs.lstat(linkPath);
    if (!lst.isSymbolicLink()) return { ok: false, reason: 'not a symlink' };
    const [actualReal, expectedReal] = await Promise.all([
      fs.realpath(linkPath),
      fs.realpath(expectedTarget),
    ]);
    if (actualReal !== expectedReal) {
      return { ok: false, reason: `points to ${actualReal}, expected ${expectedReal}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'missing' : String(err) };
  }
}

export async function linkGlobalRules({
  repoRoot = DEFAULT_REPO_ROOT,
  dshHome = resolveDefaultDshHome(),
  checkOnly = false,
} = {}) {
  const targets = [
    {
      name: 'AGENTS.md',
      linkPath: path.join(dshHome, 'AGENTS.md'),
      sourcePath: path.join(repoRoot, 'global-rules', 'AGENTS.global.md'),
      type: 'file',
    },
    {
      name: 'skills',
      linkPath: path.join(dshHome, 'skills'),
      sourcePath: path.join(repoRoot, 'global-rules', 'skills'),
      type: 'dir',
    },
  ];

  // Verify sources exist first
  for (const t of targets) {
    await fs.access(t.sourcePath);
  }

  if (checkOnly) {
    const issues = [];
    for (const t of targets) {
      const status = await isLinkedTo(t.linkPath, t.sourcePath);
      if (!status.ok) issues.push(`${t.linkPath}: ${status.reason}`);
    }
    return { ok: issues.length === 0, issues, backupDir: null };
  }

  await fs.mkdir(dshHome, { recursive: true });
  let backupDir = null;
  const linked = [];

  for (const t of targets) {
    const current = await isLinkedTo(t.linkPath, t.sourcePath);
    if (current.ok) {
      linked.push({ name: t.name, status: 'unchanged' });
      continue;
    }

    let existingStat = null;
    try {
      existingStat = await fs.lstat(t.linkPath);
    } catch {
      existingStat = null;
    }

    if (existingStat) {
      if (existingStat.isSymbolicLink()) {
        await fs.unlink(t.linkPath);
      } else {
        if (!backupDir) {
          backupDir = path.join(dshHome, 'backups', `pre-link-${timestampSlug()}`);
          await fs.mkdir(backupDir, { recursive: true });
        }
        await fs.rename(t.linkPath, path.join(backupDir, t.name));
      }
    }

    const symlinkType = process.platform === 'win32' && t.type === 'dir' ? 'junction' : t.type;
    await fs.symlink(t.sourcePath, t.linkPath, symlinkType);
    linked.push({ name: t.name, status: 'linked', target: t.sourcePath });
  }

  return { ok: true, issues: [], backupDir, linked };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const checkOnly = process.argv.includes('--check');
  const res = await linkGlobalRules({ checkOnly });
  if (!res.ok) {
    console.error(`Global rules symlink check failed:\n- ${res.issues.join('\n- ')}`);
    process.exit(1);
  }
  if (checkOnly) {
    console.log('Global rules symlinks OK');
  } else {
    console.log('Linked global rules:', res.linked);
    if (res.backupDir) console.log('Backed up previous files to:', res.backupDir);
  }
}
