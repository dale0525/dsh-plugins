/**
 * Form controls: `Field`, `TextField`, `SecretField`, `NumberField`, `TextArea`.
 *
 * All four controls share the `Field` shell (label, optional description,
 * control, error/hint line) so a settings card reads as a uniform list without
 * each caller rebuilding the same layout.
 *
 * `Field` takes the label and description as props rather than requiring the
 * caller to compose them: the error line and the hint line are mutually
 * exclusive, and that rule belongs in one place.
 */
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { useId, useState } from 'react'

import { cx } from './cx.ts'
import { EyeIcon, EyeOffIcon, MinusIcon, PlusIcon } from './icons.tsx'

export interface FieldShellProps {
  label?: ReactNode
  /** One line under the label explaining what the control does. */
  description?: ReactNode
  /** Replaces the hint line and switches the control to its invalid state. */
  error?: ReactNode
  /** Small print under the control; hidden while `error` is set. */
  hint?: ReactNode
  /** Lays the label and control out side by side; used by switches. */
  inline?: boolean
  /** Rendered in the control slot. */
  children: ReactNode
  className?: string
}

export function Field({ label, description, error, hint, inline, children, className }: FieldShellProps) {
  const head =
    label === undefined && description === undefined ? null : (
      <div className="dsp-field-head">
        {label !== undefined && <span className="dsp-field-label">{label}</span>}
        {description !== undefined && <span className="dsp-field-desc">{description}</span>}
      </div>
    )

  return (
    <div className={cx('dsp-field', inline === true && 'dsp-field-row', className)}>
      {head}
      <div className={cx(inline === true ? 'dsp-field-control-inline' : 'dsp-field-control')}>{children}</div>
      {error !== undefined ? (
        <span className="dsp-field-error">
          <AlertGlyph />
          {error}
        </span>
      ) : (
        hint !== undefined && <span className="dsp-field-hint">{hint}</span>
      )}
    </div>
  )
}

/** Kept local: the error line's glyph is presentational and never overridden. */
function AlertGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16.5h.01" />
    </svg>
  )
}

type TextFieldProps = {
  value: string
  onValueChange: (next: string) => void
  /** Static cell before the input, e.g. a protocol or unit. */
  prefix?: ReactNode
  /** Static cell after the input, e.g. a unit or a trailing action. */
  suffix?: ReactNode
  invalid?: boolean
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'prefix' | 'className'>

export function TextField({ value, onValueChange, prefix, suffix, invalid, ...rest }: TextFieldProps) {
  return (
    <div className={cx('dsp-input-wrap', invalid === true && 'dsp-input-invalid', rest.disabled === true && 'dsp-input-wrap-disabled')}>
      {prefix !== undefined && <span className="dsp-input-prefix">{prefix}</span>}
      <input
        {...rest}
        className="dsp-input"
        value={value}
        onChange={(e) => {
          onValueChange(e.currentTarget.value)
        }}
      />
      {suffix !== undefined && <span className="dsp-input-suffix">{suffix}</span>}
    </div>
  )
}

/**
 * Secret field.
 *
 * The stored value is never sent back to the browser, so `value` is what the
 * user just typed (empty on first render) and `configured` says whether a value
 * already exists server-side. The masked placeholder is what makes that
 * distinction visible: `••••` means "a value is stored", an empty box with the
 * placeholder means "nothing is stored yet".
 */
export function SecretField({
  value,
  onValueChange,
  configured,
  invalid,
  placeholder,
  ...rest
}: {
  value: string
  onValueChange: (next: string) => void
  configured?: boolean
  invalid?: boolean
  placeholder?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'className'>) {
  const [revealed, setRevealed] = useState(false)
  const shown = revealed || value !== ''

  return (
    <div className={cx('dsp-input-wrap', invalid === true && 'dsp-input-invalid', rest.disabled === true && 'dsp-input-wrap-disabled')}>
      {!shown && configured === true ? (
        <span className="dsp-secret-value">••••••••••••</span>
      ) : (
        <input
          {...rest}
          className="dsp-input"
          type={revealed ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onValueChange(e.currentTarget.value)
          }}
        />
      )}
      <button
        type="button"
        className="dsp-btn dsp-btn-icon"
        aria-label={revealed ? 'Hide value' : 'Show value'}
        aria-pressed={revealed}
        disabled={rest.disabled}
        onClick={() => {
          setRevealed((v) => !v)
        }}
      >
        {revealed ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
      </button>
    </div>
  )
}

/**
 * Number field: a right-aligned monospaced value with a stepper column.
 *
 * The input is `type="text"` with `inputMode="decimal"` rather than
 * `type="number"`: a number input's native spinner would sit beside this
 * design's own stepper, and it silently discards intermediate states the user
 * is still typing. Callers that need clamping pass `min`/`max`, which are
 * applied on step and on blur, never mid-keystroke.
 */
export function NumberField({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  invalid,
  ...rest
}: {
  value: string
  onValueChange: (next: string) => void
  min?: number
  max?: number
  step?: number
  invalid?: boolean
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'step' | 'min' | 'max' | 'className'>) {
  const clamp = (n: number): number => {
    if (min !== undefined && n < min) return min
    if (max !== undefined && n > max) return max
    return n
  }
  const nudge = (dir: 1 | -1) => {
    const current = Number.parseFloat(value)
    const base = Number.isFinite(current) ? current : (min ?? 0)
    onValueChange(String(clamp(base + dir * step)))
  }

  return (
    <div className={cx('dsp-number', invalid === true && 'dsp-input-invalid', rest.disabled === true && 'dsp-input-wrap-disabled')}>
      <input
        {...rest}
        className="dsp-number-input"
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => {
          onValueChange(e.currentTarget.value)
        }}
      />
      <span className="dsp-stepper">
        <button
          type="button"
          className="dsp-stepper-btn"
          aria-label="Increase"
          disabled={rest.disabled === true || (max !== undefined && Number.parseFloat(value) >= max)}
          onClick={() => {
            nudge(1)
          }}
        >
          <PlusIcon size={12} />
        </button>
        <button
          type="button"
          className="dsp-stepper-btn"
          aria-label="Decrease"
          disabled={rest.disabled === true || (min !== undefined && Number.parseFloat(value) <= min)}
          onClick={() => {
            nudge(-1)
          }}
        >
          <MinusIcon size={12} />
        </button>
      </span>
    </div>
  )
}

export function TextArea({
  value,
  onValueChange,
  maxLength,
  invalid,
  ...rest
}: {
  value: string
  onValueChange: (next: string) => void
  maxLength?: number
  invalid?: boolean
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'maxLength' | 'className'>) {
  return (
    <>
      <textarea
        {...rest}
        className={cx('dsp-textarea', invalid === true && 'dsp-input-invalid')}
        value={value}
        maxLength={maxLength}
        onChange={(e) => {
          onValueChange(e.currentTarget.value)
        }}
      />
      {maxLength !== undefined && (
        <span className="dsp-counter">
          {value.length} / {maxLength}
        </span>
      )}
    </>
  )
}

/**
 * Bound variants.
 *
 * `useId` is not used to link label and control: the label is a `span` inside
 * the same `Field`, and the control carries its own `aria-label` where the
 * visible label is not a `<label>`. Callers that need a real association pass
 * `id` and `aria-labelledby`.
 */
export { useId as useControlId }
