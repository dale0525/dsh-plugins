/**
 * The provider-card image-payload section: the one provider-level bound that
 * decides when pi-ai stops refusing a request and starts offloading its oldest
 * images instead.
 *
 * It is provider-level, not per-model, because the cost it guards is per
 * request: every image of every turn is base64-encoded into the same body, so
 * one route-wide number is the whole model. That is also where the field lives
 * in pi-ai's own schema (`providers.<route>.maxRequestImageBytes`), which is
 * what makes a hand-edited YAML entry and this control the same setting.
 *
 * Why it needs a UI at all: the default (20 MiB) sits ABOVE the body cap many
 * relays enforce, and an over-cap request is refused by the gateway with a 413
 * before pi-ai can offload anything. A 413 classifies as an invalid request,
 * so the offload-and-retry recovery never fires and the session cannot continue.
 * Lowering this number hands the decision back to pi-ai.
 *
 * Write discipline: nothing is written until Save, and a blank field means
 * "follow the adapter's default" (an `unset`, not a restated default), so the
 * section can never pin a schema default into the user's document.
 *
 * @module dsh-better-reasoning-effort/BudgetEditor
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_IMAGE_BUDGET_BYTES, PLUGIN_ID } from '../constants.js'
import { describeNamespace, providerBudgetOf, writeProviderBudget, type ProviderBudgetReply } from './ops.js'
import type { RemoteApi } from './types.js'

/** Props of {@link BudgetEditor}. */
export interface BudgetEditorProps {
  /** The provider route this card edits. */
  route: string
  /** The write seam. */
  api: RemoteApi
  /** Localized copy. */
  t: (key: string, params?: Record<string, string | number>) => string
}

/** Bytes as the largest whole MiB figure that does not lose a digit. */
export function mibOf(bytes: number): string {
  const value = bytes / (1024 * 1024)
  return `${Number.isInteger(value) ? value : value.toFixed(2)} MiB`
}

/**
 * Read a typed bound.
 * @param text - the field's text, trimmed by the caller.
 * @returns the byte count, `undefined` for a blank field (follow the default),
 * or `null` when the text is not a positive integer.
 */
export function parseBudget(text: string): number | undefined | null {
  if (text.length === 0) return undefined
  if (!/^[0-9]+$/.test(text)) return null
  const bytes = Number(text)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

/**
 * Render the provider card's image-payload section.
 * @param props - route identity, write seam and copy.
 * @returns the section.
 */
export function BudgetEditor({ route, api, t }: BudgetEditorProps): ReactNode {
  /** The stored bound, or undefined when no layer declares one. */
  const [stored, setStored] = useState<number | undefined>(undefined)
  /** The field's text while editing; '' means "follow the default". */
  const [draft, setDraft] = useState('')
  /** Whether the section's details are disclosed. Collapsed on mount. */
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | undefined>(undefined)

  // Seed from the RAW layers. The resolved `value` carries pi-ai's default as
  // if the user had picked it, so seeding from there would write 20 MiB into
  // the document on the first save and hide the inheritance from then on.
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const join = await describeNamespace(api)
        if (!live) return
        const bound = providerBudgetOf(join.namespace, route)
        setStored(bound)
        setDraft(bound === undefined ? '' : String(bound))
        setReadOnly(join.writable !== true)
      } catch {
        if (live) setReadOnly(true)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [api, route])

  const cancel = (): void => {
    setDraft(stored === undefined ? '' : String(stored))
    setEditing(false)
    setMessage(undefined)
  }

  const save = async (): Promise<void> => {
    const text = draft.trim()
    const bytes = parseBudget(text)
    if (bytes === null) {
      setMessage({ kind: 'error', text: t('budgetInvalid') })
      return
    }
    setBusy(true)
    setMessage(undefined)
    let reply: ProviderBudgetReply
    try {
      reply = await writeProviderBudget(api, route, bytes)
    } catch (error) {
      reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    setBusy(false)
    if (!reply.ok) {
      setMessage({
        kind: 'error',
        text: reply.error === 'no-route' ? t('headersNoRoute')
          : reply.error === 'read-only' ? t('headersReadOnly')
            : t('headersError', { error: reply.error }),
      })
      return
    }
    setStored(bytes)
    setEditing(false)
    setMessage({
      kind: 'success',
      text: bytes === undefined ? t('budgetCleared') : t('budgetSaved'),
    })
  }

  const disabled = readOnly || busy
  const defaultText = `${String(DEFAULT_IMAGE_BUDGET_BYTES)} B (${mibOf(DEFAULT_IMAGE_BUDGET_BYTES)})`

  return (
    <div className="bre-headers bre-budget" data-plugin={PLUGIN_ID} data-open={open ? '1' : '0'}>
      <div className="bre-headers-head">
        {editing
          ? <span className="bre-effort-title">{t('budgetTitle')}</span>
          : (
            <button
              type="button"
              className="bre-headers-disclosure"
              aria-expanded={open}
              aria-label={`${t('budgetTitle')} ${route}`}
              onClick={() => { setOpen(!open); setMessage(undefined) }}
            >
              <span className="bre-effort-title">{t('budgetTitle')}</span>
              {/* The one fact worth showing while closed: whether this route
                  overrides the default, and with what. */}
              {loading || stored === undefined
                ? null
                : <span className="bre-headers-count">{mibOf(stored)}</span>}
              <span className="bre-headers-chevron" aria-hidden="true">›</span>
            </button>
          )}
      </div>

      {!open && !editing
        ? null
        : (
          <>
            <p className="bre-effort-note">{t('budgetHint', { default: defaultText })}</p>

            {loading
              ? null
              : editing
                ? (
                  <div className="bre-headers-edit">
                    <label className="bre-headers-row">
                      <span className="bre-effort-title">{t('budgetLabel')}</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="bre-text-input bre-headers-value"
                        value={draft}
                        disabled={disabled}
                        placeholder={String(DEFAULT_IMAGE_BUDGET_BYTES)}
                        aria-label={t('budgetLabel')}
                        onChange={(event) => { setDraft(event.target.value); setMessage(undefined) }}
                      />
                    </label>
                    <p className="bre-effort-note">{t('budgetBlankHint', { default: defaultText })}</p>
                    <div className="bre-effort-actions">
                      <button type="button" className="bre-primary-button" disabled={disabled} onClick={() => { void save() }}>
                        {t('headersSave')}
                      </button>
                      <button type="button" className="bre-secondary-button" disabled={disabled} onClick={cancel}>
                        {t('headersCancel')}
                      </button>
                    </div>
                  </div>
                )
                : (
                  <div className="bre-headers-rows">
                    <p className="bre-effort-note">
                      {stored === undefined
                        ? t('budgetInherited', { default: defaultText })
                        : t('budgetCurrent', { bytes: String(stored), size: mibOf(stored) })}
                    </p>
                    {readOnly
                      ? null
                      : (
                        <div className="bre-effort-actions">
                          <button
                            type="button"
                            className="bre-secondary-button"
                            disabled={disabled}
                            onClick={() => { setEditing(true); setMessage(undefined) }}
                          >
                            {t('headersEdit')}
                          </button>
                        </div>
                      )}
                  </div>
                )}
          </>
        )}

      {message === undefined
        ? null
        : (
          <p className={'bre-effort-message bre-' + message.kind} role={message.kind === 'error' ? 'alert' : 'status'}>
            {message.text}
          </p>
        )}
    </div>
  )
}
