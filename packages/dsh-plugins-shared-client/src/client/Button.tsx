/**
 * Button.
 *
 * Five variants cover the design: `primary` (brand fill), `secondary` (paper
 * with a hairline), `ghost` (borderless text action), `danger` (borderless
 * destructive text action) and `icon` (square, for row-level actions).
 *
 * `href` renders an anchor instead of a button — the host does the same, and a
 * plugin that links out (a repository URL, a docs page) should not have to
 * decide between a button that navigates and a link that looks like a button.
 */
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

import { cx } from './cx.ts'
import { SpinnerIcon } from './icons.tsx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon'
export type ButtonSize = 'sm' | 'md'

interface CommonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Replaces the leading content with a spinner and blocks interaction. */
  loading?: boolean
  /** Rendered before the label. */
  icon?: ReactNode
  children?: ReactNode
  className?: string
}

type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & {
    href?: undefined
  }

type AnchorProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'className'> & {
    href: string
    /** Opens in a new tab; adds the matching `rel` automatically. */
    newTab?: boolean
  }

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'dsp-btn-primary',
  secondary: 'dsp-btn-secondary',
  ghost: 'dsp-btn-ghost',
  danger: 'dsp-btn-danger',
  icon: 'dsp-btn-icon',
}

function classes(variant: ButtonVariant, size: ButtonSize, className?: string): string {
  return cx('dsp-btn', VARIANT_CLASS[variant], size === 'sm' && 'dsp-btn-sm', className)
}

function content(loading: boolean | undefined, icon: ReactNode, children: ReactNode) {
  if (loading) {
    return (
      <>
        <SpinnerIcon size={14} className="dsp-btn-spin" />
        {children}
      </>
    )
  }
  return (
    <>
      {icon}
      {children}
    </>
  )
}

export function Button(props: ButtonProps | AnchorProps) {
  const { variant = 'secondary', size = 'md', loading, icon, children, className } = props

  if (props.href !== undefined) {
    const { href, newTab, variant: _v, size: _s, loading: _l, icon: _i, className: _c, ...rest } = props
    return (
      <a
        {...rest}
        href={href}
        className={classes(variant, size, className)}
        {...(newTab === true ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      >
        {content(loading, icon, children)}
      </a>
    )
  }

  const { variant: _v, size: _s, loading: _l, icon: _i, className: _c, disabled, ...rest } = props
  return (
    <button {...rest} type={rest.type ?? 'button'} disabled={disabled === true || loading === true} className={classes(variant, size, className)}>
      {content(loading, icon, children)}
    </button>
  )
}
