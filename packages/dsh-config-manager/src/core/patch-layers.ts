/**
 * cordis patch 层的寻址契约（唯一真源）。
 *
 * 宿主组装 patch 栈的顺序是 `bundle → profile → home → --patch`（后者覆盖前者），两层分工不同：
 *  - home 层 `$DSH_HOME/cordis.patch.yml`：全机偏好，对每个 profile 生效；
 *  - profile 层 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`：该 profile 专属（端口、trustedHosts、
 *    挂载行…），换机恢复时必须跟着走。
 *
 * 两层的**持久化标识**是这里的两个逻辑 token，而不是相对路径：同步快照会跨机器、
 * 跨 profile 导入，相对路径会把源机的 profile 名带过去。home 层 token 与历史快照里的
 * `PatchLine.file` 取值逐字相同（存量快照零改动即可解析回 home 层）。
 *
 * 层限定复合键 `<file>#<lineId>`：两层可以存在同名 `lineId`，而计划项 id / `target.ref` /
 * 快照条目必须唯一指向「哪一层的哪一行」，否则应用与回滚会写错层。两个 token 与 lineId 都不含
 * `#`（后者由 `readPatchLines` 保证非空字符串，此处不额外校验），分隔符无歧义。
 */

/** home 层 token（`$DSH_HOME/cordis.patch.yml`）；取值与历史快照的 file 字段一致。 */
export const HOME_PATCH_FILE = 'cordis.patch.yml';

/** profile 层 token（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）。 */
export const PROFILE_PATCH_FILE = 'profile:cordis.patch.yml';

/** 层限定复合键的分隔符（两个层 token 与 lineId 都不含它）。 */
const PATCH_LAYER_SEPARATOR = '#';

/** 层限定复合键：`<file>#<lineId>`。 */
export function patchLayerKey(file: string, lineId: string): string {
  return `${file}${PATCH_LAYER_SEPARATOR}${lineId}`;
}

/**
 * 解析层限定复合键。
 *
 * 兼容分支：旧快照的 `target.ref` / `SnapshotEntry.ref` 是裸 `lineId`（当时只有 home 层），
 * 不含 `#` 即视作 home 层。lineId 本身不含 `#`，因此该分支无歧义。
 */
export function parsePatchLayerKey(ref: string): { file: string; lineId: string } {
  const at = ref.indexOf(PATCH_LAYER_SEPARATOR);
  if (at < 0) return { file: HOME_PATCH_FILE, lineId: ref };
  return { file: ref.slice(0, at), lineId: ref.slice(at + 1) };
}
