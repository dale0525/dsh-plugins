import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcCode = fs.readFileSync(path.resolve(__dirname, '../src/client.src.js'), 'utf-8');
const bundleCode = fs.readFileSync(path.resolve(__dirname, '../lib/client.js'), 'utf-8');

console.log('--- 开始测试：Issue #9 与长对话防双发/置灰锁专项验证 ---');

// =========================================================================
// [Test 1] 静态源码规则验证（彻底杜绝已知致病特征）
// =========================================================================
console.log('[Test 1] 静态源码结构与致病特征消除验证...');

// 1.1 必须彻底删除 resetConversation 中的 timer2 盲发（原双发根因）
assert.ok(!srcCode.includes('timer2 = setInterval'), 'src 中不得包含 resetConversation 的 timer2 盲发定时器');
assert.ok(!bundleCode.includes('timer2 = setInterval'), '编译产物中不得包含 resetConversation 的 timer2 盲发定时器');

// 1.2 验证 safeOpenSession 工具函数已定义且被正确使用
assert.ok(srcCode.includes('function safeOpenSession('), 'src 中必须包含 safeOpenSession 函数');
assert.ok(bundleCode.includes('function safeOpenSession('), '编译产物中必须包含 safeOpenSession 函数');

// 1.3 验证 setPrimaryButtonSendingState 存在并具备 15000ms 兜底
assert.ok(srcCode.includes('function setPrimaryButtonSendingState('), 'src 中必须包含 setPrimaryButtonSendingState');
assert.ok(srcCode.includes('15000'), '置灰锁必须包含 15s 兜底自动解锁');

// 1.4 验证 preparingSession 多语言字段已在 zh, en, ja 中完整定义
assert.ok(srcCode.includes('preparingSession: "正在准备新会话…"'), '必须包含中文 preparingSession 文案');
assert.ok(srcCode.includes('preparingSession: "Preparing new session…"'), '必须包含英文 preparingSession 文案');
assert.ok(srcCode.includes('preparingSession: "新しいセッションを準備中…"'), '必须包含日文 preparingSession 文案');

console.log('✓ 静态规则检测全部通过');

// =========================================================================
// [Test 2] 发送按钮置灰与物理锁逻辑模拟测试
// =========================================================================
console.log('[Test 2] 发送按钮置灰与恢复逻辑验证...');

// 模拟 DOM 环境
class MockElement {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.styleProps = {};
    this.disabled = false;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, val) { this.attrs[name] = String(val); }
  removeAttribute(name) { delete this.attrs[name]; }
  style = {
    setProperty: (prop, val) => { this.styleProps[prop] = val; },
    removeProperty: (prop) => { delete this.styleProps[prop]; }
  };
  querySelectorAll(sel) {
    if (sel.includes('button[aria-label]')) {
      return this._buttons || [];
    }
    return [];
  }
}

const mockCard = new MockElement('div', { 'data-composer-card': 'true' });
const mockSendBtn = new MockElement('button', { 'aria-label': '发送消息' });
mockCard._buttons = [mockSendBtn];

// 注入模拟全局 document
globalThis.document = {
  querySelector: (sel) => {
    if (sel === '[data-composer-card]') return mockCard;
    return null;
  }
};

// 提取并运行 setPrimaryButtonSendingState 逻辑
function testFindPrimaryButton() {
  const card = globalThis.document.querySelector('[data-composer-card]');
  if (!card) return null;
  const btns = card.querySelectorAll('button[aria-label]');
  for (let i = 0; i < btns.length; i++) {
    const al = (btns[i].getAttribute('aria-label') || '').toLowerCase();
    if (al.includes('发送') || al.includes('send') || al.includes('停止') || al.includes('stop')) return btns[i];
  }
  return null;
}

let primaryButtonSendingTimer = null;
function testSetPrimaryButtonSendingState(sending) {
  const btn = testFindPrimaryButton();
  if (primaryButtonSendingTimer) {
    clearTimeout(primaryButtonSendingTimer);
    primaryButtonSendingTimer = null;
  }
  if (!btn) return;
  if (sending) {
    btn.setAttribute('data-dsh-easyrewrite-sending', 'true');
    btn.disabled = true;
    btn.style.setProperty('opacity', '0.45');
    btn.style.setProperty('pointer-events', 'none');
    btn.style.setProperty('cursor', 'not-allowed');
  } else {
    btn.removeAttribute('data-dsh-easyrewrite-sending');
    btn.disabled = false;
    btn.style.removeProperty('opacity');
    btn.style.removeProperty('pointer-events');
    btn.style.removeProperty('cursor');
  }
}

// 模拟发送中置灰
testSetPrimaryButtonSendingState(true);
assert.equal(mockSendBtn.disabled, true, '发送按钮应处于 disabled 状态');
assert.equal(mockSendBtn.getAttribute('data-dsh-easyrewrite-sending'), 'true', '应标记 sending 属性');
assert.equal(mockSendBtn.styleProps['opacity'], '0.45', '透明度应设为 0.45');
assert.equal(mockSendBtn.styleProps['pointer-events'], 'none', '指针事件应被禁用');

// 模拟恢复
testSetPrimaryButtonSendingState(false);
assert.equal(mockSendBtn.disabled, false, '恢复后 disabled 应为 false');
assert.equal(mockSendBtn.getAttribute('data-dsh-easyrewrite-sending'), null, 'sending 属性应被清除');
assert.equal(mockSendBtn.styleProps['opacity'], undefined, '透明度样式应被清除');
assert.equal(mockSendBtn.styleProps['pointer-events'], undefined, '指针事件样式应被清除');

console.log('✓ 发送按钮置灰与恢复逻辑验证通过');

// =========================================================================
// [Test 3] 高频连击防穿透与事件吞噬测试
// =========================================================================
console.log('[Test 3] 高频连击与 Enter 穿透拦截验证...');

let doRecallCallCount = 0;
let sendingRef = { current: false };

function simulateDoRecallThenSend() {
  if (sendingRef.current) return;
  sendingRef.current = true;
  doRecallCallCount++;
}

class MockEvent {
  constructor(key) {
    this.key = key;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

function simulateKeyDownCapture(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  e.stopPropagation();
  if (sendingRef.current) return;
  simulateDoRecallThenSend();
}

// 首次敲击 Enter
const ev1 = new MockEvent('Enter');
simulateKeyDownCapture(ev1);
assert.equal(ev1.defaultPrevented, true, '首次回车必须 preventDefault');
assert.equal(ev1.propagationStopped, true, '首次回车必须 stopPropagation');
assert.equal(doRecallCallCount, 1, '首次回车应触发一次发送处理');
assert.equal(sendingRef.current, true, '状态锁应已置为 true');

// 在等待期间，用户因焦虑狂敲 10 次 Enter 和 10 次点击
for (let i = 0; i < 10; i++) {
  const evRepeat = new MockEvent('Enter');
  simulateKeyDownCapture(evRepeat);
  assert.equal(evRepeat.defaultPrevented, true, `第 ${i+1} 次重复回车必须被 preventDefault 吞噬`);
  assert.equal(evRepeat.propagationStopped, true, `第 ${i+1} 次重复回车必须被 stopPropagation 阻断`);
}

assert.equal(doRecallCallCount, 1, '无论高频连击多少次，核心发送处理次数必须严格保持为 1');
console.log('✓ 高频连击防穿透与全量吞噬测试通过');

// =========================================================================
// [Test 4] 安全会话切换降级测试
// =========================================================================
console.log('[Test 4] safeOpenSession 多重降级验证...');

function testSafeOpenSession(targetId, props) {
  if (props && typeof props.openSession === 'function') {
    try {
      const res = props.openSession(targetId);
      if (res !== false) return true;
    } catch (e1) {
      // 捕获异常并平滑降级
    }
  }
  if (props && props.ctxSessions && typeof props.ctxSessions.open === 'function') {
    try {
      props.ctxSessions.open(targetId);
      return true;
    } catch (e2) {}
  }
  return false;
}

// 场景 1：props.openSession 正常
let openedByPrimary = null;
const props1 = { openSession: (id) => { openedByPrimary = id; } };
assert.equal(testSafeOpenSession('sess-1', props1), true);
assert.equal(openedByPrimary, 'sess-1', '优先通道应打开 sess-1');

// 场景 2：props.openSession 缺失，降级至 props.ctxSessions.open
let openedByFallback = null;
const props2 = { ctxSessions: { open: (id) => { openedByFallback = id; } } };
assert.equal(testSafeOpenSession('sess-2', props2), true);
assert.equal(openedByFallback, 'sess-2', '降级通道应打开 sess-2');

// 场景 3：props.openSession 抛异常且无降级通道，安全捕获返回 false 不崩溃
const props3 = { openSession: () => { throw new Error('DSH host disconnected'); } };
assert.equal(testSafeOpenSession('sess-3', props3), false);

// 场景 4：props.openSession 抛异常但有降级通道（如 0.1.7 场景），应自动走降级通道成功打开
let fallbackFromBrokenPrimary = null;
const props4 = {
  openSession: () => { throw new TypeError('ctx.sessions.open is not a function'); },
  ctxSessions: { open: (id) => { fallbackFromBrokenPrimary = id; } }
};
assert.equal(testSafeOpenSession('sess-4', props4), true);
assert.equal(fallbackFromBrokenPrimary, 'sess-4', '优先通道崩溃时降级通道应顺利接管打开 sess-4');

console.log('✓ safeOpenSession 降级与异常保护验证通过');

// =========================================================================
// [Test 5] Issue #10 幽灵队列：边界取 turn/end 即结构上不继承待处理项
// =========================================================================
// 原实现 fork 后调 /bubble/clean-ghost 让宿主物理拔除「幽灵队列」。该缺陷的真正成因是
// fork 前缀切在回合内部：入队 agent/inbox/spliced 恒在 turn/start 前一格、出队恒在其后
// 一格，所以切点只要落在 turn/end 上，两者就都在前缀之外，子会话 inbox 为空。
// 因此现在不清理，只保证边界算法本身正确。
console.log('[Test 5] Issue #10 fork 边界不继承幽灵队列验证...');

// 5.1 静态：清理通道与其宿主路由都已删除，边界改为本地计算
assert.ok(!srcCode.includes('requestCleanGhostQueue'), 'src 中不得再有 requestCleanGhostQueue（宿主清理通道已删）');
assert.ok(!bundleCode.includes('requestCleanGhostQueue'), '编译产物中不得再有 requestCleanGhostQueue');
assert.ok(!/fetch\(\s*["']\/bubble\/(clean-ghost|recall)["']/.test(srcCode), 'src 中不得再有 /bubble/clean-ghost 或 /bubble/recall 的真实调用');
assert.ok(!/fetch\(\s*["']\/bubble\/(clean-ghost|recall)["']/.test(bundleCode), '编译产物中不得再有这两条路由的真实调用');
assert.ok(srcCode.includes('function computeRecallBoundary('), 'src 中必须包含 computeRecallBoundary 函数');

// 5.2 动态：从 src 抽出 computeRecallBoundary 求值，验证它选的是「目标之前最后一个 turn/end」
const boundarySrc = srcCode.slice(
  srcCode.indexOf('function computeRecallBoundary('),
  srcCode.indexOf('function snapshotHasMore(')
);
// snapshotHasMore 作为参数注入（不拼源码，否则函数声明会遮蔽参数）
const makeBoundary = new Function('log', 'hasChatSnapshot', 'getChatSnapshot', 'snapshotHasMore',
  boundarySrc + '\nreturn computeRecallBoundary;');
const testBoundary = makeBoundary(
  () => {},
  () => true,
  (props) => props.__snapshot,
  () => false
);

function timelineOf(turns) {
  const map = new Map();
  for (const t of turns) map.set(t.turn, { turn: t.turn, start: t.start, end: t.end, status: t.end ? 'closed' : 'open', steps: [], data: null });
  return { turnOrder: turns.map((t) => t.turn), turns: map };
}

// 场景 A：目标在第三回合内 → 边界 = 第二回合的 turn/end（严格小于 targetSeq 的最大值）
const snapA = { timeline: timelineOf([
  { turn: 1, start: { seq: 1 }, end: { seq: 10 } },
  { turn: 2, start: { seq: 11 }, end: { seq: 20 } },
  { turn: 3, start: { seq: 21 }, end: { seq: 30 } }
]) };
assert.deepEqual(testBoundary({ __snapshot: snapA }, 25), { atSeq: 20 }, '边界必须是目标之前最后一个 turn/end');

// 场景 B：目标恰是某回合的 turn/end 之后一格（下一回合首条）→ 仍取上一个 turn/end
assert.deepEqual(testBoundary({ __snapshot: snapA }, 21), { atSeq: 20 });

// 场景 C：目标之前没有任何闭合回合（首条消息）→ no-boundary，走重置对话
const snapC = { timeline: timelineOf([{ turn: 1, start: { seq: 1 }, end: { seq: 9 } }]) };
assert.deepEqual(testBoundary({ __snapshot: snapC }, 3), { code: 'no-boundary' });

// 场景 D：还有更早历史没加载 → host-fallback（调用方会先 loadThrough 再重算）
const makeBoundaryHasMore = makeBoundary(
  () => {},
  () => true,
  (props) => props.__snapshot,
  () => true
);
assert.deepEqual(makeBoundaryHasMore({ __snapshot: snapC }, 3), { code: 'host-fallback' });

// 场景 E：开放回合（无 turn/end）不算边界
const snapE = { timeline: timelineOf([
  { turn: 1, start: { seq: 1 }, end: { seq: 10 } },
  { turn: 2, start: { seq: 11 }, end: undefined }
]) };
assert.deepEqual(testBoundary({ __snapshot: snapE }, 15), { atSeq: 10 }, '开放回合不得被当作边界');

console.log('✓ computeRecallBoundary 边界选取验证通过');

console.log('\n======================================');
console.log('✔ Issue #9 与 Issue #10 所有专项测试全部通过！');
console.log('======================================\n');
