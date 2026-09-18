/**
 * 官方市场收录目标的纯常量（零依赖模块）。
 *
 * 为什么单独成文件：这些常量同时被 **host 半**（github-repos.ts / my-repo.ts）与
 * **client 半**（MyConfigsView.tsx，用于展示「官方收录目标仓库」文本）使用。
 * 如果 client 直接从 github-repos.ts 导入，rolldown 会把该模块的**整条依赖链**
 * 拉进浏览器单文件 bundle —— 而 github-repos.ts 经 utils/proxy.ts 依赖 `node:https`
 * （issue #30 的插件私有代理），于是 client.js 里出现 `require("node:https")`，
 * DSH loader 的模块表没有该条目，插件直接加载失败：
 *   「client-modules: require("node:https") missed the module table」。
 *
 * 把纯数据抽出来后，client 侧只依赖本文件，依赖链在 Node 内置模块之前就断开了。
 *
 * 本文件必须保持**零 import**（除类型外），否则会重新引入同类问题。
 */

/** 官方市场收录仓库的 owner（固定，非用户配置）。 */
export const MARKET_UPSTREAM_OWNER = 'xiajiajun516';

/** 官方收录目标仓库名（见 MARKET_UPSTREAM_OWNER）。 */
export const MARKET_UPSTREAM_REPO = 'dsh-config-market';
