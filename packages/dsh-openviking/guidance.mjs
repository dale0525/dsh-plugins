/**
 * The OpenViking memory tools, as the plugin announces them.
 *
 * Eleven of the server's twenty-seven tools keep their definition in the
 * prompt. The other sixteen are named here instead, with their arguments,
 * because a withdrawn tool is still executable — `tools` resolves a call
 * through its registration layers and the assembly is only what the model is
 * told about — while its schema is no longer there to consult.
 *
 * The split is measured, not guessed: over 400 of this machine's 656 local
 * sessions (2026-11-11) the sixteen withdrawn tools were called zero times,
 * and the eleven kept ones accounted for all 130 OpenViking calls. The whole
 * surface was 31,806 characters of a 100,322-character first request; the
 * withdrawn half is 18,671 of them.
 *
 * @module @logictan/dsh-openviking/guidance
 */

/** Section name in the system prompt; unique across plugins. */
export const SECTION_NAME = "plugin:dsh-openviking";

/** Order within the tool-guidance band. */
export const SECTION_ORDER = 120;

/**
 * What the model is told about the tools it can call but cannot see.
 *
 * Every withdrawn tool takes a URI, an id, a flag or a word, so a one-line
 * argument list is as complete as the schema it replaces. The tools whose
 * arguments are structures the model cannot guess — none, in this server —
 * would have stayed announced instead of being written up here.
 */
export const OPENVIKING_GUIDANCE = [
  "本机已安装 dsh-openviking 插件（OpenViking 记忆/资源服务）。下面这些工具的参数表不进提示词，但工具本身照常可调用——直接按名调用即可：",
  "",
  "- `mcp__openviking__add_resource`（`path` 传 http(s)/git@/ssh/git URL 或本地文件路径；`to` 精确落点，`parent` 新目录，二者互斥；`args` 传 `{\"site\": true}` 强制整站抓取；`add_type` 显式指定 connector 类型）、`mcp__openviking__add_skill`（`data` 传完整 SKILL.md 文本，或 `path` 传 git URL / 本地 SKILL.md 路径 / .zip，`skills` 选其中几个，`target_uri` 装到哪个技能根，`list_only` 只列不装）",
  "- `mcp__openviking__tree`（`uri` 目录、`level_limit` 深度、`node_limit` 条数、`include_abstract` 带摘要、`offset`/`limit` 分页）、`mcp__openviking__download`（`uri` 单个文件，返回一次性下载链接，约 10 分钟过期）",
  "- `mcp__openviking__set_acl`（`uri` + `acl`，`acl` 形如 `{\"acl_mode\":\"inherit|restricted\",\"entries\":[{\"principal\":\"user:<id>|group:<id>|user:*\",\"level\":\"read|write|manage\"}]}`）、`mcp__openviking__get_acl`（`uri`）、`mcp__openviking__list_users`（`query` 子串、`page`/`limit` 分页、`include_credentials`）、`mcp__openviking__list_groups`（无参数）",
  "- `mcp__openviking__privacy_tree`（`category` 可选，如 `credential`/`skill`；返回 `{{ov_privacy:...}}` 引用而非明文）、`mcp__openviking__privacy_resolve`（`reference` 传整个 `{{ov_privacy:...}}` 占位符）、`mcp__openviking__privacy_upsert`（`category`、`target_key`、`values` 对象）",
  "- `mcp__openviking__rule_search`（`task_context` 必填，`rule_probability_threshold` 阈值）、`mcp__openviking__find_mcp_tools`（`query` + `limit`，返回带 uri 的工具定义）、`mcp__openviking__invoke_mcp_tool`（`tool_uri` 取 find_mcp_tools 返回的 uri，`arguments` 按该工具 schema 填）、`mcp__openviking__list_watches`（无参数）、`mcp__openviking__cancel_watch`（`to_uri`）",
  "",
  "参数表保持完整的十一只是 `read`、`write`、`edit`、`find`、`search`、`list`、`remember`、`glob`、`grep`、`forget`、`health`，按提示词里的说明填即可。",
].join("\n");