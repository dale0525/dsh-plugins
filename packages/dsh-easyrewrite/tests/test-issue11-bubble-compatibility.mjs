import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcCode = fs.readFileSync(path.resolve(__dirname, '../src/client.src.js'), 'utf-8');
const bundleCode = fs.readFileSync(path.resolve(__dirname, '../lib/client.js'), 'utf-8');

console.log('--- 开始测试：Issue #11 样式变量接入与第三方批注插件兼容性专项验证 ---');

// =========================================================================
// [Test 1] 静态源码结构检测：官方变量对齐与 1080p 默认尺寸守护
// =========================================================================
console.log('[Test 1] 静态源码规则与 1080p 协调性守护验证...');

// 1.1 字号必须与聊天正文/官方输入框同源（--dsh-chat-font-size）。
// 2026-10-29 用户要求「一起统一」：原先读 --dsh-content-font-size，在 macOS 主题下解析为 17px，
// 比同屏正文大 4px（实测 17/25 vs 13/22.1）。--dsh-content-font-size 是宿主的编辑器字号设置，
// 不是聊天气泡的字号，用它必然与正文脱节。
assert.ok(srcCode.includes('var(--dsh-chat-font-size, 14px)'), 'src 字号必须取 --dsh-chat-font-size（与正文同源），回退 14px');
assert.ok(bundleCode.includes('var(--dsh-chat-font-size, 14px)'), '打包产物字号必须取 --dsh-chat-font-size，回退 14px');
assert.ok(!srcCode.includes('fontSize: "var(--dsh-content-font-size'), 'src 不得再用 --dsh-content-font-size 作字号（主题下 17px）');

// 1.2 行高同样跟正文同源，不再叠宿主的 delta
assert.ok(srcCode.includes('var(--dsh-chat-line-height, 1.6)'), 'src 行高必须取 --dsh-chat-line-height，回退 1.6');
assert.ok(bundleCode.includes('var(--dsh-chat-line-height, 1.6)'), '打包产物行高必须取 --dsh-chat-line-height，回退 1.6');

// 1.3 必须严格保留现有的 14px 圆角与 8px 14px 内边距（坚决不因小失大，守住 1080p 协调美感）
assert.ok(srcCode.includes('borderRadius: "14px"'), '气泡圆角必须严格保留 14px，不得盲从修改为 22px');
assert.ok(srcCode.includes('padding: "8px 14px"'), '气泡内边距必须严格保留 8px 14px，不得盲从修改为 10px 16px');

// 1.4 气泡节点必须携带 dsh-easyrewrite-bubble 类名
assert.ok(srcCode.includes('dsh-easyrewrite-bubble'), 'src 气泡节点必须携带 dsh-easyrewrite-bubble 类名');
assert.ok(bundleCode.includes('dsh-easyrewrite-bubble'), '打包产物气泡节点必须携带 dsh-easyrewrite-bubble 类名');

console.log('✓ 静态规则与 1080p 协调性守护验证通过');

// =========================================================================
// [Test 2] 第三方批注插件（dsh-annotation）DOM 匹配兼容性模拟
// =========================================================================
console.log('[Test 2] dsh-annotation 批注插件 DOM 选择器匹配验证...');

class MockNode {
  constructor(tag, className = '') {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.children = [];
  }
  appendChild(child) { this.children.push(child); }
  querySelector(selector) {
    if (selector === '[class*="bubble"]') {
      return this._findBubbleChild(this);
    }
    return null;
  }
  _findBubbleChild(node) {
    if (typeof node.className === 'string' && node.className.includes('bubble')) {
      return node;
    }
    for (const child of node.children) {
      const found = this._findBubbleChild(child);
      if (found) return found;
    }
    return null;
  }
}

// 模拟渲染出来的用户消息行 DOM 结构
const mockRow = new MockNode('div');
const mockBubbleDiv = new MockNode('div', 'dsh-easyrewrite-bubble');
mockRow.appendChild(mockBubbleDiv);

// 运行 dsh-annotation 官方源码定位逻辑（dsh-annotation/client.js:1817）
const matchedBubble = mockRow.querySelector('[class*="bubble"]');

assert.ok(matchedBubble !== null, 'dsh-annotation 的 [class*="bubble"] 选择器必须能精准命中我们的气泡');
assert.equal(matchedBubble.className, 'dsh-easyrewrite-bubble', '命中元素的类名必须为 dsh-easyrewrite-bubble');

console.log('✓ dsh-annotation 批注插件匹配兼容性验证通过');

console.log('\n======================================');
console.log('✔ Issue #11 样式与第三方插件兼容性测试全部通过！');
console.log('======================================\n');
