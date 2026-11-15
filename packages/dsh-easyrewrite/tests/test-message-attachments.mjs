/**
 * test-message-attachments.mjs — 用户消息里的图片/文件必须出现在气泡里。
 *
 * 故障（2026-11-15 实测）：上传图片 + 配文字发送后，聊天里只剩文字气泡，
 * 图片与文件都不显示，但 agent 收得到——说明问题只在渲染侧。
 *
 * 成因：本插件用 `priority: -1` 整覆盖了 keyed 槽 `conversation.chat.node#user`，
 * 而宿主 0.2.1 把用户消息的附件改由自己的 `UserContent` 渲染（图片走子槽
 * `conversation.chat.user.images`，文件是内联的文件卡）。覆盖之后这两条通道
 * 一起消失；插件当时依赖的 `renderMessageImages` prop 在宿主里已整个删除
 * （全量 grep 零命中），取不到就静默 `return null`，于是只剩文字。
 *
 * 断言方式是**真渲染**：用 jsdom + react-dom/client 把 UserBubbleView 挂到
 * 真实 DOM 上，从渲染结果里取 <img> 与文件卡，而不是断言源码里出现了某个
 * 字符串（那种断言在旧实现下也能全绿）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(__dirname, '../lib/client.js');
const bundleCode = fs.readFileSync(bundlePath, 'utf-8');

// react / react-dom / jsdom 从同 workspace 的 dsh-plugins-shared-client 解析：
// easyrewrite 自己只装构建依赖，共享客户端包提供同一份 pnpm store 实例。
const sharedClient = path.resolve(__dirname, '../../dsh-plugins-shared-client/package.json');
const requireShared = createRequire(sharedClient);
const React = requireShared('react');
const { createRoot } = requireShared('react-dom/client');
const { flushSync } = requireShared('react-dom');
const { JSDOM } = requireShared('jsdom');

console.log('--- 开始测试：用户消息附件渲染（图片 / 文件） ---');

// ---------------------------------------------------------------------------
// 一个真实的浏览器环境：插件在模块顶层就摸 window/document/localStorage
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/'
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;

let loaded = null;
globalThis.window.__ModuleLoader__ = { load: (def) => { loaded = def; } };

// 只解析本测试需要的模块：react 用真的，其余宿主/基元给最小替身。
const fakeRequire = (mod) => {
  if (mod === 'react') return React;
  if (mod === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      IconCheckOutline16: () => null,
      IconCopyOutline16: () => null,
      IconChevronLeftOutline14: () => null,
      IconChevronRightOutline14: () => null,
      FileTypeIcon: () => null,
      fileSizeText: (bytes) => `${Math.round(bytes / 1024)} KB`,
      fileExtension: (name) => (name.includes('.') ? name.split('.').pop() : ''),
      Tooltip: ({ children }) => children
    };
  }
  if (mod === '@logictan/dsh-plugins-shared-client') return {};
  throw new Error(`测试替身缺模块：${mod}`);
};

// 插件 factory 内部会 ctx.effect(...) / ctx.slots.inject(...) 注册槽位；
// 本测试只取组件，用最小 ctx 让她走完注册路径。
const registered = [];
const ctx = {
  slots: {
    inject: (_name, fn) => {
      const r = fn();
      return typeof r === 'function' ? r : () => {};
    },
    register: (opts, component) => {
      registered.push({ opts, component });
      return () => {};
    },
    registerFactory: () => () => {}
  },
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: { register: () => {}, bind: () => (key) => key },
  get: () => undefined,
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } }
};

// 执行 bundle：她的入口就是把自己注册进 window.__ModuleLoader__。
eval(bundleCode);
assert.ok(loaded !== null, 'bundle 必须成功注册到 __ModuleLoader__');

const plugin = loaded.factory(fakeRequire);
plugin.apply(ctx);

const userEntry = registered.find((r) => r.opts.name === 'conversation.chat.node' && r.opts.key === 'user');
assert.ok(userEntry !== undefined, '必须注册 conversation.chat.node#user');
const UserBubbleView = userEntry.component;

// ---------------------------------------------------------------------------
// 造一条带图片和文件的消息，真渲染
// ---------------------------------------------------------------------------
const imageAttachment = {
  attachmentId: 'sha256:image',
  mediaType: 'image/png',
  width: 240,
  height: 160,
  bytes: 12345,
  name: 'shot.png'
};
const fileAttachment = {
  attachmentId: 'sha256:file',
  mediaType: 'application/pdf',
  bytes: 204800,
  name: 'report.pdf'
};

const node = {
  key: 'user:1',
  anchorSeq: 10,
  data: {
    seq: 10,
    time: 1770000000000,
    role: 'user',
    content: [
      { type: 'image', attachment: imageAttachment },
      { type: 'file', attachment: fileAttachment },
      { type: 'text', text: '帮我看看这张图和这份报告' }
    ]
  }
};

// 宿主下发的会话授权取图函数（0.2.1 的形态：可调用函数 + peek）。
const loadImage = Object.assign(
  async () => 'data:image/png;base64,iVBORw0KGgo=',
  { peek: () => null }
);

const container = document.getElementById('root');
const root = createRoot(container);
flushSync(() => {
  root.render(React.createElement(UserBubbleView, {
    node,
    sessionId: 'session-test',
    loadImage,
    t: (key) => key
  }));
});

// 图片是异步加载的（组件在 effect 里 await loadImage）；给它一个微任务窗口。
await new Promise((resolve) => setTimeout(resolve, 20));
flushSync(() => {});

const html = container.innerHTML;

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------
assert.ok(html.includes('帮我看看这张图和这份报告'), '文字气泡本身必须还在');

assert.ok(html.includes('report.pdf'), `文件卡必须显示文件名（实际 HTML：${html.slice(0, 800)}）`);

const img = container.querySelector('img');
assert.ok(img !== null, `图片附件必须渲染出 <img>（实际 HTML：${html.slice(0, 800)}）`);
assert.ok(img.getAttribute('src')?.length > 0, '图片 <img> 必须带上 src');

console.log('✓ 用户消息的图片与文件都出现在气泡里');
console.log('\n======================================');
console.log('✔ 附件渲染测试通过');
console.log('======================================\n');