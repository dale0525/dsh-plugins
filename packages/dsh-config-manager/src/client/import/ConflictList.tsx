/**
 * 冲突决策列表（规范 §11，绑 src/ui/conflict-view.ts 的 ConflictCollector）。
 *
 * Workbench Rebuild（2026-09）：
 * - 每个冲突渲染为「选边卡片」：保留当前 / 使用备份 两个并排可点选块，
 *   选中侧高亮描边 + 淡底（radio 语义保留：label 包裹原生 input，键盘可操作）；
 * - 适配器标签（kindTag）+ 描述（路径等宽字体）组成卡片头；
 * - 配置更改明细（detail）不再用 <pre>（white-space:pre 不换行 → 长 JSON 横向溢出），
 *   改为切分后 prefix / current / imported 各自成行、长值自动换行（见 splitConflictDetail）；
 * - 批量决策按钮置于列表顶部工具行。
 *
 * 注意：不提供 "Review（稍后决定）" 选项——Review 会被收集器计为
 * unresolved，导致「下一步」永远禁用（死路）。要么决策，要么不进入本步。
 * 安全：冲突项不携带当前配置值（当前值可能含秘密，不回显），故不做值级 diff。
 */
import { useState } from 'react'
import { ConflictCollector } from '../../ui/conflict-view.ts'
import type { ItemResolution } from '../../core/types.ts'
import type { TranslateNS } from '../client-types.ts'
import { Banner } from '../common/ui.tsx'
import css from '../config-manager.module.css'

export interface ConflictListProps {
  collector: ConflictCollector
  t: TranslateNS<'config-manager'>
  /** 任意决策变化后通知父组件刷新（tick） */
  onChanged: () => void
}

const RESOLUTION_OPTIONS: { value: ItemResolution; key: string }[] = [
  { value: 'keepCurrent', key: 'import.conflicts.keepCurrent' },
  { value: 'useImported', key: 'import.conflicts.useImported' },
]

/** 明细里的固定英文标识（host 适配器拼装，不是用户可见文案，故不走 i18n 字典） */
const CURRENT_MARK = 'current='
const IMPORTED_MARK = ' imported='

/**
 * 把 host 下发的冲突明细切成「前缀 / current / imported」三段（纯展示切分）。
 *
 * detail 形如：
 *   `current={"a":"b"} imported={"c":"d"}`（settings/providers/mcp/workspaces 适配器）
 *   `行 12 current=… imported=…`（prompts 适配器，带行号前缀）
 * 也可能完全不含 `current=`（如 plugins 的本地化文案「当前 1.1 vs 导入 1.6」）。
 *
 * 刻意不放进 src/ui/conflict-view.ts：这不是业务判定，只是渲染前把一行文本拆成
 * 三段、以便各自换行（原来用 <pre> 时 white-space:pre 不换行 → 横向滚动条），
 * 属纯展示层关切，跨端（node）复用无意义。
 *
 * 兜底：任何输入都不丢内容 —— 找不到 `current=` 时整段作为 current。
 */
function splitConflictDetail(detail: string): { prefix: string | null; current: string; imported: string | null } {
  const at = detail.indexOf(CURRENT_MARK)
  if (at < 0) return { prefix: null, current: detail, imported: null }
  const head = detail.slice(0, at).trim()
  const prefix = head === '' ? null : head
  const rest = detail.slice(at + CURRENT_MARK.length)
  const sep = rest.indexOf(IMPORTED_MARK)
  if (sep < 0) return { prefix, current: rest, imported: null }
  return {
    prefix,
    current: rest.slice(0, sep),
    imported: rest.slice(sep + IMPORTED_MARK.length),
  }
}

/** 批量决策全部冲突项（keepCurrent / useImported；下沉到 ConflictCollector.resolveAll 纯函数，
 *  组件只做装配 + tick/onChanged 通知；与逐项逻辑一致地更新 UI） */
function resolveAll(
  collector: ConflictCollector,
  resolution: Extract<ItemResolution, 'keepCurrent' | 'useImported'>,
  setTick: (fn: (v: number) => number) => void,
  onChanged: () => void,
): void {
  collector.resolveAll(resolution)
  setTick((v) => v + 1)
  onChanged()
}

/** 冲突项决策列表（选边卡片） */
export function ConflictList({ collector, t, onChanged }: ConflictListProps) {
  const [tick, setTick] = useState(0)
  const items = collector.viewItems()
  const unresolved = collector.unresolved().length
  const hasConflicts = items.length > 0

  return (
    <div className={css.conflictList}>
      {unresolved > 0 && <Banner kind="warn">{t('import.conflicts.unresolved', { count: String(unresolved) })}</Banner>}

      {/* 批量决策按钮（无冲突项时禁用；均为次操作——覆盖性决策不诱导，逐项选边为主） */}
      <div className={css.actionRow}>
        <button
          type="button"
          className={css.ghostButton}
          data-size="sm"
          disabled={!hasConflicts}
          onClick={() => { resolveAll(collector, 'keepCurrent', setTick, onChanged) }}
        >
          {t('import.conflicts.keepCurrentAll')}
        </button>
        <button
          type="button"
          className={css.ghostButton}
          data-size="sm"
          disabled={!hasConflicts}
          onClick={() => { resolveAll(collector, 'useImported', setTick, onChanged) }}
        >
          {t('import.conflicts.useImportedAll')}
        </button>
      </div>

      {items.map((view) => {
        const item = view.item
        // 配置更改明细：切成 prefix/current/imported 三段分别换行（见 splitConflictDetail）
        const detail = item.detail !== undefined && item.detail !== '' ? splitConflictDetail(item.detail) : null
        return (
          <div key={item.id} className={css.conflictItem}>
            <div className={css.conflictHead}>
              <span className={css.kindTag}>{item.adapter}</span>
              <span className={`${css.conflictId} ${css.mono}`} title={item.description}>{item.description}</span>
              {item.severity === 'error' && <span className={css.severityError}>error</span>}
            </div>
            {detail !== null && (
              <div className={css.conflictDetail}>
                {detail.prefix !== null && <div className={css.conflictPrefix}>{detail.prefix}</div>}
                <div className={css.conflictLine}>
                  <span className={css.conflictLineLabel}>current</span>
                  <span className={css.conflictLineValue}>{detail.current}</span>
                </div>
                {detail.imported !== null && (
                  <div className={css.conflictLine}>
                    <span className={css.conflictLineLabel}>imported</span>
                    <span className={css.conflictLineValue}>{detail.imported}</span>
                  </div>
                )}
              </div>
            )}
            <div className={css.conflictChoices} role="radiogroup" aria-label={item.description}>
              {RESOLUTION_OPTIONS.map((opt) => {
                const selected = view.resolution === opt.value
                return (
                  <label key={opt.value} className={css.choiceCard} data-selected={selected ? '' : undefined}>
                    <input
                      type="radio"
                      name={`conflict-${item.id}`}
                      checked={selected}
                      onChange={() => {
                        collector.resolve(item.id, opt.value)
                        setTick((v) => v + 1)
                        onChanged()
                      }}
                    />
                    <span className={css.choiceTitle}>{t(opt.key as 'import.conflicts.keepCurrent' | 'import.conflicts.useImported')}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}
      {items.length === 0 && <div className={css.empty}>No conflicts</div>}
      {void tick}
    </div>
  )
}
