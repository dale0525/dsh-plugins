/**
 * Toggles: `Switch`, `Checkbox`, `Radio`, `Segmented`.
 *
 * Each renders a real control (`button[role=switch]`, `button[role=checkbox]`,
 * `button[role=radio]`, `button[role=tab]`) rather than a styled `<input>`,
 * because the design's switch is a track-and-thumb the native input cannot
 * express, and mixing a native input with a custom visual means maintaining two
 * focus rings. Roles plus `aria-checked`/`aria-selected` keep the accessibility
 * contract while the visual is fully ours.
 */
import type { ReactNode } from 'react'

import { cx } from './cx.ts'
import { CheckIcon } from './icons.tsx'

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  className,
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
  /** Accessible name when the switch is not wrapped by a `Field`. */
  label?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      {...(label === undefined ? {} : { 'aria-label': label })}
      className={cx('dsp-switch', className)}
      disabled={disabled}
      onClick={() => {
        onCheckedChange(!checked)
      }}
    >
      <span className={cx('dsp-switch-track', checked && 'dsp-switch-track-on')}>
        <span className="dsp-switch-thumb" />
      </span>
    </button>
  )
}

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  children,
  className,
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
  /** Visible label; doubles as the accessible name. */
  children?: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={cx('dsp-check', className)}
      disabled={disabled}
      onClick={() => {
        onCheckedChange(!checked)
      }}
    >
      <span className={cx('dsp-check-box', checked && 'dsp-check-box-on')}>{checked && <CheckIcon size={10} strokeWidth={3.2} />}</span>
      {children !== undefined && <span className="dsp-check-label">{children}</span>}
    </button>
  )
}

export function Radio({
  checked,
  onSelect,
  disabled,
  children,
  className,
}: {
  checked: boolean
  onSelect: () => void
  disabled?: boolean
  children?: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={cx('dsp-check', className)}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className={cx('dsp-check-box dsp-radio-box', checked && 'dsp-check-box-on')}>{checked && <span className="dsp-radio-dot" />}</span>
      {children !== undefined && <span className="dsp-check-label">{children}</span>}
    </button>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

/**
 * Segmented control.
 *
 * Uses `role="radiogroup"` with `role="radio"` children rather than a tablist:
 * the segments pick a value, they do not switch panels, and a tablist would
 * promise arrow-key panel switching the component does not do. Arrow keys move
 * the selection, which is the radiogroup contract.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
  label,
}: {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (next: T) => void
  disabled?: boolean
  className?: string
  label?: string
}) {
  const move = (from: number, delta: number) => {
    for (let i = 1; i <= options.length; i += 1) {
      const next = (from + delta * i + options.length * i) % options.length
      const candidate = options[next]
      if (candidate !== undefined && candidate.disabled !== true) {
        onChange(candidate.value)
        return
      }
    }
  }

  return (
    <div
      role="radiogroup"
      {...(label === undefined ? {} : { 'aria-label': label })}
      className={cx('dsp-seg', className)}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled === true || option.disabled === true}
            className={cx('dsp-seg-item', selected && 'dsp-seg-item-on')}
            onClick={() => {
              onChange(option.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                move(index, 1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(index, -1)
              }
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
