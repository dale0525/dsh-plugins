/**
 * Layout: `SettingsCard`, `CardSection`, `ReadonlySummary`, `ListEditor`.
 *
 * `SettingsCard` is the shell every plugin's settings page is built from: a
 * title row (with room for a status dot or tag), an optional description, and a
 * body of fields. Collapsible when the card is long enough to warrant it.
 */
import type { ReactNode } from 'react'
import { useState } from 'react'

import { cx } from './cx.ts'
import { ChevronRightIcon, PlusIcon, TrashIcon } from './icons.tsx'
import { Button } from './Button.tsx'
import { TextField } from './fields.tsx'

export function SettingsCard({
  title,
  description,
  aside,
  children,
  collapsible,
  defaultOpen = true,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  /** Rendered at the right edge of the title row — a tag, a switch, a button. */
  aside?: ReactNode
  children?: ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const showBody = children !== undefined && (collapsible !== true || open)

  const titles = (
    <span className="dsp-card-titles">
      <span className="dsp-card-title">{title}</span>
      {description !== undefined && <span className="dsp-card-desc">{description}</span>}
    </span>
  )

  return (
    <section className={cx('dsp-card', 'dsp-root', className)}>
      <div className="dsp-card-head">
        {collapsible === true ? (
          <button type="button" className="dsp-card-toggle" aria-expanded={open} onClick={() => { setOpen((v) => !v) }}>
            {titles}
            <span className={cx('dsp-chevron', open && 'dsp-chevron-open')}>
              <ChevronRightIcon size={14} />
            </span>
          </button>
        ) : (
          titles
        )}
        {aside !== undefined && <span className="dsp-card-aside">{aside}</span>}
      </div>
      {showBody && <div className="dsp-card-body">{children}</div>}
    </section>
  )
}

/**
 * Read-only summary.
 *
 * Rendered when a plugin has no `Config` schema: instead of an empty form the
 * page shows what the plugin actually reads, so the user can tell "nothing to
 * configure" from "configuration not loaded yet".
 */
export function ReadonlySummary({
  rows,
  className,
}: {
  rows: ReadonlyArray<{ label: ReactNode; value?: ReactNode }>
  className?: string
}) {
  return (
    <div className={cx('dsp-summary', className)}>
      {rows.map((row, i) => (
        <div key={i} className="dsp-summary-pair">
          <span className="dsp-summary-label">{row.label}</span>
          <span className={cx('dsp-summary-value', (row.value === undefined || row.value === '') && 'dsp-summary-value-empty')}>
            {row.value === undefined || row.value === '' ? '未设置' : row.value}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * List editor — an ordered list of plain strings with add and remove.
 *
 * Used for model catalogues, allowed origins and similar. Values are kept as
 * strings and the caller parses, because the shapes that need this control are
 * all "a list of small text values", and a generic object editor would be a
 * much larger component for no additional use.
 */
export function ListEditor({
  items,
  onChange,
  placeholder,
  addLabel = 'Add',
  emptyLabel,
  className,
}: {
  items: readonly string[]
  onChange: (next: string[]) => void
  placeholder?: string
  addLabel?: string
  /** Shown inside the block while the list is empty. */
  emptyLabel?: string
  className?: string
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const value = draft.trim()
    if (value === '') return
    onChange([...items, value])
    setDraft('')
  }

  return (
    <div className={cx('dsp-list-root', className)}>
      {items.length === 0 ? (
        emptyLabel !== undefined && <div className="dsp-list-empty">{emptyLabel}</div>
      ) : (
        <div className="dsp-list">
          {items.map((item, index) => (
            <div key={`${item}-${index}`} className="dsp-list-row">
              <span className="dsp-list-value">{item}</span>
              <Button
                variant="icon"
                aria-label={`Remove ${item}`}
                onClick={() => {
                  onChange(items.filter((_, i) => i !== index))
                }}
              >
                <TrashIcon size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="dsp-list-add">
        <TextField
          value={draft}
          onValueChange={setDraft}
          placeholder={placeholder}
          aria-label={addLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button variant="secondary" className="dsp-list-add-btn" icon={<PlusIcon size={14} />} disabled={draft.trim() === ''} onClick={add}>
          {addLabel}
        </Button>
      </div>
    </div>
  )
}
