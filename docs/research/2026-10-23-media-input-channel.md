# 音频/视频/PDF 进模型：DSH 的三道门与网关的可用形状

> 状态：一手实测结论。宿主 0.2.1-rc.2，`@deepseek-ai/dsh-llm-pi-ai` 与
> `@earendil-works/pi-ai` 1.3.0，网关 `https://cpa.logiconsole.com/v1`。
> 复现方式见 §5。结论是**不做插件**：用户于 2026-10-23 裁定使用频率过低。

## 1. 问题

`cpa` provider 配的 gemini 模型本身能原生理解音频、视频、PDF，但 DSH 的模型配置里
只能选「文本 / 图片」。能不能让插件补上这三种模态？

这个问题 2026-10-14 已经勘察过一次（结论：宿主没有附件通道）。本次把「到底卡在哪一层」
逐层测穿，得到可复用的边界判据，避免第三次重查。

## 2. 三道门，从表到里

### 门 1：模态词表（配置层）

`dsh-better-reasoning-effort` 的「输入模态」勾选框写的就是模型条目的 `input` 字段，
而该字段的取值被适配器钉死为 `text | image`（`dsh-llm-pi-ai/lib/index.js` 的 `MODALITIES`，
与 pi-ai 的 `MODEL_INPUT_MODALITIES` 一致）。直接喂给适配器 Config 校验：

```
input: ['text','image','audio']
  → $.providers.cpa.models[0].input[2] expected "text" | "image" but got "audio"
```

插件即便加一个「音频」勾选框，写出的值会让该 provider 整条配置校验失败。
`packages/dsh-better-reasoning-effort/tests/vocabulary.spec.ts` 从已安装产物里机械抽取这个词表，
正是为了挡这类「插件词表比宿主宽」。

### 门 2：内容块词表（会话层）

宿主能表达的内容块只有 `text / reasoning / image / file`（`dsh-llm` 的 `ContentBlockMap`），
没有 audio、video 块。上传 mp3/mp4/pdf 走的是 `file` 分支。

### 门 3：file 块永不携带字节（派发层）

`LlmRuntime.stream` 在派发前跑 `projectFilesToText`，把每个 `file` 块换成一段文本句柄。
动态验证（喂一个 file 块，看输出）：

```
[File "sample.wav" (2705110 bytes, sha256:abcdef01): verbatim read-only copy saved at
 "/Users/…/sample.wav". Read that path with your file tools when its contents are needed; …]
still has file block: false
```

而 pi-ai 适配器的 `userContent` 只映射 `text` 和 `image`，其余落到 `default: break` 被静默丢弃。
**结论：`file` 块在 DSH 里是一条「你自己去读这个路径」的指针，不是内容通道。**

## 3. 网关侧：形状是通的，token 可作判据

直连网关把 wav 以 base64 塞进请求体，三种形状都拿到了正确转写（问封闭问题交叉核对：
专辑年份 2023 / 做菜比喻「炒菜放盐」/ 时长 57 秒，实际 56.35 秒）：

| part 形状 | 结果 | prompt_tokens |
| --- | --- | --- |
| `{type:'input_audio', input_audio:{data, format}}` | 200，答对 | **1418** |
| `{type:'file', file:{filename, file_data:'data:audio/wav;base64,…'}}` | 200，答对 | **1418** |
| `{type:'file', file:{filename, file_data:'data:application/octet-stream;base64,…'}}` | **400** | 超 1,048,576 |

两条要点：

1. **token 数逐位相同**说明网关走同一条解码路径，`file` 没有退化成文本。
2. **mime 必须给对**：退到 `application/octet-stream` 时网关把 base64 当纯文本计入 prompt，
   直接撑爆上下文（`INVALID_ARGUMENT`）。所以「扩展名 → mime」映射表不是可选的。

同一形状对 PDF 也成立：手工构造一张发票 PDF（编号/金额/客户名），提问三行全中，prompt_tokens 542。
`file` 一条分支即可覆盖音频/视频/PDF/图片，不必为音频单独写 `input_audio` 构造。

视频未实测（本机无样本），`video/mp4` 只在映射表里。

## 4. 子代理为什么连间接路线也走不通

`dsh-force-rules` 的席位档案是白名单（`packages/dsh-force-rules/src/index.js`）。三种标记实测：

| 标记 | 结果 |
| --- | --- |
| 无标记 / `[只读]` | `bash is not among the tools it may use` |
| `[审核]` | `node /tmp/… is not a permitted dry-run command`（该正则只放行 `node --version`） |
| `[编辑: /tmp]` | 只授予写文件，不含执行，同样拒 bash |

MCP 也不行：`mcp__openviking__*` 不在 `READ_ONLY_TOOLS` 里。而即便能调，`dsh-mcp-client`
把 MCP 的 audio 块降级成 `[audio result unsupported: audio/mpeg; …]` 占位文本。

**推论（未实测）**：若真做宿主侧工具 `understand_media(path, question)`，子代理仍会被拒，
必须同时把工具名加进 `READ_ONLY_TOOLS`。只做插件的话 root 能用、席位不能用。

## 5. 复现

```sh
node cpa_media_understand.mjs <本地文件> "问题"   # file 形状，覆盖音频/视频/PDF/图片
CPA_SHOW_USAGE=1 node cpa_media_understand.mjs x.wav "…"   # 顺带打 token 用量
```

密钥读 `~/.dsh/.credentials.yaml` 的 `CPA_API_KEY`，不进命令行。脚本本体是一次性探针，
2026-10-23 收尾时已删除；需要时按 §3 的形状重写即可（不到 40 行）。

## 6. 结论与替代

- **不做插件**：收益只是「省掉记住脚本路径」，成本是新包首发 + trust + 聚合包升版 + 改
  `READ_ONLY_TOOLS`。用户裁定使用频率过低。
- **root 可用替代**：bash 跑脚本经网关往返，转写以文本回到上下文。交叉校对时用两个不同模型
  各跑一遍即为两条独立读数，不需要独立会话。
- **会翻转结论的情形**：要并行批量转写几十个素材，每个席位同时跑——那时席位确实需要自己的
  媒体通道，插件才值得做，且必须两处一起改。
