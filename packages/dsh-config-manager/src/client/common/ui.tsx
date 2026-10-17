/**
 * Config Manager 内部辅助 UI 原语。
 *
 * Button 与核心表单控件已全部迁移到 @logictan/dsh-plugins-shared-client。
 * 此处仅保留尚未迁移到外部共享库且在 common 内部有消费者的辅助原语：
 *   - Button: 统一重导出自 @logictan/dsh-plugins-shared-client，供 ErrorBanner 复用
 *   - IconButton: 工具栏/ToastViewport 关闭按钮
 *   - Spinner: ErrorBanner 重试态内嵌加载环
 */
import type { ReactNode } from 'react'
import css from '../config-manager.module.css'

export { Button } from '@logictan/dsh-plugins-shared-client/client'

/* ---------------- IconButton ---------------- */

export interface IconButtonProps {
  /** 图标/符号（文本符号；aria-label 必填描述用途） */
  icon: ReactNode
  /** 无障碍名称（必填：图标按钮没有可见文本） */
  label: string
  onClick?: () => void
  disabled?: boolean
  /** 高亮态（如抽屉打开时对应按钮 active） */
  active?: boolean
  /** 危险语义（红色；用于行内删除等破坏性动作的视觉隔离） */
  danger?: boolean
  title?: string
}

/** 图标按钮（导航条/工具栏图标动作；26px 触达区）。 */
export function IconButton({ icon, label, onClick, disabled, active, danger, title }: IconButtonProps) {
  return (
    <button
      type="button"
      className={css.iconBtn}
      aria-label={label}
      title={title ?? label}
      data-active={active === true ? '' : undefined}
      data-danger={danger === true ? '' : undefined}
      disabled={disabled === true}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

/* ---------------- Spinner ---------------- */

export interface SpinnerProps {
  label?: string
}

/** 加载指示（旋转环 + 可选文案） */
export function Spinner({ label }: SpinnerProps = {}) {
  return (
    <span className={css.spinnerWrap}>
      <span className={css.spinner} aria-hidden="true" />
      {label !== undefined && <span className={css.spinnerLabel}>{label}</span>}
    </span>
  )
}
