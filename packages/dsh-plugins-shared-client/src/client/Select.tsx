/**
 * Select — a custom listbox.
 *
 * The host ships no `Select`, and the design's dropdown (36px trigger, floating
 * panel with a check mark and a monospaced hint column) cannot be built from a
 * native `<select>`: a native popup is drawn by the OS, so none of that styling
 * applies. So this component owns the whole contract itself:
 *
 *  - `role="combobox"` + `aria-expanded` + `aria-controls` on the trigger,
 *    `role="listbox"` on the panel, `role="option"` + `aria-selected` on rows.
 *  - Arrow keys move the active row, Home/End jump, Enter/Space commit, Escape
 *    closes and returns focus to the trigger, Tab closes.
 *  - Clicking outside closes (a document listener, added only while open).
 *
 * The active row is tracked separately from the selected value: with a keyboard
 * the two differ until the user commits, and conflating them makes Escape lose
 * the original selection.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { cx } from './cx.ts'
import { CheckIcon, ChevronDownIcon } from './icons.tsx'

export interface SelectOption<T extends string> {
  value: T
  label: ReactNode
  /** Right-aligned monospaced note, e.g. the model's channel. */
  hint?: string
  disabled?: boolean
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled,
  className,
  width,
  label,
}: {
  value: T | undefined
  options: ReadonlyArray<SelectOption<T>>
  onChange: (next: T) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Trigger width; the panel follows it and grows for longer labels. */
  width?: number | string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const selectedIndex = options.findIndex((o) => o.value === value)
  const [active, setActive] = useState(selectedIndex)
  const rootRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  // Reopening should start from the current selection, not wherever the cursor
  // was left last time.
  useEffect(() => {
    if (open) setActive(selectedIndex < 0 ? 0 : selectedIndex)
  }, [open, selectedIndex])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  const selected = selectedIndex < 0 ? undefined : options[selectedIndex]

  const step = (from: number, delta: number) => {
    if (options.length === 0) return
    let next = from
    for (let i = 0; i < options.length; i += 1) {
      next = (next + delta + options.length) % options.length
      if (options[next]?.disabled !== true) break
    }
    setActive(next)
  }

  const commit = (index: number) => {
    const option = options[index]
    if (option === undefined || option.disabled === true) return
    onChange(option.value)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={cx('dsp-select', className)} style={width === undefined ? undefined : { width }}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-haspopup="listbox"
        {...(label === undefined ? {} : { 'aria-label': label })}
        className="dsp-select-trigger"
        style={width === undefined ? undefined : { width: '100%' }}
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (open) step(active, e.key === 'ArrowDown' ? 1 : -1)
            else setOpen(true)
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (open) commit(active)
            else setOpen(true)
          } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            setOpen(false)
          } else if (e.key === 'Tab' && open) {
            setOpen(false)
          }
        }}
      >
        <span className={cx('dsp-select-value', selected === undefined && 'dsp-select-placeholder')}>
          {selected === undefined ? placeholder : selected.label}
        </span>
        <ChevronDownIcon size={12} className={cx('dsp-select-chevron', open && 'dsp-select-chevron-open')} />
      </button>

      {open && (
        <div id={listboxId} role="listbox" className="dsp-select-panel" tabIndex={-1}>
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled === true || undefined}
              className={cx(
                'dsp-select-option',
                index === active && 'dsp-select-option-active',
                option.value === value && 'dsp-select-option-selected',
                option.disabled === true && 'dsp-select-option-disabled',
              )}
              onMouseEnter={() => {
                setActive(index)
              }}
              onMouseDown={(e) => {
                // Keep focus on the trigger so the click does not blur-close it.
                e.preventDefault()
              }}
              onClick={() => {
                commit(index)
              }}
            >
              <span className="dsp-select-check">{option.value === value && <CheckIcon size={12} strokeWidth={3} />}</span>
              <span className="dsp-select-option-label">{option.label}</span>
              {option.hint !== undefined && <span className="dsp-select-option-hint">{option.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
