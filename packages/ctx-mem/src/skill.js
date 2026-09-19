/**
 * Bundled usage/configuration skill for ctx-mem.
 *
 * Ships `skills/ctx-mem-config/SKILL.md` through `ctx.skills.registerProvider`
 * so an agent asked to tune compaction, read a checkpoint, or mount the preset
 * loads the guide instead of guessing at key names and mount shapes.
 *
 * The runtime import of `@deepseek-ai/dsh-skill` is deliberately avoided: the
 * registry-published `dsh-skill` lib imports host-closure siblings that are
 * peers of it but absent from this package's own dependency graph, so importing
 * it would die under an isolated layout. The host injects the real service at
 * runtime; this module only hands it a plain provider object.
 *
 * @module @logictan/dsh-ctx-mem/skill
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Provider name under `ctx.skills`; doubles as the skill name. */
export const SKILL_PROVIDER_NAME = 'ctx-mem-config';

/** Packaged skill body; `../skills/` resolves to the package root from lib/. */
const SKILL_BODY_URL = new URL('../skills/ctx-mem-config/SKILL.md', import.meta.url);

/** Resource base served with the skill so its relative links resolve. */
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/ctx-mem-config/', import.meta.url)),
};

const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true };

/** Mirrors dsh-skill's bundled-skill rank (a non-load-bearing ordering hint). */
const BUNDLED_SKILL_RANK = 600;

/** Routing description; must stay identical to the SKILL.md frontmatter. */
export const SKILL_DESCRIPTION =
  'ctx-mem 上下文交接压缩后端（@logictan/dsh-ctx-mem）的使用与配置指南。凡涉及上下文压缩行为、/compact、压缩调参（阈值/保留尾巴/填空开关/填空路由/产出语言）、或要改挂载与配置位置时先读本指南：ctx-mem 替换官方 compaction-basic，程序逐字抽取硬事实（路径/命令/报错）+ 模型只补四节因果，产出含 ## Extracted Facts 骨架与 ## Why This Approach 等四节；可调键 thresholdRatio / retainRatio / retainTokens / fillEnabled / fillProvider / fillModel / language。触发词：ctx-mem、压缩、compaction、上下文超限、上下文交接、摘要、骨架、硬事实、thresholdRatio、retainTokens、fillEnabled。';

const SKILL_CANDIDATE = {
  name: SKILL_PROVIDER_NAME,
  description: SKILL_DESCRIPTION,
  invocation: SKILL_INVOCATION,
  provider: SKILL_PROVIDER_NAME,
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
};

/** The bundled-skill catalog entry, served through the host skill registry. */
export const skillProvider = {
  name: SKILL_PROVIDER_NAME,
  list(_options) {
    return Promise.resolve([SKILL_CANDIDATE]);
  },
  async get(_candidate, _options) {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: stripFrontmatter(await readFile(SKILL_BODY_URL, 'utf8')),
    };
  },
};

/**
 * Strip a leading YAML frontmatter block (`---` / body / `---`) from a skill
 * markdown file.
 *
 * `SkillDefinition.content` must be the instruction body after metadata removal
 * — the same shape the filesystem provider serves — so the bundled SKILL.md,
 * which keeps its frontmatter for the GitHub/manual install paths, has the
 * block removed when served through {@link skillProvider}. Tolerant by design:
 * input that does not open with a `---` line, or whose frontmatter block is
 * never closed, is returned unchanged.
 *
 * @param {string} raw File contents.
 * @returns {string} Body without the frontmatter block.
 */
export function stripFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return raw;
  let lineStart = firstLineEnd + 1;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1).trim();
    }
    if (nextNewline < 0) return raw;
    lineStart = nextNewline + 1;
  }
  return raw;
}
