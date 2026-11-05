/**
 * test-recall-immediate-truncation.mjs — 撤回「确认即删除」契约。
 *
 * 旧行为：确认只写 pending(type=recall) + 回填输入框 + 显示「正在修改」条，
 * 真正截断被推迟到用户下一次按「发送」，发送时还要把原文本自动重发一遍。
 * 用户判定这与「编辑」没有本质区别，要求改成：确认后立即删除该消息及其后
 * 全部消息（fork 到前置闭合回合 + 归档 + 打开新会话），不回填、不待定、不重发。
 *
 * 两类断言：
 *  1) 真执行模块级 truncateAtMessage（注入 io mock），验证调用序列与零重发；
 *  2) 静态切片验证确认回调/无确认旁路都直连截断，且旧待定态机制已清除。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../src/client.src.js'), 'utf-8');
const lines = src.split('\n');

console.log('--- 开始测试：撤回确认即截断 ---');

// ---------------------------------------------------------------------------
// 工具：按括号配对抽出函数体（client.src.js 是单文件 bundle，无法 import）
// ---------------------------------------------------------------------------
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

function declarationLine(name) {
  const pattern = new RegExp(`^\\s*(?:async\\s+)?function ${name}\\s*\\(`);
  const index = lines.findIndex(line => pattern.test(line));
  assert.notEqual(index, -1, `找不到函数 ${name}`);
  return index;
}

function depthAt(index) {
  let depth = 0;
  for (let i = 0; i < index; i += 1) depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
  return depth;
}

// ---------------------------------------------------------------------------
// [Test 1] truncateAtMessage 必须是模块级函数，且被确认回调与无确认旁路调用
// ---------------------------------------------------------------------------
console.log('[Test 1] 截断函数作用域与调用点...');

const moduleDepth = depthAt(declarationLine('UserBubbleView'));
assert.equal(
  depthAt(declarationLine('truncateAtMessage')),
  moduleDepth,
  'truncateAtMessage 必须在模块作用域（与 UserBubbleView 同级）；它要被确认回调与快捷键路径共用',
);

const viewBody = bodyOf('UserBubbleView');
assert.match(viewBody, /\bdoRecall\(/, 'UserBubbleView 必须定义并调用 doRecall（确认即截断的入口）');
assert.ok(
  !/chatSnapRef/.test(bodyOf('truncateAtMessage')),
  'truncateAtMessage 不得引用组件局部的 chatSnapRef；快照须经 io 注入',
);

console.log('✓ 截断函数位于模块作用域，确认回调直连截断');

// ---------------------------------------------------------------------------
// [Test 2] 真执行：有边界 → fork → 归档 → 打开新会话，且不发送任何消息
// ---------------------------------------------------------------------------
console.log('[Test 2] 即时截断的调用序列（真执行）...');

const truncateAtMessage = new Function(`${bodyOf('truncateAtMessage')}; return truncateAtMessage;`)();

function makeIo(overrides = {}) {
  const calls = [];
  const io = {
    computeBoundary: (seq, snap) => ({ atSeq: 42 }),
    snapshot: () => ({ turns: [] }),
    loadThrough: async () => true,
    fork: async (atSeq) => { calls.push(['fork', atSeq]); return 'new-session'; },
    archive: async () => { calls.push(['archive']); },
    openSession: (id) => { calls.push(['open', id]); return true; },
    resetConversation: (mode) => { calls.push(['reset', mode]); },
    reportError: (msg) => { calls.push(['error', msg]); },
    messages: { errGeneric: 'generic', turnOpen: 'turn-open' },
    // 下面三个是旧「重发」语义的通道；新实现一旦调用就会出现在 calls 里
    setDraft: (text) => { calls.push(['setDraft', text]); },
    submit: () => { calls.push(['submit']); },
    writeResume: (payload) => { calls.push(['resume', payload]); },
    ...overrides,
  };
  return { io, calls };
}

{
  const { io, calls } = makeIo();
  const result = await truncateAtMessage(io, 100);
  assert.deepEqual(result, { ok: true, mode: 'fork', newId: 'new-session' });
  assert.deepEqual(calls, [['fork', 42], ['archive'], ['open', 'new-session']],
    '确认后必须立刻 fork(前置闭合回合) → 归档原会话 → 打开新会话，顺序不可变');
  assert.ok(!calls.some(c => ['setDraft', 'submit', 'resume'].includes(c[0])),
    '撤回不得回填草稿、不得自动提交、不得写 resume-send 重发标记');
}

console.log('✓ 确认后立刻截断，无任何重发动作');

// ---------------------------------------------------------------------------
// [Test 3] 窗口外目标：先 loadThrough 再重算边界
// ---------------------------------------------------------------------------
console.log('[Test 3] 窗口外目标的边界重算...');

{
  let round = 0;
  const { io, calls } = makeIo({
    computeBoundary: () => (++round === 1 ? { code: 'host-fallback' } : { atSeq: 17 }),
    loadThrough: async (seq) => { calls.push(['loadThrough', seq]); return true; },
  });
  const result = await truncateAtMessage(io, 900);
  assert.deepEqual(result, { ok: true, mode: 'fork', newId: 'new-session' });
  assert.deepEqual(calls, [['loadThrough', 900], ['fork', 17], ['archive'], ['open', 'new-session']]);
}

console.log('✓ 窗口外边界正确重算');

// ---------------------------------------------------------------------------
// [Test 4] 会话首条（无前置边界）：打开空白新会话，仍不自动发送
// ---------------------------------------------------------------------------
console.log('[Test 4] 首条消息无边界...');

for (const boundary of [null, { code: 'no-boundary' }]) {
  const { io, calls } = makeIo({ computeBoundary: () => boundary });
  const result = await truncateAtMessage(io, 1);
  assert.deepEqual(result, { ok: true, mode: 'reset' });
  assert.deepEqual(calls, [['reset', 'recall']],
    '首条消息只能以 recall 模式重置（resetConversation 仅在 mode==="edit" 时写自动发送标记）');
  assert.ok(!calls.some(c => ['fork', 'setDraft', 'submit', 'resume'].includes(c[0])));
}

{
  const { io, calls } = makeIo({
    fork: async () => { throw new Error('session has no completed turn to fork from'); },
  });
  const result = await truncateAtMessage(io, 5);
  assert.deepEqual(result, { ok: true, mode: 'reset' });
  assert.deepEqual(calls, [['reset', 'recall']]);
}

console.log('✓ 首条消息只清空会话，不产生新消息');

// ---------------------------------------------------------------------------
// [Test 5] 失败分支：给出可见提示，不留下半截状态
// ---------------------------------------------------------------------------
console.log('[Test 5] 失败分支...');

{
  const { io, calls } = makeIo({ computeBoundary: () => ({ code: 'unknown' }) });
  const result = await truncateAtMessage(io, 10);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, [['error', 'generic']]);
}
{
  const { io, calls } = makeIo({
    fork: async () => { throw new Error('turn has not completed the turn'); },
  });
  const result = await truncateAtMessage(io, 10);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, [['error', 'turn-open']], '回合未结束必须提示等待，不能归档或切会话');
}
{
  const { io, calls } = makeIo({ openSession: (id) => { calls.push(['open', id]); return false; } });
  const result = await truncateAtMessage(io, 10);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, [['fork', 42], ['archive'], ['open', 'new-session'], ['error', 'generic']]);
}

console.log('✓ 失败分支可见且不残留状态');

// ---------------------------------------------------------------------------
// [Test 6] 静态：确认回调与无确认旁路都不得再进入「待发送」态
// ---------------------------------------------------------------------------
console.log('[Test 6] 旧待定态机制已清除...');

const onConfirmIdx = src.indexOf('onConfirm: function () {');
assert.notEqual(onConfirmIdx, -1, '确认胶囊的 onConfirm 必须存在');
const onConfirmBody = src.slice(onConfirmIdx, src.indexOf('onCancel:', onConfirmIdx));
assert.match(onConfirmBody, /doRecall\(/, '确认回调必须直接触发截断');
assert.ok(!/writePending|setDraft|resume-send|type: "recall"/.test(onConfirmBody),
  '确认回调不得写 pending、回填草稿、写重发标记或创建撤回待定');

for (const dead of [
  'doRecallThenSend',
  'data-dsh-easyrewrite="recall-bar"',
  'L.modifying',
  'L.greyText',
  'L.preparingSession',
  'onKeyDownCapture',
  'onClickCapture',
  'pending.type === "recall"',
  'type: "recall"',
  'rebuildDraftAttachments',
  'recallVisualMode',
  'draftConflictMode',
]) {
  assert.ok(!src.includes(dead), `旧待定态机制 "${dead}" 必须已删除`);
}

// resume-send 只服务于编辑重发：写入点只剩 resetConversation(edit) 与 confirmEdit 两处
const resumeWrites = src.match(/localStorage\.setItem\("dsh-easyrewrite:resume-send:" \+ /g) ?? [];
assert.equal(resumeWrites.length, 2, 'resume-send 只能由编辑的两条路径写入，撤回不得写入');
// resetConversation 同时被撤回调用；撤回模式必须被门控挡住，否则首条消息撤回后又自动发出一条
assert.ok(
  /if \(mode === "edit" && typeof text === "string"\)[\s\S]{0,240}?localStorage\.setItem\("dsh-easyrewrite:resume-send:" \+ newId/.test(src),
  'resetConversation 的 resume 写入必须限定 mode === "edit"（recall 模式只打开空白会话）',
);

console.log('✓ 旧待定态（正在修改条/灰气泡/发送拦截/回填）已彻底清除');

console.log('\n======================================');
console.log('✔ 撤回确认即截断：全部通过');
console.log('======================================\n');
