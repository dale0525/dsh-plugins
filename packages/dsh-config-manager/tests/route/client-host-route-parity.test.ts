/**
 * 路由对等性守护：浏览器半 fetch 的每个 `/api/dsh-config-manager/...` 路径，
 * 宿主半 `src/index.ts` 必须注册同名路由。
 *
 * 背景（该守护存在的唯一理由）：宿主半与浏览器半各自以字符串字面量拼写 HTTP 路由路径。
 * 曾有一次重构删掉了宿主侧 `/api/dsh-config-manager/status` 路由，而浏览器半仍在调用它，
 * 运行时产生真实 404，且既有测试无一覆盖——本测试即该缺陷类的回归护栏。
 *
 * 方向性：只断言「客户端路径 ⊆ 宿主路径」（单向）。反向不断言：宿主路由可以合法地
 * 没有浏览器调用方。
 *
 * 提取口径：单遍、字符串感知的字符扫描器，状态机为 code | lineComment | blockComment |
 * string(quote)。只有处于 code 状态时才识别引号并收集以 `/api/dsh-config-manager/` 开头的
 * 字面量，因此注释里的路径一律不参与。**不能用正则剥离注释**：`/*` 会出现在注释正文
 * （如 `exports/*.zip`）与字符串里，正则会把其后的真实代码整段误当注释删除，令守护
 * 静默失效。零依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** 宿主半边入口（路由常量与注册所在处） */
const HOST_ENTRY = path.resolve(import.meta.dirname, '..', '..', 'src', 'index.ts');
/** 浏览器半边根目录 */
const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..', 'src', 'client');
/** 路由族前缀（两半共用的字面量口径） */
const API_PREFIX = '/api/dsh-config-manager/';

/**
 * 单遍字符串感知扫描：返回真实代码位置（非注释）上以 API_PREFIX 开头的字符串字面量。
 *
 * 状态机在 code 状态才识别引号与注释起始；进入 string 后按反斜杠转义推进，
 * 因此字符串内部的 `//`、`/*` 不会误开注释，注释内部的引号也不会误开字符串。
 */
function extractApiPaths(src: string): string[] {
  const paths: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];

    // 行注释：跳到行尾
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    // 块注释：跳到配对的 */
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    // 字符串字面量：单引号 / 双引号 / 反引号
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        j += 1;
      }
      const body = src.slice(i + 1, j);
      if (body.startsWith(API_PREFIX)) paths.push(body);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return paths;
}

/** 递归收集 .ts / .tsx 源文件，排除文件名含 `.test.` 的文件 */
function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(p, out);
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      && !entry.name.includes('.test.')
    ) {
      out.push(p);
    }
  }
  return out;
}

test('路由对等：浏览器半调用的 /api/dsh-config-manager/... 路径必须都有宿主路由', () => {
  const hostPaths = new Set(extractApiPaths(fs.readFileSync(HOST_ENTRY, 'utf8')));

  const clientPaths = new Set<string>();
  for (const file of walkSourceFiles(CLIENT_ROOT)) {
    for (const p of extractApiPaths(fs.readFileSync(file, 'utf8'))) clientPaths.add(p);
  }

  const unserved = [...clientPaths].filter((p) => !hostPaths.has(p)).sort();

  assert.deepEqual(
    unserved,
    [],
    `浏览器半调用了宿主半未注册的 /api/dsh-config-manager/... 路由（运行时 404）：\n${unserved.join('\n')}`,
  );
});
