/**
 * Models-page footer editor for the two auxiliary model calls this plugin can
 * steer through settings.
 *
 * The owning plugin rows are `verbatim-compaction-purpose` (compaction) and
 * `worktree-session` (worktree branch naming). Their Config rows carry three
 * optional scalars; this component is the one place a user edits both. All
 * selectable routes come from the RAW USER layer of `llm-pi-ai.providers`, so
 * an option always names a model the deployment configured itself.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { PLUGIN_ID } from '../constants.js'
import {
  PURPOSE_NAMESPACES,
  effortsOf,
  purposeOps,
  purposeStateOf,
  type ConfiguredModel,
  type Purpose,
  type PurposeOverride,
  type PurposeState,
} from '../purpose-overrides.js'
import type { ClientContext, RemoteApi, SlotRegistrarFace } from './types.js'

/** The sanctioned footer seat. */
const SLOT = 'settings.models.footer'

/** The two rows, in the fixed order the editor renders. */
const PURPOSES: readonly { purpose: Purpose; namespace: string; titleKey: string; hintKey: string }[] = [
  {
    purpose: 'compaction',
    namespace: PURPOSE_NAMESPACES.compaction,
    titleKey: 'purposeCompactionTitle',
    hintKey: 'purposeCompactionHint',
  },
  {
    purpose: 'worktreeBranch',
    namespace: PURPOSE_NAMESPACES.worktreeBranch,
    titleKey: 'purposeWorktreeTitle',
    hintKey: 'purposeWorktreeHint',
  },
]

/** Props the list slot's inject callback contributes. */
export interface PurposeOverridesProps {
  api: RemoteApi
  t: Translate
}

/** Render one purpose's two selects. */
function PurposeRow(props: {
  title: string
  hint: string
  models: readonly ConfiguredModel[]
  override: PurposeOverride
  t: Translate
  disabled: boolean
  reason?: string
  onChange(next: PurposeOverride): void
}): ReactNode {
  const { title, hint, models, override, t, disabled, reason, onChange } = props
  const route = override.provider !== undefined && override.model !== undefined
    ? JSON.stringify([override.provider, override.model])
    : ''
  const selected = models.find(model => model.provider === override.provider && model.model === override.model)
  const efforts = selected === undefined ? [] : effortsOf(models, selected.provider, selected.model)
  const levelKey = (key: string): string => {
    const level = `level_${key}`
    return t(level) === level ? key : t(level)
  }
  return (
    <div className={`bre-purpose-row${disabled ? ' bre-purpose-row-disabled' : ''}`}>
      <div className="bre-purpose-title">{title}</div>
      <div className="bre-purpose-hint">{reason === undefined ? hint : reason}</div>
      <label className="bre-purpose-field">
        <span>{t('purposeModelLabel')}</span>
        <select
          aria-label={`${title}: ${t('purposeModelLabel')}`}
          disabled={disabled}
          value={route}
          onChange={(event) => {
            const pair: unknown = event.target.value === '' ? undefined : JSON.parse(event.target.value)
            onChange(Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
              ? { provider: pair[0], model: pair[1] }
              : { reasoningEffort: override.reasoningEffort })
          }}
        >
          <option value="">{t('purposeFollowChat')}</option>
          {models.map(model => (
            <option key={JSON.stringify([model.provider, model.model])} value={JSON.stringify([model.provider, model.model])}>
              {model.provider} / {model.model}
            </option>
          ))}
        </select>
      </label>
      <label className="bre-purpose-field">
        <span>{t('purposeEffortLabel')}</span>
        <select
          aria-label={`${title}: ${t('purposeEffortLabel')}`}
          disabled={disabled}
          value={override.reasoningEffort ?? ''}
          onChange={(event) => onChange({
            ...(override.provider === undefined || override.model === undefined
              ? {}
              : { provider: override.provider, model: override.model }),
            reasoningEffort: event.target.value,
          })}
        >
          <option value="">{t('purposeEffortUnset')}</option>
          {efforts.map(effort => <option key={effort} value={effort}>{levelKey(effort)}</option>)}
        </select>
      </label>
    </div>
  )
}

/**
 * Render the unified footer editor.
 *
 * A change writes immediately through one optimistic-lock mutate for the row it
 * belongs to; a conflict is reported rather than silently retried with a stale
 * revision. The next describe refreshes the fences.
 */
export function PurposeOverrides({ api, t }: PurposeOverridesProps): ReactNode {
  const [snapshot, setSnapshot] = useState<PurposeState>({
    models: [],
    overrides: { compaction: {}, worktreeBranch: {} },
    revisions: { compaction: undefined, worktreeBranch: undefined },
    writable: false,
  })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const response = await api.settings.describe()
    if (response.ok) setSnapshot(purposeStateOf(response.value))
  }

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const response = await api.settings.describe()
        if (live && response.ok) setSnapshot(purposeStateOf(response.value))
      } catch {
        if (live) setMessage(t('purposeReadError'))
      }
    })()
    return () => { live = false }
  }, [api, t])

  const commit = async (purpose: Purpose, override: PurposeOverride): Promise<void> => {
    const row = PURPOSES.find(entry => entry.purpose === purpose)
    if (row === undefined || busy) return
    setBusy(true)
    try {
      const response = await api.settings.mutate(
        row.namespace,
        purposeOps(override),
        snapshot.revisions[purpose],
      )
      if (!response.ok) {
        setMessage(response.error.code === 'settings/conflict'
          ? t('purposeConflict')
          : `${t('purposeSaveFailed')}: ${response.error.message}`)
        if (response.error.code === 'settings/conflict') await refresh()
        return
      }
      setMessage(t('purposeSaved'))
      await refresh()
    } catch (error) {
      setMessage(`${t('purposeSaveFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bre-purpose-editor" aria-label={t('purposeTitle')}>
      <div className="bre-purpose-head">{t('purposeTitle')}</div>
      <div className="bre-purpose-hint">{t('purposeHint')}</div>
      {PURPOSES.map(row => (
        <PurposeRow
          key={row.purpose}
          title={t(row.titleKey)}
          hint={t(row.hintKey)}
          models={snapshot.models}
          override={snapshot.overrides[row.purpose]}
          t={t}
          disabled={!snapshot.writable || busy || snapshot.revisions[row.purpose] === undefined}
          {...(!snapshot.writable ? { reason: t('purposeReadOnly') }
            : snapshot.revisions[row.purpose] === undefined ? { reason: t('purposeNamespaceMissing') }
              : {})}
          onChange={(next) => { void commit(row.purpose, next) }}
        />
      ))}
      {message !== '' ? <div className="bre-purpose-message">{message}</div> : null}
    </section>
  )
}

/** Take a second seat on the Models-page footer. */
export function registerPurposeOverridesSlot(ctx: ClientContext, api: RemoteApi, t: Translate): () => void {
  const host = ctx as unknown as { slots?: SlotRegistrarFace }
  const injected = host.slots?.inject(SLOT, () => {
    host.slots?.register({
      name: SLOT,
      id: `${PLUGIN_ID}-purpose-overrides`,
      order: 20,
      inject: () => ({ api, t }),
    }, PurposeOverrides)
  })
  return typeof injected === 'function' ? injected as () => void : () => {}
}
