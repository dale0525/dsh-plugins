# 模型价格与容量元数据的数据源调研

调研时间：2026-11-05。问题：主流工具/平台计算 token 价格时的数据源来自哪里，本仓库的模型参数库能否参考或改为自动同步。

## 结论

主流价格计算**没有统一上游**。真正的一手只有厂商自己的定价文档（HTML/Markdown）；三家都没有公开的价格 JSON API。OpenRouter、models.dev、LiteLLM 是三条互不引用的人工转抄链，tokencost 转抄 LiteLLM，Helicone 与 Langfuse 各自维护静态表。

本仓库 `packages/dsh-better-reasoning-effort/src/knowledge.ts` 的 `KNOWLEDGE_BASE` 应保持为人工策展的单一真源：外部源可作**离线差异校验的线索**，不能作为上游自动同步。最值得借鉴的是 Langfuse 的审计式治理（每日核对官方页、diff allowlist、无法确认就保持不变并报告），不是它的价格数据。

## 数据源图谱

### 厂商一手

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)、[OpenAI pricing](https://developers.openai.com/api/docs/pricing.md)、[Google AI Studio pricing](https://aistudio.google.com/docs/pricing.md)：均为静态文档页，不是结构化 API。三家 `/v1/models` 都需要 key 且不含价格（OpenAI 只回 id/created/owned_by，Anthropic 有容量无价格）。因此「从厂商官方 API 拿价格」不成立。厂商页自身也不承诺静态页最新：Anthropic 页首把最新价指向 claude.com/pricing，Google 页自带过期日。
- 静态 HTML 页的长期抓取稳定性未验证。

### 转抄链与聚合器

- [LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)：仓库根目录单表，进程启动时从 GitHub main 拉取，每条带 `source` 指向厂商页，维护靠人工/机器人 PR。2023-09 从 `litellm/` 目录[移出](https://github.com/BerriAI/litellm/commit/c5151aa573b797ef58cf9d0532162ed14964002f)。[LICENSE](https://raw.githubusercontent.com/BerriAI/litellm/main/LICENSE) 为 MIT（`enterprise/` 除外）。
- [tokencost constants.py](https://raw.githubusercontent.com/AgentOps-AI/tokencost/main/tokencost/constants.py) 的 `PRICES_URL` 直指 LiteLLM，[update_prices.py](https://github.com/AgentOps-AI/tokencost/blob/main/update_prices.py) 日更覆写本地 JSON，不是独立数据源。
- [Helicone](https://github.com/Helicone/helicone/blob/main/packages/cost/providers/mappings.ts)：`providers/*/index.ts` 手工 TS 表，Apache-2.0；[buildPricesOpenRouter.py](https://github.com/Helicone/helicone/blob/main/packages/buildPricesOpenRouter.py) 抓 OpenRouter 价格，未见定时 CI。
- [Langfuse](https://github.com/langfuse/langfuse/blob/main/worker/src/constants/default-model-prices.json)：治理最重——[每日 cron 审计](https://github.com/langfuse/langfuse/blob/main/.github/workflows/model-price-audit.yml) 用模型只查白名单厂商官方页、限定可改文件、要求「无法确认就保持不变并报告」，再加 [validate-pricing-file.mjs](https://github.com/langfuse/langfuse/blob/main/.agents/skills/add-model-price/scripts/validate-pricing-file.mjs) 与 diff allowlist，MIT。
- [models.dev](https://raw.githubusercontent.com/anomalyco/models.dev/dev/README.md)：社区 TOML，默认分支 `dev`，`bun validate` 加 GH Action 校验，MIT（[LICENSE](https://raw.githubusercontent.com/anomalyco/models.dev/dev/LICENSE) 已回原文核实）。`[limit]` 的 `context` / `input` / `output` 是三个不同语义，`reasoning.effort` 是 provider 级字段而非全模型统一。
- [OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models)：聚合商自维护的动态 API。LiteLLM 与它的真实关系是运行时采用响应里的 `usage.cost`，不是拿 `/api/v1/models` 生成价格表——此点为推论，全仓代码搜索未完成。

## 为什么不能自动同步

1. **字段语义不同，不是谁抄错了**。LiteLLM 的 `sample_spec` 明写 `max_input_tokens` 是「provider specifies it」的最大输入，不是总窗口：`gpt-5.2` 记 272000 而本仓库记 `contextWindow=400000`，`gpt-4o` 记 128000 则一致，`claude-opus-5-5` 记 1000000/128000 与本仓库一致。把 `max_input_tokens` 当 `contextWindow` 会系统性偏小。
2. **同名模型口径不一致**。`claude-sonnet-4.5` 在 [Anthropic 官方页](https://platform.claude.com/docs/en/models/sonnet-4-5/overview.md) 是 200K / 64K / $3/$15，models.dev 逐项一致，OpenRouter 报 `context_length=1000000` 并附 `min_prompt_tokens:200000` 的加价档，`:batch` slug 又是半价。价格三处全对、容量差 5 倍，这是口径差异而非错价。
3. **外部源有空洞**。models.dev 抽样到 `Kimi-K2.7-Code`、`Qwen3.8-Max-0902` 均为 `limit 0/0` 占位，直接导入会写进 0。
4. **字段覆盖替代不了本仓库的策展内容**。本仓库条目存的是家族/网关别名 `patterns`、推理档位的 wire spelling、`compat`、输入模态与容量；外部价格源没有 wire spelling / compat / 网关别名。仓库里也没有任何价格计算代码，本课题是数据治理而非功能缺口。
5. **许可**。models.dev 与 LiteLLM 为 MIT，复制进仓库允许但须保留版权声明；[OpenRouter ToS](https://openrouter.ai/terms) 与 [HF ToS](https://huggingface.co/terms-of-service) 未见数据集级授权，只宜运行时读取、不落库（未验证项）。

## 定量对照（2026-11-05 快照）

以 id 归一化粗匹配对照本地 65 条与三源快照：命中约 50–59/65；LiteLLM 在已有 `maxTokens` 的条目里约 11 条数值不同，OpenRouter 约 6 条 `contextWindow` 不同；同时它们能为本地缺失的 24 条 `maxTokens` 补出约 18 条。抽样确认主因是上文的字段语义差异，不是单纯的数值错误。

本地侧：`KNOWLEDGE_BASE` 65 条，有 `contextWindow` 58 条、有 `maxTokens` 41 条，缺的 24 条多为国产/网关模型；`knowledge.ts` 自 2026-09-22 收录只有 4 次提交（其中 2 次是上游同步），是月度级人工策展。该文件注释已声明容量是 REFERENCE values、聚合源分歧时留空、争议家族不写。引入自动同步会破坏这套保守语义，且 host 启动期写配置不能依赖外网。

数字基于粗匹配、未做 canonical id 精确对齐，只当量级参考。

## 若要落地

保持本地 curated 为真源；新增一个**离线**差异检查脚本，按显式映射拉三源快照、只产出「待人工复核」清单而不写 `knowledge.ts`。映射必须写死 `models.dev limit.context→contextWindow`、`limit.output→maxTokens`、`OpenRouter top_provider.max_completion_tokens→maxTokens`、`LiteLLM max_output_tokens→maxTokens`，明确禁止 `LiteLLM max_input_tokens→contextWindow`，并过滤 0 值与非 canonical 别名。借鉴 Langfuse 的每日审计加 diff allowlist。

只有将来真要做价格计算功能时，才需要引入价格源；那时也应选厂商官方文档加审计式治理，而不是 tokencost 这类二手转抄。

## 未验证项

三源定量对照基于 id 归一化粗匹配；LiteLLM 不引用 OpenRouter/models.dev 生成价格表是推论；OpenRouter 与 HF 整份元数据的再分发许可不明确；外部源无统一语义版本号，按 commit SHA 做增量 diff 是推论；厂商 HTML 页长期抓取稳定性未验证。
