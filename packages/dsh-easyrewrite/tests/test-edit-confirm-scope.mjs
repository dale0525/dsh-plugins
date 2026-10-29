/**
 * test-edit-confirm-scope.mjs — 「编辑历史消息后点确认没反应」回归钉。
 *
 * 实测故障（2026-10-29，宿主 0.2.1-rc.2）：点编辑态的「确定」后气泡不消失、
 * 控制台报 `computeRecallBoundary is not defined`，编辑重发在第一步就抛错并被
 * catch 吞成一行错误日志，界面表现为「点了没反应」。
 *
 * 成因：撤回/编辑共用的四个辅助函数被写在 `RecallBanner` 组件体内，
 * 只有 `RecallBanner` 自己的闭包能看见；`confirmEdit` 属于另一个组件
 * （`UserBubbleView`），对它不可见。这类错误没有任何构建期检查能发现——
 * client.src.js 是模板字符串形式的单文件 bundle，不经过 TS 作用域分析。
 *
 * 所以这里按**作用域深度**钉住它们：声明位置的括号深度必须等于模块级函数
 * （`function RecallBanner` 外层）的深度，也就是不能嵌在任何组件体内。
 * 运行方式：node tests/test-edit-confirm-scope.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../src/client.src.js'), 'utf-8');
const lines = src.split('\n');

/** 每行行首的括号净深度（`{` 加、`}` 减）。 */
function depthAt(index) {
  let depth = 0;
  for (let i = 0; i < index; i += 1) depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
  return depth;
}

/** 找到函数声明的行号（0 基）。找不到直接失败——改名后必须同步更新本测试。 */
function declarationLine(name) {
  const pattern = new RegExp(`^\\s*(?:async\\s+)?function ${name}\\s*\\(`);
  const index = lines.findIndex(line => pattern.test(line));
  assert.notEqual(index, -1, `src/client.src.js 里找不到函数 ${name} 的声明（改名了？本测试需同步更新）`);
  return index;
}

console.log('--- 开始测试：编辑重发辅助函数的作用域可达性 ---');

// 基准：RecallBanner 是模块级组件，它所在深度即「模块作用域」。
const moduleDepth = depthAt(declarationLine('RecallBanner'));

// 四个函数都被 confirmEdit / doRecallThenSend 跨组件调用，因此必须与 RecallBanner 同级。
for (const name of ['computeRecallBoundary', 'snapshotHasMore', 'loadThroughTarget', 'readCurrentComposerText']) {
  const line = declarationLine(name);
  assert.equal(
    depthAt(line),
    moduleDepth,
    `${name} 必须声明在模块作用域（与 RecallBanner 同级）；嵌在组件体内会让另一组件里的调用点抛 ReferenceError`,
  );
}

console.log('✓ 四个跨组件辅助函数均位于模块作用域');

/** 从函数声明行起按括号配对取出完整函数体文本。 */
function bodyOf(name) {
  const start = declarationLine(name);
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    if (i > start && depth === 0) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`${name} 的函数体没有闭合`);
}

// confirmEdit 与 doRecallThenSend 都真的在调用它们（防止「提升了但没人用」的空洞修复）。
for (const [caller, callee] of [
  ['confirmEdit', 'computeRecallBoundary'],
  ['confirmEdit', 'loadThroughTarget'],
  ['confirmEdit', 'readCurrentComposerText'],
  ['doRecallThenSend', 'computeRecallBoundary'],
]) {
  assert.ok(
    new RegExp(`\\b${callee}\\(`).test(bodyOf(caller)),
    `${caller} 必须调用 ${callee}；调用点消失说明这条路径被改坏了`,
  );
}

console.log('✓ 跨组件调用点存在');

// 第二个同源缺陷（2026-10-29 实测）：useChat / useSession 是 React hook，只在渲染期合法。
// 边界计算跑在点击处理器里，直接调它会抛 React #321（Invalid hook call），catch 吞掉后
// 边界恒为 null —— 表现为「编辑任何一条消息都重置整个对话」。
for (const handler of ['confirmEdit', 'doRecallThenSend']) {
  const body = bodyOf(handler);
  assert.ok(
    !/getChatSnapshot\(|\.useChat\(|\.useSession\(/.test(body),
    `${handler} 是点击处理器，不得直接调 hook；快照应在渲染期取好存进 ref`,
  );
  assert.ok(
    /chatSnapRef\.current/.test(body),
    `${handler} 必须读渲染期缓存的快照（chatSnapRef.current）`,
  );
}

// 缓存本身必须真的在渲染期填充，否则 ref 恒为 null、上一条断言形同虚设。
assert.match(
  bodyOf('UserBubbleView'),
  /var chatSnapRef = useChatSnapshotRef\(props,/,
  'chatSnapRef 必须在 UserBubbleView 渲染期由 useChatSnapshotRef 填充',
);

console.log('✓ hook 只在渲染期调用');
