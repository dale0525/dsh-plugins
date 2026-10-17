/**
 * The dsh-imagegen settings card: channel management (list rows with status
 * dots, an editor dialog with the model-catalog alias → upstream mapping, and
 * built-in provider presets), plus the prompt-enhancement model and the plugin
 * switches. Registers as the row's configuration entry on the Plugins page
 * (`plugins.row.config`), independent of the dsh-web-ui family group, bound to
 * the plugin's own bridge settings scope.
 *
 * The interaction mirrors the host's model-provider page: one row per channel
 * (status dot + edit/delete), two add buttons (built-in provider / custom),
 * and an editor holding API key, display name, API URL, and the model catalog
 * with detection.
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CardForm, secretField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import { ChannelsForm, type ChannelDraft, type ChannelsFormActions, type ChannelsFormState } from './channels-form.ts'
import type { ImageGenScope } from './settings-scope.ts'
import { describeModel } from '../model-catalog.ts'
import { IMAGE_MODEL_API, IMAGEGEN_SETTINGS_NAMESPACE, PRESETS_API, PROMPT_ENHANCE_API, type ModelMapping, type PresetProviderView } from '../protocol.ts'
import type { ImageGenKey } from './locales.ts'
import { tt, type TranslateValues } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import {
  Button,
  Checkbox,
  ConfigForm,
  SecretField,
  Select,
  StatusDot,
  Tag,
  TextField,
} from '@logictan/dsh-plugins-shared-client/client'
import css from './settings-card.module.css'

/** The global (non-channel) fields this card's staged form edits. */
export interface ImageGenSettings {
  enabled?: boolean
  announceToAgent?: boolean
  allowAgentImageGeneration?: boolean
  promptApiUrl?: string
  promptApiKey?: string
  promptModel?: string
}

/** What the card renders. */
export interface ImageGenSettingsCardState extends CardShell {
  /** Channel list staging (channels + per-channel key edits + default). */
  channels: ChannelsFormState
  /** Master switch. */
  enabled: CardFieldState
  /** System-prompt announcement flag. */
  announceToAgent: CardFieldState
  allowAgentImageGeneration: CardFieldState
  promptApiUrl: CardFieldState
  promptApiKey: CardFieldState
  promptModel: CardFieldState
}

/**
 * The schema mirror the shared `ConfigForm` reads its field list from.
 *
 * The host's `configForms.describe()` does not carry this namespace: the plugin
 * re-serves it over its own bridge (`/api/dsh-imagegen/settings/*`) so the key
 * writes can be diverted into the credential store. The bridge does return the
 * schema envelope, so the scope snapshot carries it and this adapter presents it
 * in the shape the form expects.
 *
 * The snapshot object is cached per schema identity. `useSyncExternalStore`
 * compares snapshots by reference, so rebuilding it on every `getSnapshot()`
 * call would re-render without end.
 */
function createSchemaMirror(scope: ImageGenScope): { getSnapshot: () => { status: string; view?: { namespaces: Array<{ ns: string; schema?: unknown }> } }; subscribe: (listener: () => void) => () => void } {
  let cachedSchema: unknown
  let cached: { status: string; view?: { namespaces: Array<{ ns: string; schema?: unknown }> } } = {
    status: 'loading',
    view: { namespaces: [] },
  }
  return {
    getSnapshot() {
      const snapshot = scope.getSnapshot()
      const schema = snapshot.schema
      if (schema !== cachedSchema) {
        cachedSchema = schema
        cached = {
          status: snapshot.status,
          view: {
            namespaces: schema === undefined
              ? []
              : [{ ns: IMAGEGEN_SETTINGS_NAMESPACE, schema }],
          },
        }
      }
      return cached
    },
    subscribe(listener) {
      return scope.subscribe(listener)
    },
  }
}

/**
 * Present the bridge scope as the shared form's handle.
 *
 * The only difference is the value's static type: the plugin declares
 * `ImageGenConfig` (an interface, so no index signature) while the form takes a
 * plain record. They are the same object at runtime; widening here keeps the
 * plugin's own interface precise instead of adding an index signature to it.
 */
function asConfigFormHandle(scope: ImageGenScope): {
  getSnapshot: () => { status: 'loading' | 'ready' | 'unavailable'; value: Record<string, unknown> | undefined; writable: boolean; revision: number | undefined }
  subscribe: (listener: () => void) => () => void
  mutate: (ops: ReadonlyArray<{ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] }>, expectedRevision?: number) => Promise<boolean>
} {
  return {
    getSnapshot() {
      const snapshot = scope.getSnapshot()
      return {
        status: snapshot.status,
        value: snapshot.value as Record<string, unknown> | undefined,
        writable: snapshot.writable,
        revision: snapshot.revision,
      }
    },
    subscribe(listener) {
      return scope.subscribe(listener)
    },
    mutate(ops, expectedRevision) {
      return scope.mutate(ops as Parameters<ImageGenScope['mutate']>[0], expectedRevision)
    },
  }
}

/** The registration-side face the card's slot entry injects. */
export interface ImageGenSettingsCardFace extends CardActions {
  /** Channel staging actions (committed together with the card's save). */
  channels: ChannelsFormActions
  /** The bridge scope itself, which the shared form writes through. */
  settingsScope: ImageGenScope
  /** The schema mirror the shared form reads its field list from. */
  schemaMirror: ReturnType<typeof createSchemaMirror>
  hooks: {
    /** Card snapshot bound by the renderer as useImageGenSettingsCard. */
    imageGenSettingsCard: SnapshotStore<ImageGenSettingsCardState>
  }
}

/** Bridges the imagegen scope onto the card's staged forms. */
export class ImageGenSettingsCardController {
  private readonly form: CardForm<ImageGenSettings>
  private readonly channelsForm: ChannelsForm

  /** @param scope - the bound bridge scope for the dsh-imagegen namespace. */
  constructor(private readonly scope: ImageGenScope) {
    // Only the key stays staged here. The five scalar settings are rendered and
    // committed by the shared `ConfigForm` straight through this scope, so they
    // are no longer part of this form; the key must stay because a write to it
    // is diverted into the credential store by the bridge, which is what keeps
    // it out of the settings document.
    this.form = new CardForm(scope, [
      secretField('promptApiKey'),
    ], {
      secretSettled: (field) => this.scope.getSecretSetSnapshot(field),
    })
    this.channelsForm = new ChannelsForm(scope)
  }

  private projection(): ImageGenSettingsCardState {
    const shell = this.form.shell()
    return {
      ...shell,
      dirty: shell.dirty || this.channelsForm.snapshot().dirty,
      channels: this.channelsForm.snapshot(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      allowAgentImageGeneration: this.form.field('allowAgentImageGeneration'),
      promptApiUrl: this.form.field('promptApiUrl'),
      promptApiKey: this.form.field('promptApiKey'),
      promptModel: this.form.field('promptModel'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and the form/channel actions.
   */
  inject(): ImageGenSettingsCardFace {
    const cardStore = this.form.bind(() => this.projection())
    this.channelsForm.subscribe(() => { cardStore.set(this.projection()) })
    return {
      hooks: {
        imageGenSettingsCard: cardStore,
      },
      channels: this.channelsForm.actions(),
      settingsScope: this.scope,
      schemaMirror: createSchemaMirror(this.scope),
      ...this.form.actions(),
    }
  }
}

/** Props the renderer binds for this card. */
export type ImageGenSettingsCardProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

/**
 * Render the card.
 *
 * The Plugins page renders every configuration entry twice: once as the
 * one-liner under the row's title (`view: 'summary'`) and once as the body of
 * the row's own page (`view: 'page'`). The page draws the row id, the module
 * name, and the crumb itself, so this component supplies only the copy and the
 * form. The summary branch returns before the form's hooks and state so the
 * one-liner does no work.
 *
 * @param props - the view asked for, locale copy, the card snapshot, and the form actions.
 * @returns the one-liner, the card, or nothing while the namespace is loading.
 */
export function ImageGenSettingsCard(props: ImageGenSettingsCardProps) {
  // The summary view is the one-liner the page places under the row's title.
  // It returns before any hook or state so it does no work: the page re-renders
  // the entry when the active locale moves, so the copy still follows a
  // language switch without this component subscribing to it.
  if (props.view === 'summary') return tt('settings.summary')
  // The card renders through the plugin's own dictionary so the uiLanguage
  // override applies here too — the host-locale props.t would only follow the
  // DSH interface language.
  const t = tt
  useImageGenLanguageTick()
  const state = props.useImageGenSettingsCard(snapshot => snapshot)
  // `promptModel` belongs to the shared form now, so the detection picker below
  // reads it from the scope rather than from this card's staged state.
  const liveModel = props.settingsScope.getSnapshot().value?.promptModel ?? ''
  const [open, setOpen] = useState(false)
  // Global-section local states (prompt enhancement etc.).
  const [promptModels, setPromptModels] = useState<string[]>([])
  const [loadingPromptModels, setLoadingPromptModels] = useState(false)
  const [promptModelsError, setPromptModelsError] = useState<string | null>(null)
  const [manualPromptModelOpen, setManualPromptModelOpen] = useState(false)
  const [manualPromptModel, setManualPromptModel] = useState('')
  const [enhancementOpen, setEnhancementOpen] = useState(false)
  const [promptApiOpen, setPromptApiOpen] = useState(false)
  // Channel list local states.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [presetPickerOpen, setPresetPickerOpen] = useState(false)
  const [presets, setPresets] = useState<PresetProviderView[]>([])
  const [presetError, setPresetError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  if (!state.available) return null
  const title = t('settings.title')
  const blocked = !state.dirty || state.invalid || state.saving || state.channels.saving
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }

  if (!state.exposed) {
    return (
      <li className={css.card}>
        <button
          type="button"
          className={css.header}
          aria-expanded={open}
          aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.headText}>
            <span className={css.name}>{title}</span>
            <span className={css.description}>{t('settings.description')}</span>
          </span>
          <span className={open ? css.chevronOpen : css.chevron}>▾</span>
        </button>
        {open
          ? (
            <div className={css.body}>
              <p className={css.notExposed} role="status">{t('settings.notExposed')}</p>
            </div>
          )
          : null}
      </li>
    )
  }

  const channels = state.channels.channels
  const editing = editingId === null ? undefined : channels.find(channel => channel.id === editingId)

  return (
    <li className={css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <span className={open ? css.chevronOpen : css.chevron}>▾</span>
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('settings.readOnly')}</p> : null}

            {/*
              The five scalar settings are the schema's, rendered by the shared
              form: `enabled`, `announceToAgent`, `allowAgentImageGeneration`,
              `promptApiUrl`, `promptModel`. They commit on blur, which is the
              interaction the design specifies and the only one this slot can
              express — the host page owns no save band a plugin can reach.

              Everything below stays hand-written because a schema cannot
              describe it: the channel list is a structured editor over an array
              of objects, and the two key inputs write through this plugin's
              bridge, which diverts them into the credential store. The host's
              settings service has no such diversion — it would put them in
              settings.yaml in plaintext — so they must not become schema fields.
            */}
            <div className={css.schemaSection}>
              <ConfigForm
                namespace={IMAGEGEN_SETTINGS_NAMESPACE}
                form={asConfigFormHandle(props.settingsScope)}
                describe={props.schemaMirror}
                title={t('settings.scalarsTitle')}
              >
            <section className={css.channelSection} aria-label={t('channels.title')}>
              <div className={css.sectionHeader}>
                <div>
                  <h3 className={css.sectionTitle}>{t('channels.title')}</h3>
                  <p className={css.sectionHint}>{t('channels.hint')}</p>
                </div>
              </div>
              {channels.length === 0
                ? <p className={css.channelEmpty}>{t('channels.empty')}</p>
                : (
                  <ul className={css.channelList}>
                    {channels.map(channel => {
                      const keyHeld = state.channels.keySet[channel.id] === true
                      const ready = keyHeld && channel.models.length > 0
                      const isDefault = channel.id === state.channels.defaultChannelId
                      if (confirmDeleteId === channel.id) {
                        return (
                          <li key={channel.id} className={css.channelRow} data-action>
                            <span className={css.deleteConfirmText}>{t('channels.deleteConfirmTitle', { name: channel.name || t('channels.untitled') })}</span>
                            <Button variant="danger" size="sm" disabled={disabled} onClick={() => { props.channels.setChannels(channels.filter(candidate => candidate.id !== channel.id)); if (isDefault && channels.length > 1) { const next = channels.find(candidate => candidate.id !== channel.id); if (next !== undefined) props.channels.setDefaultChannel(next.id) } setConfirmDeleteId(null); if (editingId === channel.id) setEditingId(null) }}>{t('channels.confirm')}</Button>
                            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setConfirmDeleteId(null) }}>{t('channels.cancel')}</Button>
                          </li>
                        )
                      }
                      return (
                        <li key={channel.id} className={css.channelRow}>
                          <StatusDot kind={ready ? 'ok' : 'warn'} title={t(ready ? 'channels.statusReady' : 'channels.statusIncomplete')} />
                          <button type="button" className={css.channelMain} disabled={disabled} onClick={() => { setEditingId(channel.id) }}>
                            <span className={css.channelName}>{isDefault ? `★ ${channel.name || t('channels.untitled')}` : (channel.name || t('channels.untitled'))}</span>
                            <span className={css.channelMeta}>
                              <Tag kind={!keyHeld || channel.models.length === 0 ? 'warn' : 'ok'}>
                                {keyHeld ? t('channels.keySet') : t('channels.keyMissing')}
                                {' · '}
                                {channel.models.length > 0 ? t('channels.modelCount', { n: channel.models.length }) : t('channels.noModels')}
                              </Tag>
                            </span>
                          </button>
                          <Button variant="ghost" size="sm" onClick={() => { setEditingId(channel.id) }}>{t('channels.edit')}</Button>
                          <Button variant="danger" size="sm" onClick={() => { setConfirmDeleteId(channel.id) }}>{t('channels.delete')}</Button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              <div className={css.channelControls}>
              {open && presetPickerOpen ? (
                <PresetPicker
                  t={t}
                  presets={presets}
                  error={presetError}
                  disabled={state.writable === false}
                  onLoad={() => {
                    setPresetError(null)
                    void fetch(PRESETS_API, { method: 'POST' })
                      .then(async response => {
                        const body = await response.json() as { ok?: boolean; presets?: PresetProviderView[]; message?: string }
                        if (!response.ok || body.ok !== true || body.presets === undefined) throw new Error(body.message ?? `HTTP ${response.status}`)
                        setPresets(body.presets)
                      })
                      .catch(error => { setPresetError(error instanceof Error ? error.message : String(error)) })
                  }}
                  onPick={(preset) => {
                    const draft = newChannelDraft(preset)
                    props.channels.setChannels([...channels, draft])
                    setPresetPickerOpen(false)
                    setEditingId(draft.id)
                  }}
                  onCustom={() => {
                    const draft = newChannelDraft(undefined)
                    props.channels.setChannels([...channels, draft])
                    setPresetPickerOpen(false)
                    setEditingId(draft.id)
                  }}
                  onClose={() => { setPresetPickerOpen(false) }}
                />
              ) : null}

              <div className={css.channelAddRow}>
                <Button variant="secondary" size="sm" disabled={disabled} onClick={() => { setPresetError(null); setPresetPickerOpen(true) }}>+ {t('channels.addProvider')}</Button>
                <Button variant="secondary" size="sm" disabled={disabled} onClick={() => { addCustomChannel(channels, props.channels, setEditingId) }}>+ {t('channels.addCustom')}</Button>
              </div>
              </div>
            </section>

            <button
              type="button"
              className={css.disclosure}
              aria-expanded={enhancementOpen}
              onClick={() => { setEnhancementOpen(open => !open) }}
            >
              <span>{t('settings.promptEnhanceTitle')}</span>
              <span>{t('settings.optional')}</span>
              <span aria-hidden="true">{enhancementOpen ? '⌃' : '⌄'}</span>
            </button>
            {enhancementOpen ? <section className={css.optionalContent} aria-label={t('settings.promptEnhanceTitle')}>
            <p className={css.sectionHint}>{t('settings.promptEnhanceHint')}</p>
            <div className={css.sectionHeader}>
              <div>
                <h3 className={css.sectionTitle}>{t('settings.promptModel')}</h3>
                <p className={css.sectionHint}>{t('settings.promptModelDetectionHint')}</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                loading={loadingPromptModels}
                disabled={disabled || loadingPromptModels}
                onClick={() => {
                  setLoadingPromptModels(true)
                  setPromptModelsError(null)
                  void fetch(PROMPT_ENHANCE_API.models, { method: 'POST' })
                    .then(async response => {
                      const body = await response.json() as { ok?: boolean; models?: string[]; message?: string }
                      if (!response.ok || body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`)
                      setPromptModels(body.models ?? [])
                    })
                    .catch(error => { setPromptModelsError(error instanceof Error ? error.message : String(error)) })
                    .finally(() => { setLoadingPromptModels(false) })
                }}
              >
                {loadingPromptModels ? t('settings.promptModelsLoading') : t('settings.promptModelsFetch')}
              </Button>
            </div>
            <div className={css.modelSummary}>
              {liveModel.trim() !== '' ? (
                <span className={css.modelChip}>
                  <span>{liveModel}</span>
                  <button type="button" disabled={disabled} aria-label={`${t('settings.removeModel')}: ${liveModel}`} onClick={() => { void props.settingsScope.set('promptModel', '') }}>×</button>
                </span>
              ) : null}
              <Button variant="secondary" size="sm" disabled={disabled} onClick={() => { setManualPromptModelOpen(open => !open); setEnhancementOpen(true) }}>
                {manualPromptModelOpen ? t('settings.cancelAddModel') : t('settings.addModel')}
              </Button>
            </div>
            {manualPromptModelOpen ? (
              <div className={css.manualModelRow}>
                <TextField value={manualPromptModel} placeholder={t('settings.addPromptModelPlaceholder')} disabled={disabled} onValueChange={setManualPromptModel} />
                <Button variant="secondary" size="sm" disabled={disabled || manualPromptModel.trim() === ''} onClick={() => { void props.settingsScope.set('promptModel', manualPromptModel); setManualPromptModel('') }}>{t('settings.addModelConfirm')}</Button>
              </div>
            ) : null}
            {promptModels.length > 0 ? (
              <div className={css.modelCandidateList} role="radiogroup" aria-label={t('settings.promptModelsCandidates')}>
                <span className={css.modelCandidateLabel}>{t('settings.promptModelsCandidates')}</span>
                {promptModels.map(candidate => (
                  <button
                    key={candidate}
                    type="button"
                    role="radio"
                    className={css.modelCandidate}
                    aria-checked={liveModel === candidate}
                    data-selected={liveModel === candidate ? '' : undefined}
                    disabled={disabled}
                    onClick={() => { void props.settingsScope.set('promptModel', candidate) }}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            ) : null}
            {promptModelsError !== null ? <p className={css.failed} role="status">{promptModelsError}</p> : null}
            <button type="button" className={css.inlineDisclosure} aria-expanded={promptApiOpen} onClick={() => { setPromptApiOpen(open => !open) }}>
              <span>{t('settings.promptApiAdvanced')}</span>
              <span aria-hidden="true">{promptApiOpen ? '⌃' : '⌄'}</span>
            </button>
            {promptApiOpen ? <div className={css.optionalContent}>
            {/* The URL itself is a schema field the shared form renders above;
                only the key stays here, because a write to it is diverted into
                the credential store by this plugin's bridge. */}
            <ValueField
              id="dsh-imagegen-settings-prompt-apikey"
              label={t('settings.promptApiKey')}
              hint={t('settings.promptApiKeyHint')}
              placeholder="sk-…"
              secret
              {...fieldProps}
              {...state.promptApiKey}
              overridden={false}
              onEdit={(text) => { props.edit('promptApiKey', text) }}
              onReset={() => { props.resetField('promptApiKey') }}
            />
            </div> : null}
            </section> : null}

            {(state.failed || state.channels.failed)
              ? <p className={css.failed} role="status">{t('settings.saveFailed')}</p>
              : null}
              </ConfigForm>
            </div>
          </div>
        )
        : null}

      {open && editing !== undefined ? (
        <ChannelEditor
          key={editing.id}
          t={t}
          channel={editing}
          keyHeld={state.channels.keySet[editing.id] === true}
          otherChannels={channels.filter(channel => channel.id !== editing.id)}
          isDefault={editing.id === state.channels.defaultChannelId}
          writable={state.writable}
          onPatch={(patch) => { replaceChannel(channels, editing.id, patch, props.channels) }}
          onSetModels={(models) => { props.channels.setChannels(channels.map(channel => channel.id === editing.id ? { ...channel, models } : channel)) }}
          onSetKey={(value) => { props.channels.setChannelKey(editing.id, value) }}
          onSetDefault={() => { props.channels.setDefaultChannel(editing.id) }}
          onRemove={() => { props.channels.setChannels(channels.filter(channel => channel.id !== editing.id)); if (editing.id === state.channels.defaultChannelId && channels.length > 1) { const next = channels.find(channel => channel.id !== editing.id); if (next !== undefined) props.channels.setDefaultChannel(next.id) } setEditingId(null) }}
          onClose={() => { setEditingId(null) }}
        />
      ) : null}

    </li>
  )
}

/** Channel row + dialog helpers -------------------------------------------------- */

function newChannelDraft(preset: PresetProviderView | undefined): ChannelDraft {
  return {
    id: clientId(),
    preset: preset?.id ?? '',
    name: preset?.name ?? '',
    apiUrl: preset?.apiUrl ?? '',
      apiUrlFull: false,
    models: (preset?.models ?? []).map(model => ({ ...model })),
  }
}

function addCustomChannel(channels: ChannelDraft[], form: ChannelsFormActions, openEditor: (id: string) => void): void {
  const draft = newChannelDraft(undefined)
  form.setChannels([...channels, draft])
  openEditor(draft.id)
}

/** Patch one field (or models) of one staged channel. */
function replaceChannel(channels: ChannelDraft[], id: string, patch: Partial<ChannelDraft>, form: ChannelsFormActions): void {
  form.setChannels(channels.map(channel => channel.id === id ? { ...channel, ...patch } : channel))
}

function clientId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : undefined
  return random ?? `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Built-in provider picker, expanded inside the settings card. */
function PresetPicker(props: {
  t: (key: ImageGenKey, params?: Record<string, string | number>) => string
  presets: PresetProviderView[]
  error: string | null
  disabled: boolean
  onLoad: () => void
  onPick: (preset: PresetProviderView) => void
  onCustom: () => void
  onClose: () => void
}) {
  const { t } = props
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    props.onLoad()
  }, [])
  return (
    <section className={css.presetInline} aria-label={t('channels.presetPickerTitle')}>
      <header className={css.presetInlineHeader}>
        <div>
          <h3 className={css.sectionTitle}>{t('channels.presetPickerTitle')}</h3>
          <p className={css.sectionHint}>{t('channels.presetPickerHint')}</p>
        </div>
        <button type="button" className={css.editorClose} aria-label={t('preview.close')} onClick={props.onClose}>×</button>
      </header>
      <div className={css.presetList}>
        {props.presets.map(preset => (
          <button key={preset.id} type="button" className={css.presetRow} disabled={props.disabled} onClick={() => { props.onPick(preset) }}>
            <span className={css.presetName}>{preset.name}</span>
            <span className={css.presetMeta}>{preset.models.map(model => model.alias).join(' · ')}</span>
          </button>
        ))}
        <button type="button" className={css.presetRow} data-custom disabled={props.disabled} onClick={props.onCustom}>
          <span className={css.presetName}>+ {t('channels.addCustom')}</span>
          <span className={css.presetHint}>{t('channels.presetCustomHint')}</span>
        </button>
        {props.error !== null ? <p className={css.failed} role="status">{t('channels.presetLoadFailed', { error: props.error })}</p> : null}
      </div>
    </section>
  )
}

/** Channel editor (modal): key, display name, API URL, model catalog. */
function ChannelEditor(props: {
  t: (key: ImageGenKey, params?: Record<string, string | number>) => string
  channel: ChannelDraft
  keyHeld: boolean
  otherChannels: ChannelDraft[]
  isDefault: boolean
  writable: boolean
  onPatch: (patch: Partial<ChannelDraft>) => void
  onSetModels: (models: ModelMapping[]) => void
  onSetKey: (value: string | undefined) => void
  onSetDefault: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { t, channel } = props
  const [keyDraft, setKeyDraft] = useState('')
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [manualId, setManualId] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [copyFrom, setCopyFrom] = useState('')

  const detect = (): void => {
    setDetecting(true)
    setDetectError(null)
    const payload: Record<string, unknown> = { channelId: channel.id }
    if (channel.apiUrl.trim() !== '') payload.apiUrl = channel.apiUrl.trim()
    if (keyDraft.trim() !== '') payload.apiKey = keyDraft.trim()
    void fetch(IMAGE_MODEL_API.models, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(async response => {
        const body = await response.json() as { ok?: boolean; models?: string[]; message?: string }
        if (!response.ok || body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`)
        setCandidates(body.models ?? [])
      })
      .catch(error => { setDetectError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setDetecting(false) })
  }

  // Auto-detect once when the dialog opens with a complete endpoint.
  const autoDetected = useRef(false)
  useEffect(() => {
    if (autoDetected.current) return
    autoDetected.current = true
    if (channel.apiUrl.trim() !== '' && (props.keyHeld || keyDraft.trim() !== '')) detect()
  }, [])

  const addManual = (): void => {
    const id = manualId.trim()
    if (id === '') return
    const next = [...channel.models]
    const alias = id
    if (!next.some(model => model.alias === alias)) next.push({ alias, id })
    props.onSetModels(next)
    setManualId('')
  }

  const copyFromChannel = (): void => {
    const source = props.otherChannels.find(chance => chance.id === copyFrom)
    if (source === undefined) return
    const merged = [...channel.models]
    for (const model of source.models) {
      const alias = model.alias
      // Copy with a collision suffix so both sources stay selectable.
      let unique = alias
      let suffix = 2
      while (merged.some(entry => entry.alias === unique)) unique = `${alias} (${suffix++})`
      merged.push({ alias: unique, id: model.id })
    }
    props.onSetModels(merged)
    setCopyFrom('')
  }

  return (
    <div className={css.editorBackdrop} role="dialog" aria-modal="true" aria-label={`${t('channels.editorTitle')} · ${channel.name || t('channels.untitled')}`} onClick={props.onClose}>
      <div className={css.editorPanel} onClick={event => { event.stopPropagation() }}>
        <header className={css.editorHeader}>
          <div>
            <h3 className={css.sectionTitle}>{t('channels.editorTitle')} · {channel.name || t('channels.untitled')}</h3>
            <p className={css.sectionHint}>{t('channels.editorSaveNote')}</p>
          </div>
          <button type="button" className={css.editorClose} aria-label={t('preview.close')} onClick={props.onClose}>×</button>
        </header>

        <div className={css.editorField}>
          <label className={css.label} htmlFor="dsh-imagegen-channel-name">{t('channels.displayName')}</label>
          <TextField id="dsh-imagegen-channel-name" value={channel.name} placeholder={t('channels.untitled')} disabled={!props.writable} onValueChange={next => { props.onPatch({ name: next }) }} />
        </div>
        <div className={css.editorField}>
          <label className={css.label} htmlFor="dsh-imagegen-channel-url">{t('channels.apiUrl')}</label>
          <TextField id="dsh-imagegen-channel-url" value={channel.apiUrl} placeholder="https://api.example.com/v1" disabled={!props.writable} onValueChange={next => { props.onPatch({ apiUrl: next }) }} />
        </div>
        <div className={css.editorField}>
          <div className={css.head}>
            <label className={css.label} htmlFor="dsh-imagegen-channel-key">{t('channels.apiKey')}</label>
            {props.keyHeld || keyDraft !== ''
              ? (
                <button type="button" className={css.reset} disabled={!props.writable} onClick={() => { setKeyDraft(''); props.onSetKey(undefined) }}>
                  {t('channels.keyClear')}
                </button>
              )
              : null}
          </div>
          <SecretField
            id="dsh-imagegen-channel-key"
            autoComplete="off"
            value={keyDraft}
            configured={props.keyHeld}
            placeholder={props.keyHeld ? t('channels.keyReplaceHint') : t('channels.keyMissingHint')}
            disabled={!props.writable}
            onValueChange={value => { const next = value; setKeyDraft(next); props.onSetKey(next === '' ? undefined : next) }}
          />
        </div>

        <div className={css.editorDivider} />

        <div className={css.editorSectionHeader}>
          <h4 className={css.label}>{t('channels.modelCatalogTitle')}</h4>
          <Button variant="secondary" size="sm" loading={detecting} disabled={!props.writable || detecting} onClick={detect}>
            {detecting ? t('channels.detecting') : t('channels.detect')}
          </Button>
        </div>
        {detectError !== null ? <p className={css.failed} role="status">{t('channels.detectFailed', { error: detectError })}</p> : null}
        {candidates !== null && detectError === null ? <p className={css.detectOk} role="status">{t('channels.detectSuccess', { n: candidates.length })}</p> : null}

        {channel.models.length === 0
          ? <p className={css.sectionHint}>{t('channels.noModelsHint')}</p>
          : (
            <ul className={css.modelRows}>
              {channel.models.map((model, index) => {
                const entry = describeModel(model.id || model.alias)
                return (
                  <li key={`${model.alias}-${index}`} className={css.modelRow}>
                    <div className={css.modelRowInputs}>
                      <TextField
                        value={model.alias}
                        aria-label={t('channels.modelAliasLabel')}
                        disabled={!props.writable}
                        onValueChange={text => {
                          const next = [...channel.models]
                          next[index] = { ...model, alias: text }
                          props.onSetModels(next)
                        }}
                      />
                      <span className={css.modelArrow}>→</span>
                      <TextField
                        value={model.id}
                        aria-label={t('channels.modelIdLabel')}
                        disabled={!props.writable}
                        onValueChange={text => {
                          const next = [...channel.models]
                          next[index] = { ...model, id: text }
                          props.onSetModels(next)
                        }}
                      />
                    </div>
                    <div className={css.modelRowBadges}>
                      <Tag mono kind={entry.known ? 'idle' : 'warn'}>{entry.labelZh}{entry.known ? '' : ` · ${t('channels.unknownProtocol')}`}</Tag>
                      <button type="button" className={css.modelRowRemove} disabled={!props.writable} aria-label={`${t('channels.removeModel')}: ${model.alias}`} onClick={() => { props.onSetModels(channel.models.filter((_, i) => i !== index)) }}>×</button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

        <div className={css.editorTools}>
          <div className={css.manualModelRow}>
            <TextField
              value={manualId}
              placeholder={t('channels.manualAddPlaceholder')}
              disabled={!props.writable}
              onValueChange={setManualId}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addManual() } }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!props.writable || manualId.trim() === ''}
              onClick={addManual}
            >
              {t('channels.addModelConfirm')}
            </Button>
          </div>
          {props.otherChannels.length > 0 ? (
            <div className={css.manualModelRow}>
              <Select
                value={copyFrom}
                options={[
                  { value: '', label: t('channels.copyFrom') },
                  ...props.otherChannels.map(other => ({
                    value: other.id,
                    label: other.name || t('channels.untitled'),
                  })),
                ]}
                disabled={!props.writable}
                onChange={setCopyFrom}
                label={t('channels.copyFrom')}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={!props.writable || copyFrom === ''}
                onClick={copyFromChannel}
              >
                {t('channels.copyApply')}
              </Button>
            </div>
          ) : null}
        </div>

        {candidates !== null && candidates.length > 0 ? (
          <div className={css.modelCandidateList}>
            <span className={css.modelCandidateLabel}>
              {t('channels.candidatesTitle')}
            </span>
            {candidates.map(candidate => {
              const selected = channel.models.some(model => model.alias === candidate)
              const entry = describeModel(candidate)
              return (
                <div key={candidate} className={css.modelCandidate} data-selected={selected ? '' : undefined}>
                  <Checkbox
                    checked={selected}
                    disabled={!props.writable}
                    onCheckedChange={() => {
                      const merged = selected
                        ? channel.models.filter(model => model.alias !== candidate)
                        : [...channel.models, { alias: candidate, id: candidate }]
                      props.onSetModels(merged)
                    }}
                  >
                    <span>{candidate}</span>
                  </Checkbox>
                  {!entry.known ? <Tag mono kind="warn">{t('channels.unknownProtocol')}</Tag> : <Tag mono kind="idle">{entry.labelZh}</Tag>}
                </div>
              )
            })}
          </div>
        ) : null}

        <div className={css.editorDivider} />

        <div className={css.editorFooter}>
          {props.isDefault ? <Tag kind="info">{t('channels.defaultLabel')}</Tag> : (
            <button type="button" className={css.inlineDisclosure} disabled={!props.writable} onClick={props.onSetDefault}>{t('channels.setDefault')}</button>
          )}
          <span className={css.spacer} />
          {removeOpen
            ? (
              <>
                <Button variant="danger" size="sm" disabled={!props.writable} onClick={props.onRemove}>{t('channels.confirm')}</Button>
                <Button variant="ghost" size="sm" onClick={() => { setRemoveOpen(false) }}>{t('channels.cancel')}</Button>
              </>
            )
            : (
              <Button variant="danger" size="sm" onClick={() => { setRemoveOpen(true) }}>{t('channels.deleteThisChannel')}</Button>
            )}
        </div>
      </div>
    </div>
  )
}

/** Props every field control needs regardless of its value type. */
interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/** A staged value field; `secret` renders a password control. */
function ValueField(props: FieldProps & {
  /** Render a password control. */
  secret?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
  /** Label of the dedicated clear control (secret fields). */
  clearLabel?: string
  /** Stage a clear of the stored secret. */
  onClear?: () => void
  /** Whether a stored secret exists (enables the clear control). */
  canClear?: boolean
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <Tag mono kind="info">{props.overriddenLabel}</Tag>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
        {props.secret === true && props.canClear === true
          ? (
            <button
              type="button"
              className={css.reset}
              disabled={props.disabled}
              onClick={props.onClear}
            >
              {props.clearLabel ?? props.resetLabel}
            </button>
          )
          : null}
      </div>
      {props.secret === true ? (
        <SecretField
          id={props.id}
          autoComplete="off"
          value={props.text}
          placeholder={props.placeholder ?? ''}
          disabled={props.disabled}
          invalid={props.invalid}
          configured={props.canClear}
          onValueChange={props.onEdit}
        />
      ) : (
        <TextField
          id={props.id}
          value={props.text}
          placeholder={props.placeholder ?? ''}
          disabled={props.disabled}
          invalid={props.invalid}
          onValueChange={props.onEdit}
        />
      )}
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

