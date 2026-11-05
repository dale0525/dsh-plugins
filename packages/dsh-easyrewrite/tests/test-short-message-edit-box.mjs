/**
 * test-short-message-edit-box.mjs — 短消息编辑态的几何契约。
 *
 * 缺陷：默认 standard 档把编辑框宽度绑成 `28 + 14×全角字数`，2~6 个汉字
 * 只有 56~112px；框内却固定要放「取消 / 确定」两枚 nowrap 按钮（约 120px）
 * 加左右 padding 28px，短消息必然被挤成窄竖条、按钮溢出。宽度还随每次
 * 敲字 ±14px 持续抖动；带图缩略图用字符串宽度做减法会得到 NaNpx。
 *
 * 本测试真执行从源码抽出的编辑框计算函数，钉住最小宽度、数值宽度与
 * 稳定宽度三条性质；并静态检查编辑框 style 确实带 minWidth。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../src/client.src.js'), 'utf-8');
const lines = src.split('\n');

console.log('--- 开始测试：短消息编辑框几何 ---');

function bodyOf(name) {
  const pattern = new RegExp(`^\\s*(?:async\\s+)?function ${name}\\s*\\(`);
  const start = lines.findIndex(line => pattern.test(line));
  assert.notEqual(start, -1, `找不到函数 ${name} 的声明（改名了？本测试需同步更新）`);
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    if (i > start && depth === 0) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`${name} 的函数体没有闭合`);
}

const editWidthFor = new Function('editWidthCustom', `${bodyOf('editWidthFor')}; return editWidthFor;`)(
  () => '300px',
);
// 最小宽常量必须从源码解析，不能在测试里另写一份——否则实现把常量改小后
// 测试仍在测自己注入的副本，会假绿灯（反证实测发生过）。
const minWidthDecl = /var EDIT_BOX_MIN_WIDTH = (\d+);/.exec(src);
assert.ok(minWidthDecl, '找不到 EDIT_BOX_MIN_WIDTH 常量声明');
const EDIT_BOX_MIN_WIDTH = Number(minWidthDecl[1]);
const editBoxWidthFor = new Function('editWidthCustom', 'EDIT_BOX_MIN_WIDTH', `${bodyOf('editWidthFor')}\n${bodyOf('editBoxWidthFor')}; return editBoxWidthFor;`)(
  () => '300px',
  EDIT_BOX_MIN_WIDTH,
);

const CAP = 'min(80%, var(--dsh-chat-content-width, 748px))';

// ---------------------------------------------------------------------------
// [Test 1] editWidthFor 保持「贴合内容」语义（既有契约，不得回归）
// ---------------------------------------------------------------------------
console.log('[Test 1] 宽度公式仍贴合内容、长文本收在 80%...');

assert.equal(editWidthFor('standard', 'hi', 200), `min(44px, ${CAP})`);
assert.equal(editWidthFor('standard', '你好', 200), `min(56px, ${CAP})`);
assert.equal(editWidthFor('extended', 'hi', 200), '100%');
assert.equal(editWidthFor('custom', 'hi', 200), '300px');
assert.equal(editWidthFor('standard', 'x'.repeat(200), 200), `min(1628px, ${CAP})`);
assert.equal(editWidthFor('compact', 'hi', 200), `min(max(200px, 44px), ${CAP})`);

console.log('✓ 既有宽度档位语义未变');

// ---------------------------------------------------------------------------
// [Test 2] 编辑框实际宽度有下限：短文本不得窄于按钮行
// ---------------------------------------------------------------------------
console.log('[Test 2] 短文本编辑框最小宽度...');

const MIN = 168; // 两枚按钮约 116~120px + 左右 padding 28px + 余量
assert.ok(EDIT_BOX_MIN_WIDTH >= MIN, `编辑框最小宽常量只有 ${EDIT_BOX_MIN_WIDTH}px，短于按钮行所需 ${MIN}px`);
const numericWidth = (expr) => {
  const m = /^min\((\d+)px,\s*min\(80%/.exec(expr);
  return m ? Number(m[1]) : null;
};

for (const [mode, text, initW] of [
  ['standard', '', 34],
  ['standard', 'hi', 34],
  ['standard', '你好', 34],
  ['standard', '在吗？', 34],
  ['compact', 'hi', 34],
]) {
  const width = editBoxWidthFor(mode, text, initW);
  const n = numericWidth(width);
  assert.notEqual(n, null, `${mode} / "${text}" 应解析出 px 宽度，实际 ${width}`);
  assert.ok(n >= MIN, `${mode} / "${text}" 编辑框只有 ${n}px，短于按钮行所需 ${MIN}px`);
}

// 短文本不再随每个字符跳宽
const widths = ['你', '你好', '你好吗', '你好吗呀'].map(t => numericWidth(editBoxWidthFor('standard', t, 34)));
assert.ok(widths.every(w => w === widths[0]), `短文本编辑框宽度必须稳定，实际 ${widths.join('/')}`);

console.log('✓ 短文本编辑框不小于按钮行且宽度稳定');

// ---------------------------------------------------------------------------
// [Test 3] 长文本仍按内容增长并收在 80% 上限
// ---------------------------------------------------------------------------
console.log('[Test 3] 长文本宽度...');

const long = editBoxWidthFor('standard', '汉'.repeat(30), 34);
assert.equal(long, `min(448px, ${CAP})`);
assert.equal(editBoxWidthFor('extended', 'hi', 34), '100%');
assert.equal(editBoxWidthFor('custom', 'hi', 34), '300px');
assert.equal(editBoxWidthFor('compact', '汉'.repeat(30), 200), `min(448px, ${CAP})`);

console.log('✓ 长文本与其余档位不受影响');

// ---------------------------------------------------------------------------
// [Test 4] 编辑框 style 用数值宽度，杜绝带图缩略图的 NaNpx
// ---------------------------------------------------------------------------
console.log('[Test 4] 编辑框宽度必须是可做算术的 px 数值...');

const boxStart = src.indexOf('var editBoxStyle = {');
assert.notEqual(boxStart, -1, '找不到 editBoxStyle');
const boxBlock = src.slice(boxStart, src.indexOf('};', boxStart));
assert.match(boxBlock, /width:\s*editBoxW/, '编辑框宽度必须来自 editBoxWidthFor 的结果');
assert.match(boxBlock, /minWidth:\s*EDIT_BOX_MIN_WIDTH/, '编辑框必须声明 minWidth 兜底');
assert.ok(!/maxWidth:\s*editBoxW/.test(boxBlock), '不得再把字符串 CSS 表达式塞给 maxWidth（缩略图算术会得到 NaNpx）');

const thumbLine = src.split('\n').find(l => l.includes('var dzThumbUsual ='));
assert.ok(thumbLine, '找不到缩略图尺寸计算');
assert.ok(!/editBoxW\s*-/.test(thumbLine), '缩略图尺寸不得再对字符串宽度做减法');
assert.match(src, /var editBoxWpx\s*=/, '必须提供数值宽度供缩略图尺寸计算使用');

console.log('✓ 编辑框与缩略图共用数值宽度');

console.log('\n======================================');
console.log('✔ 短消息编辑框几何：全部通过');
console.log('======================================\n');
