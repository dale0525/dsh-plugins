# dsh-imagegen

<p align="center">
  <a href="https://www.npmjs.com/package/@logictan/dsh-imagegen"><img src="https://img.shields.io/npm/v/@logictan/dsh-imagegen?color=cb3837&logo=npm&label=npm" alt="npm" /></a>
  &nbsp;
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-3b82f6.svg" alt="License" /></a>
  &nbsp;
  <a href="https://github.com/dale0525/dsh-plugins"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-111827" alt="Platform" /></a>
</p>

<div align="center">

## DeepSeek Harness 的聊天内生图插件

在对话里直接 **文生图 / 图生图** · 多 **渠道** 各自一套模型目录 · 无需离开会话

</div>

---

## 这是什么

dsh-imagegen 把 AI 生图接进 DSH 的对话流程：模型通过 `generate_image` / `edit_image` 工具直接出图，图片以工具结果的形式显示在对话里；你也可以用 `/edit_image` 命令对最近一张图做修改。

插件**不提供**独立的生图页面、画布、画廊或模板库 —— 一切都发生在对话中。

## 安装

随聚合包一起安装（推荐）：

```bash
dsh plugin --profile web add @logictan/dsh-plugins-all
```

单独安装：

```bash
dsh plugin --profile web add @logictan/dsh-imagegen
```

## 配置

打开 **设置 → 插件 → AI 生图**，添加至少一个**渠道**：

| 字段 | 说明 |
| --- | --- |
| 预设 | 常见厂商的预填（OpenAI 官方、xAI Grok Imagine、Google Nano Banana、字节 Seedream、智谱 GLM-Image、阿里 Qwen-Image、MiniMax image-01 等） |
| API 地址 | 该渠道的端点；非 OpenAI 兼容协议的厂商按其官方接口填写（预设里已说明） |
| API 密钥 | 仅存于本机设置文档，生成时由宿主代理转发 |
| 模型目录 | 该渠道下可用的「别名 → 上游模型 id」映射 |

可选配置**提示词增强**：填一个 OpenAI 兼容的聊天端点与模型，生图前会把简短提示词扩写成更完整的描述。

## 使用

**让模型生图**（在对话里直接说需求即可，模型会调用工具）：

- 文生图：`generate_image`
- 图生图：`edit_image`（把参考图一并给模型，或引用对话里的图片）
- 查后台任务：`get_image_generation_task`

**自己动手改图**：`/edit_image <修改描述>` —— 直接读取当前对话最近一张图片并调用插件图片模型，不经过对话模型的图片能力检查。

**后台执行**：工具默认等到图片出来才返回；显式传 `wait_for_completion: false` 可后台跑，之后用 `get_image_generation_task` 查询（不要反复轮询）。

## 开发

```bash
pnpm install
pnpm --filter @logictan/dsh-imagegen build       # 产出 lib/index.js 与 lib/client.js
pnpm --filter @logictan/dsh-imagegen typecheck
```

宿主半边的改动需要重启 `dsh-web` 才生效；只改 `src/client/**` 时重建 `lib/client.js` 即可被界面热重载。

## 许可

Apache-2.0。本项目衍生自 [dickpy/dsh-imagegen](https://github.com/dickpy/dsh-imagegen)，经大幅重写后按自制插件维护。
