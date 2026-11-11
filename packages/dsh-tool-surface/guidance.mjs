/**
 * The withdrawn half of the tool surface, as prose.
 *
 * A withdrawn tool is still executable — the registry resolves a call through
 * its registration layers, and the assembly is only what the model is told
 * about — but it loses its argument schema. Every tool below takes strings, an
 * id or a small object, so one line of argument names is as complete as the
 * schema it replaces. The two exceptions are Stitch's design-system writers,
 * whose `DesignSystem` is three `$defs` deep with a 68-value font enum; those
 * say where to read the structure instead of pretending a line is enough.
 *
 * Measured on this machine (2026-11-11, 659 local sessions): the assembled tool
 * definitions were 81,473 characters of a one-request context, about 15.6%; 63
 * calls went to tools left out of that list and 57 succeeded.
 *
 * @module @logictan/dsh-tool-surface/guidance
 */

import { DEFAULT_KEEP, renderWithdrawnGuidance } from './surface.mjs';

/** Section name in the system prompt; unique across plugins. */
export const SECTION_NAME = 'plugin:dsh-tool-surface';

/**
 * Order within the system prompt.
 *
 * Before every per-plugin guidance section that describes withdrawn tools
 * (openviking's and stitch's both sit after 140): this section explains why
 * those sections carry argument lists for tools whose schemas are missing, so
 * it has to be read first or it explains nothing.
 */
export const SECTION_ORDER = 100;

/**
 * The opening sentence: why the rest of the prompt has no schemas.
 *
 * "若它被公告" rather than "读工具定义" alone: the model cannot fetch a schema
 * the prompt does not carry, and telling it to try would produce a failed call
 * per tool. The read-it-first advice only holds for the ones still announced.
 */
export const GUIDANCE_LEAD =
  '本机装了较多插件，绝大多数工具的参数表不进提示词以省上下文。下面按组给出工具名与参数：参数结构简单的照这行说明填，直接按名调用即可；结构复杂的先读该工具的参数表（若它在提示词里）。';

/** The groups, one per functional family of withdrawn tools. */
export const GUIDANCE_GROUPS = [
  {
    title: 'SSH 传输组',
    tools: [
      { name: 'ssh_list', args: '无参数' },
      { name: 'ssh_read', args: '`alias` + `path`，可选 `offset`/`limit`' },
      { name: 'ssh_upload', args: '`alias`、`local_path`、`remote_path`' },
      { name: 'ssh_download', args: '`alias`、`remote_path`、`local_path`' },
    ],
  },
  {
    title: '定时任务组',
    tools: [
      {
        name: 'schedule_create',
        args: '`title` + `prompt`，外加恰好一种时间参数：`after_seconds` / `at` / `every_seconds` / `daily` / `weekly` / `cron`',
      },
      { name: 'schedule_list', args: '无参数' },
      { name: 'schedule_update', args: '`id` + 要改的字段' },
      { name: 'schedule_delete', args: '`id`' },
    ],
  },
  {
    title: '配置同步组',
    tools: [
      { name: 'config_sync_pull', args: '可选 `channel`、`snapshotId`' },
      { name: 'config_sync_push', args: '可选 `channel`' },
    ],
  },
  {
    title: '出图组',
    tools: [
      { name: 'generate_image', args: '`prompt`，可选 `model`/`size`/`count`/`quality`' },
      { name: 'edit_image', args: '`prompt` + `source_image` 对象' },
      { name: 'cancel_image_generation_task', args: '`task_id`' },
      { name: 'get_image_generation_task', args: '`task_id`' },
      { name: 'mcp__magpie__generate_image', args: '`prompt`，可选 `reference_images`' },
      { name: 'mcp__magpie__generation_result', args: '`task_id`' },
    ],
  },
  {
    title: '视频组',
    tools: [
      {
        name: 'mcp__modal_h3__generate_video',
        args: '`prompt` + `duration_seconds`',
        note: '先 `dry_run: true` 本地校验通过再真跑；要并行就 `wait_for_completion: false` 再轮询',
      },
      { name: 'mcp__modal_h3__get_generation_task', args: '`task_id`' },
      { name: 'mcp__modal_h3__cancel_generation_task', args: '`task_id`' },
      { name: 'mcp__modal_h3__list_generation_tasks', args: '可选 `limit`' },
      { name: 'mcp__modal_h3__accounts_status', args: '无参数，可选 `live: true` 实测探测' },
      { name: 'mcp__modal_h3__accounts_sync', args: '可选 `account`、`dry_run`' },
    ],
  },
  {
    title: '浏览器/桌面组',
    tools: [
      { name: 'browser_agent', args: '`url` + `goal`' },
      { name: 'desktop_agent', args: '`goal`，可选 `app`/`windowId`' },
    ],
  },
  {
    title: '编排组',
    tools: [
      { name: 'workflow', args: '`script` + `meta`', note: '只在用户明确要 workflow 或大扇出时用' },
      { name: 'list_subagent_models', args: '可选 `provider`/`model`' },
      { name: 'interrupt_agent', args: '`agent_id`' },
      { name: 'subagent_fork', args: '继承了本会话上下文的一次派单' },
    ],
  },
  {
    title: '目标组',
    tools: [
      { name: 'create_goal', args: '`objective`' },
      { name: 'exit_plan_mode', args: '`plan`' },
      { name: 'working_directory', args: '可选 `cd`' },
    ],
  },
  {
    title: 'MCP 资源组',
    tools: [
      { name: 'list_mcp_resources', args: '`server`' },
      { name: 'list_mcp_resource_templates', args: '`server`' },
      { name: 'read_mcp_resource', args: '`server` + `uri`' },
    ],
  },
  {
    title: 'stitch 组',
    tools: [
      { name: 'mcp__stitch__list_projects', args: '无参数' },
      { name: 'mcp__stitch__get_project', args: '`name` 传 `projects/<id>`' },
      { name: 'mcp__stitch__create_project', args: '`title`' },
      { name: 'mcp__stitch__delete_project', args: '`name`' },
      { name: 'mcp__stitch__list_screens', args: '`projectId`' },
      { name: 'mcp__stitch__get_screen', args: '`name` 传 `projects/<id>/screens/<id>`' },
      { name: 'mcp__stitch__list_design_systems', args: '`projectId`' },
      { name: 'mcp__stitch__download_file', args: '`name` 取 screen 的 `html_code.name` 或 `screenshot.name`' },
      { name: 'mcp__stitch__remove_screens_from_canvas', args: '`projectId` + `screenIds` 数组' },
      { name: 'mcp__stitch__generate_screen_from_text', args: '`projectId` + `prompt`，可选 `designSystem`' },
      { name: 'mcp__stitch__edit_screens', args: '`projectId` + `selectedScreenIds` + `prompt`' },
      {
        name: 'mcp__stitch__generate_variants',
        args: '`projectId` + `selectedScreenIds` + `prompt` + `variantOptions`',
        note: '`VariantOptions` 有枚举字段，先读插件 README 再填',
      },
      {
        name: 'mcp__stitch__create_design_system',
        args: '`designSystem`',
        note:
          '结构复杂（`$defs` 三层嵌套、字体枚举 68 个），先读 `packages/dsh-stitch-designer/README.md` 或用 `mcp__stitch__get_project` 读项目里已存的设计系统资产，不要凭空猜字段',
      },
      {
        name: 'mcp__stitch__update_design_system',
        args: '`designSystem`',
        note: '结构同为 `DesignSystem`，先读已存的设计系统资产或插件 README，不要凭空猜字段',
      },
      {
        name: 'mcp__stitch__apply_design_system',
        args: '`projectId` + `selectedScreenInstances` + `assetId`',
      },
      {
        name: 'mcp__stitch__upload_design_md',
        args: '`projectId` + `designMdBase64`',
        note: '内容是 base64 编码的 DESIGN.md',
      },
      {
        name: 'mcp__stitch__create_design_system_from_design_md',
        args: '`projectId` + `selectedScreenInstance`',
        note: '先 `upload_design_md` 上传 DESIGN.md',
      },
    ],
  },
  {
    title: 'openviking 其余组',
    tools: [
      { name: 'mcp__openviking__write', args: '`uri` + `content`' },
      { name: 'mcp__openviking__edit', args: '`uri` + `old_string` + `new_string`' },
      { name: 'mcp__openviking__search', args: '`query`，可选 `mode`/`limit`' },
      { name: 'mcp__openviking__list', args: '`uri`' },
      { name: 'mcp__openviking__remember', args: '`messages`' },
      { name: 'mcp__openviking__forget', args: '`uri`' },
      { name: 'mcp__openviking__glob', args: '`pattern` + `uri`' },
      { name: 'mcp__openviking__grep', args: '`uri` + `pattern` 数组' },
      { name: 'mcp__openviking__health', args: '无参数' },
    ],
  },
];

/**
 * The default `guidance` value: the groups above, rendered against the default
 * whitelist. Empty when a deployment announces every tool, which is what makes
 * the config's "empty string means no section" case fall out for free.
 */
export const DEFAULT_GUIDANCE = renderWithdrawnGuidance(GUIDANCE_GROUPS, DEFAULT_KEEP, GUIDANCE_LEAD);