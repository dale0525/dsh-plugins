/**
 * 分区构成网格（共享渲染原语）。
 *
 * 用途：总览页「分区构成」卡与导出页「预览将导出内容」弹窗共用同一套分区清单渲染
 * （分区名 + 条目数 + 体积，两列网格），保证两处视觉与文案完全一致，避免重复实现漂移。
 *
 * 职责边界：本组件**只渲染网格**——卡片外框（Card）、标题行（含合计 / 跳过提示）
 * 与空判断由调用方负责。纯装配，无业务逻辑、无数据请求、无状态。
 */
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import { formatBytes } from '../../ui/report.ts'
import css from '../config-manager.module.css'

export interface SectionCompositionProps {
  /** 分区构成条目（来自 export-preview 只读预览；顺序原样渲染） */
  sections: { section: SectionId; count: number; sizeBytes: number }[]
  t: TranslateNS<'config-manager'>
}

/**
 * 分区构成网格：每行「分区名 · 条目数 · 体积」。
 */
export function SectionComposition({ sections, t }: SectionCompositionProps) {
  return (
    <div className={css.sectionGrid}>
      {sections.map((s) => (
        <div key={s.section} className={css.sectionRow}>
          <span className={css.sectionName}>{s.section}</span>
          <span className={css.sectionCount}>{t('overview.sections.entries', { count: String(s.count) })}</span>
          <span className={`${css.sectionSize} ${css.mono}`}>{formatBytes(s.sizeBytes)}</span>
        </div>
      ))}
    </div>
  )
}
