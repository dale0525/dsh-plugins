#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RULES_DIR = path.join(REPO_ROOT, 'global-rules');

const STRAY_FILE_RE = /\.bak|openai\.yaml$|^README\.md$|^CHANGELOG\.md$/i;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEGACY_KEYS_RE = /^(?:disableModelInvocation|modelInvocable|userInvocable):/m;
const NUMBERED_HEADING_RE = /^#{1,6}\s+[0-9]+\./;
const NUMERIC_SECTION_REF_RE = /第 ?[0-9]+ ?[节步]|§[0-9]/;

const PRIVACY_PATTERNS = [
  { label: 'macOS home path', re: /\/Users\/[A-Za-z0-9._-]+/ },
  { label: 'Windows home path', re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/ },
  { label: 'email address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { label: 'private IPv4', re: /\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/ },
  { label: 'secret token prefix', re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/ },
];

async function walkFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

function checkPrivacy(relPath, content, errors) {
  for (const { label, re } of PRIVACY_PATTERNS) {
    if (re.test(content)) {
      errors.push(`${relPath}: privacy guard matched ${label}`);
    }
  }
}

function checkHeadingAndSectionRefs(relPath, content, { allowSectionRefExamples = false }, errors) {
  const lines = content.split('\n');
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (NUMBERED_HEADING_RE.test(line)) {
      errors.push(`${relPath}:${i + 1}: numbered heading not allowed (${line.trim()})`);
    }
    if (!allowSectionRefExamples && NUMERIC_SECTION_REF_RE.test(line)) {
      errors.push(`${relPath}:${i + 1}: numeric section reference not allowed`);
    }
  }
}

export async function checkGlobalRules(rulesDir = DEFAULT_RULES_DIR) {
  const errors = [];
  const skills = [];

  // 1. Check AGENTS.global.md and forbid AGENTS.md collision
  const agentsGlobalPath = path.join(rulesDir, 'AGENTS.global.md');
  try {
    const agentsContent = await fs.readFile(agentsGlobalPath, 'utf8');
    checkPrivacy('AGENTS.global.md', agentsContent, errors);
  } catch {
    errors.push('Missing AGENTS.global.md');
  }

  try {
    await fs.access(path.join(rulesDir, 'AGENTS.md'));
    errors.push('Forbidden AGENTS.md inside global-rules/ (rename to AGENTS.global.md to prevent host overlay collision)');
  } catch {
    // expected absent
  }

  // 2. Inspect skills/
  const skillsRoot = path.join(rulesDir, 'skills');
  let skillDirs = [];
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    skillDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch {
    errors.push('Missing skills/ directory');
    return { errors, skills };
  }

  const skillSet = new Set(skillDirs);
  const allSkillFiles = await walkFiles(skillsRoot);
  for (const f of allSkillFiles) {
    const base = path.basename(f);
    if (STRAY_FILE_RE.test(base)) {
      errors.push(`stray file: ${path.relative(rulesDir, f)}`);
    }
  }

  for (const dirName of skillDirs) {
    const skillDir = path.join(skillsRoot, dirName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    let text;
    try {
      text = await fs.readFile(skillFile, 'utf8');
    } catch {
      errors.push(`${dirName}: missing SKILL.md`);
      continue;
    }

    const relSkill = path.relative(rulesDir, skillFile);
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      errors.push(`${relSkill}: missing YAML frontmatter`);
      continue;
    }
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : '';
    const desc = descMatch ? descMatch[1].trim() : '';

    if (name !== dirName) errors.push(`${relSkill}: name mismatch (dir=${dirName}, name=${name})`);
    if (!KEBAB_RE.test(name)) errors.push(`${relSkill}: name must be kebab-case (${name})`);
    if (!desc) errors.push(`${relSkill}: empty description`);
    if (desc.length > 500) errors.push(`${relSkill}: description exceeds 500 chars (${desc.length})`);
    if (LEGACY_KEYS_RE.test(fm)) errors.push(`${relSkill}: legacy key in frontmatter`);

    const modelInvocable = !/^disable-model-invocation:\s*true$/m.test(fm);
    skills.push({
      name: dirName,
      lines: text.split('\n').length,
      bytes: Buffer.byteLength(text, 'utf8'),
      descLen: desc.length,
      modelInvocable,
    });

    const body = text.slice(fmMatch[0].length);
    checkPrivacy(relSkill, text, errors);
    checkHeadingAndSectionRefs(
      relSkill,
      body,
      { allowSectionRefExamples: dirName === 'doc-governance' },
      errors,
    );

    // Check references/ files are referenced and valid
    const refDir = path.join(skillDir, 'references');
    try {
      const refFiles = await fs.readdir(refDir);
      for (const rf of refFiles) {
        if (!rf.endsWith('.md')) continue;
        if (!body.includes(`references/${rf}`)) {
          errors.push(`${relSkill}: unreferenced file references/${rf}`);
        }
        const refContent = await fs.readFile(path.join(refDir, rf), 'utf8');
        const relRef = path.relative(rulesDir, path.join(refDir, rf));
        checkPrivacy(relRef, refContent, errors);
        checkHeadingAndSectionRefs(relRef, refContent, { allowSectionRefExamples: false }, errors);
      }
    } catch {
      // no references/ directory
    }

    // Check all references/<file>.md mentions exist (either in self or explicit cross-skill ref)
    for (const m of body.matchAll(/(?:`([a-z0-9-]+)`[^`\n]{0,12})?`?references\/([a-z0-9-]+\.md)`?/g)) {
      const maybeOtherSkill = m[1];
      const refName = m[2];
      const targetSkill = maybeOtherSkill && skillSet.has(maybeOtherSkill) ? maybeOtherSkill : dirName;
      const targetPath = path.join(skillsRoot, targetSkill, 'references', refName);
      try {
        await fs.access(targetPath);
      } catch {
        errors.push(`${relSkill}: broken reference references/${refName}`);
      }
    }
  }

  return { errors, skills };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const { errors, skills } = await checkGlobalRules();
  const modelCount = skills.filter((s) => s.modelInvocable).length;
  const userOnlyCount = skills.length - modelCount;
  console.log(`Checked global-rules/: ${skills.length} skills (${modelCount} model-invocable, ${userOnlyCount} user-only)`);
  if (errors.length > 0) {
    console.error(`Found ${errors.length} error(s):\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log('OK');
}
