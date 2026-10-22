/**
 * What the model is told about this route, as a system-prompt section.
 *
 * The prompt contract is the one thing here that a tool description cannot
 * carry usefully: six mandatory sections in a fixed order, an effective
 * duration that must be stated and must match the request, and reference
 * labels that must be introduced in sequence. Those rules are checkable, so
 * they are enforced by `validate_ref2va_prompt` in the runner — but a model
 * that only learns them from a rejection writes the prompt twice. Announcing
 * them costs a few hundred tokens per session and removes that round trip.
 *
 * The mode restriction is announced for a different reason: the route cannot
 * honour T2VA / I2VA / FL2VA / L2VA / Hybrid or exact keyframe locks, and the
 * model must say so rather than silently translate the request into something
 * Ref2VA can do. No validator can catch "the user asked for a locked last
 * frame and got a best-effort one" — only the wording can.
 *
 * @module @logictan/dsh-modal-h3/guidance
 */

/** Section name in the system prompt; unique across plugins. */
export const SECTION_NAME = 'plugin:dsh-modal-h3';

/** Order within the tool-guidance band. */
export const SECTION_ORDER = 160;

/**
 * The route's contract, in the form a model needs before it writes a prompt.
 */
export const H3_GUIDANCE = [
  '本机已安装 dsh-modal-h3 插件：MiniMax H3 Ref2VA Turbo6 文/参考生视频（4–15 秒，1344x768，24fps，原生立体声）。工具名 `mcp__modal_h3__*`。',
  '',
  '只支持 Ref2VA。不要接受或自行改写 T2VA / I2VA / FL2VA / L2VA / Hybrid 任务，也不要承诺精确首帧或精确尾帧——首帧/尾帧只能作为 best-effort 视觉目标。用户若把「精确锁定首尾帧」当作硬性验收条件，直接说明当前路由做不到。',
  '',
  '写提示词时：',
  '1. 必须恰好包含以下六个小节，各出现一次且按此顺序，小节标题行只写 `名称:`：`subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music`。',
  '2. `summary` 里必须写明 `effective duration of N seconds`，N 用 `generate_video` 的 `dry_run` 返回的 `effective_duration_seconds`（请求时长会先量化到 24fps 整帧，所以 N 不一定等于你传的 duration_seconds）。',
  '3. 引用标签 `<Picture n>`、`<Video n>`、`<Audio n>` 必须按 1..N 顺序首次出现，且数量与 `dry_run` 返回的 `prompt_media_map` 一致。带音轨的参考视频会先占用 Audio 标签，再接独立音频。',
  '4. 把小节之外的描述写成镜头语言（构图、主体、环境、动作、镜头运动、声音，以及参考素材出现的确切位置）；不要写剧情梗概，不要留未解析的标签。',
  '5. 首帧/尾帧目标在 `subject_definitions` 与 `retention_analysis` 里标为 best effort，不得写成 FL2VA、keyframe completion、locked 或 guaranteed。',
  '',
  '先用 `generate_video` 的 `dry_run: true` 验证提示词与帧契约——它只做本地检查，不联网、不写盘、不花钱。通过后再真跑。',
  '',
  '一次生成会占用一个 Modal 账号，而每个账号同时只能跑一个（worker 是 max_containers=1）。要并行就传 `wait_for_completion: false` 连续下单，再用 `get_generation_task` 轮询；账号由插件自动挑最闲的，不要手动指定。',
].join('\n');
