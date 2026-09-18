/**
 * 图标原语 —— 基于 lucide-react 的统一图标层（Workbench Design System）。
 *
 * 取代散落的文本符号图标（▣ ⇥ ⇤ ⇅ ⟳ ◷ ⓘ ⭳ ⌕ ✕ ⧉ →），解决跨平台字形宽度/基线
 * 漂移与视觉重量不一致问题。所有图标统一：
 *   - 尺寸由 `size` 控制（默认 14px，对齐正文行高）；
 *   - 描边 strokeWidth 统一 1.75（克制、精致，匹配高密度开发者工具观感）；
 *   - 颜色继承 currentColor（跟随父级文字色 / data-danger / hover 等语义）；
 *   - vertical-align 居中，与相邻文字基线对齐。
 *
 * 用法：<Icon name="download" /> 或具名导出 <DownloadIcon />。
 * 不引入第二套视觉体系：颜色走 currentColor → 父级 --dsw-* token。
 */
import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
// 体积纪律：从各图标独立模块路径导入（非 `lucide-react` 桶导出），保证 rolldown 在 cjs
// 单文件打包下精确 tree-shake——只打入用到的 ~18 个图标，避免整库 1500+ 全量进 client.js。
import ArrowRight from 'lucide-react/dist/esm/icons/arrow-right.mjs'
import CheckCircle from 'lucide-react/dist/esm/icons/check-circle.mjs'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs'
import Clock from 'lucide-react/dist/esm/icons/clock.mjs'
import CircleAlert from 'lucide-react/dist/esm/icons/circle-alert.mjs'
import Copy from 'lucide-react/dist/esm/icons/copy.mjs'
import DatabaseBackup from 'lucide-react/dist/esm/icons/database-backup.mjs'
import Download from 'lucide-react/dist/esm/icons/download.mjs'
import Eye from 'lucide-react/dist/esm/icons/eye.mjs'
import FolderInput from 'lucide-react/dist/esm/icons/folder-input.mjs'
import HardDriveDownload from 'lucide-react/dist/esm/icons/hard-drive-download.mjs'
import Info from 'lucide-react/dist/esm/icons/info.mjs'
import MessageSquare from 'lucide-react/dist/esm/icons/message-square.mjs'
import PackageCheck from 'lucide-react/dist/esm/icons/package-check.mjs'
import Pencil from 'lucide-react/dist/esm/icons/pencil.mjs'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import RotateCw from 'lucide-react/dist/esm/icons/rotate-cw.mjs'
import Search from 'lucide-react/dist/esm/icons/search.mjs'
import Trash2 from 'lucide-react/dist/esm/icons/trash-2.mjs'
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert.mjs'
import Upload from 'lucide-react/dist/esm/icons/upload.mjs'
import X from 'lucide-react/dist/esm/icons/x.mjs'

/** 语义图标名 → Lucide 组件映射（单一事实来源）。 */
const ICONS = {
  backup: HardDriveDownload,
  export: Upload,
  import: FolderInput,
  sync: RefreshCw,
  refresh: RotateCw,
  activity: Clock,
  clock: Clock,
  about: Info,
  info: Info,
  message: MessageSquare,
  pencil: Pencil,
  close: X,
  delete: Trash2,
  download: Download,
  inspect: Search,
  view: Eye,
  copy: Copy,
  arrowRight: ArrowRight,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  preview: Eye,
  snapshot: DatabaseBackup,
  ok: PackageCheck,
  check: CheckCircle,
  warn: TriangleAlert,
  error: CircleAlert,
} as const satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export interface IconProps {
  name: IconName
  /** 像素尺寸（默认 14，对齐 12.5px 正文行高） */
  size?: number
  /** 描边粗细（默认 1.75） */
  strokeWidth?: number
  className?: string
  style?: CSSProperties
  /** 无障碍：装饰性图标默认 aria-hidden；需语义时由父级 aria-label 承担 */
  decorative?: boolean
}

/**
 * 统一图标（lucide-react）。颜色继承 currentColor，尺寸/描边集中控制。
 */
export function Icon({ name, size = 14, strokeWidth = 1.75, className, style, decorative = true }: IconProps) {
  const Cmp = ICONS[name]
  return (
    <Cmp
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={{ verticalAlign: 'middle', flex: 'none', ...style }}
      aria-hidden={decorative || undefined}
      focusable={false}
    />
  )
}

/* —— 具名导出（调用处可读性优先） —— */
export const BackupIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="backup" {...p} />
export const ExportIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="export" {...p} />
export const ImportIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="import" {...p} />
export const SyncIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="sync" {...p} />
export const RefreshIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="refresh" {...p} />
export const ActivityIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="activity" {...p} />
export const ClockIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="clock" {...p} />
export const AboutIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="about" {...p} />
export const MessageIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="message" {...p} />
export const PencilIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="pencil" {...p} />
export const CloseIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="close" {...p} />
export const DeleteIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="delete" {...p} />
export const DownloadIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="download" {...p} />
export const InspectIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="inspect" {...p} />
export const ViewIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="view" {...p} />
export const CopyIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="copy" {...p} />
export const ArrowRightIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="arrowRight" {...p} />
export const ChevronRightIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="chevronRight" {...p} />
export const ChevronDownIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="chevronDown" {...p} />
export const PreviewIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="preview" {...p} />
export const SnapshotIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="snapshot" {...p} />
export const OkIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="ok" {...p} />
export const CheckIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="check" {...p} />
export const WarnIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="warn" {...p} />
export const ErrorIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="error" {...p} />
export const InfoIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="info" {...p} />
