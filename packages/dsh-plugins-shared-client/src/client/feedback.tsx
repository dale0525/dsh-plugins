/**
 * Status vocabulary: `StatusDot`, `Tag`, `Banner`, `EmptyState`, `Skeleton`.
 *
 * These are the four ways the design shows state, and they are separate
 * components rather than one `variant` prop because they occupy different
 * places: a dot sits inline before a label, a tag sits in a card head, a banner
 * spans the card body, and an empty state replaces the body entirely.
 *
 * `idle` is deliberately a hollow ring rather than a filled grey disc — that is
 * what makes "disabled" distinguishable from "loading" at 8px.
 */
import type { ReactNode } from 'react'

import { cx } from './cx.ts'
import { AlertIcon, CheckCircleIcon, InboxIcon, InfoIcon } from './icons.tsx'

export type StatusKind = 'ok' | 'warn' | 'error' | 'idle' | 'info'

const DOT_CLASS: Record<StatusKind, string> = {
  ok: 'dsp-dot-ok',
  warn: 'dsp-dot-warn',
  error: 'dsp-dot-error',
  idle: 'dsp-dot-idle',
  info: 'dsp-dot-info',
}

export function StatusDot({ kind, title, className }: { kind: StatusKind; title?: string; className?: string }) {
  return <span className={cx('dsp-dot', DOT_CLASS[kind], className)} {...(title === undefined ? {} : { title, role: 'img', 'aria-label': title })} />
}

const TAG_CLASS: Record<StatusKind, string> = {
  ok: 'dsp-tag-ok',
  warn: 'dsp-tag-warn',
  error: 'dsp-tag-error',
  idle: '',
  info: 'dsp-tag-accent',
}

export function Tag({
  kind = 'idle',
  mono,
  children,
  className,
  title,
}: {
  kind?: StatusKind
  /** Monospaced, for values rather than labels. */
  mono?: boolean
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span className={cx('dsp-tag', TAG_CLASS[kind], mono === true && 'dsp-tag-mono', className)} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  )
}

const BANNER_ICON: Record<StatusKind, ReactNode> = {
  ok: <CheckCircleIcon size={14} />,
  warn: <AlertIcon size={14} />,
  error: <AlertIcon size={14} />,
  idle: <InfoIcon size={14} />,
  info: <InfoIcon size={14} />,
}

export function Banner({
  kind = 'info',
  children,
  className,
  icon,
}: {
  kind?: StatusKind
  children: ReactNode
  className?: string
  /** Overrides the kind's default glyph. */
  icon?: ReactNode
}) {
  return (
    <div className={cx('dsp-banner', `dsp-banner-${kind === 'idle' ? 'info' : kind}`, className)} role={kind === 'error' ? 'alert' : undefined}>
      <span className="dsp-banner-icon">{icon ?? BANNER_ICON[kind]}</span>
      <span className="dsp-banner-body">{children}</span>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  /** A call to action, usually a `Button`. */
  action?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('dsp-empty', className)}>
      <span className="dsp-empty-icon">{icon ?? <InboxIcon size={18} />}</span>
      <span className="dsp-empty-title">{title}</span>
      {description !== undefined && <span className="dsp-empty-desc">{description}</span>}
      {action !== undefined && <span className="dsp-empty-actions">{action}</span>}
    </div>
  )
}

export function Skeleton({ widths = ['60%', '40%'], className }: { widths?: string[]; className?: string }) {
  return (
    <div className={cx('dsp-skel-stack', className)} aria-hidden="true">
      {widths.map((w, i) => (
        <span key={i} className="dsp-skel" style={{ width: w }} />
      ))}
    </div>
  )
}
