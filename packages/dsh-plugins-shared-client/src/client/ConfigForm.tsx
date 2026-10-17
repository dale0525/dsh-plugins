/**
 * `ConfigForm` / `ConfigSummary` — render a plugin's `Config` schema.
 *
 * This is the payoff of the shared layer for plugin authors. Declare
 * `export const Config = Schema.object({...})` in the host half, register
 * `ConfigForm` on `plugins.row.config` for your namespace, and every declared
 * field appears with the same control, spacing and dark-mode behaviour as every
 * other plugin. Adding a configuration item is then one line in the schema and
 * nothing in the browser half.
 *
 * Both components resolve the schema themselves from the settings describe
 * mirror, so a caller passes its namespace and the two handles — never a field
 * list, never a control choice. The mirror is the only place the schema exists
 * on the client, and `page` and `summary` read the same one, so they cannot
 * disagree.
 *
 * Writes go through the Host-owned form, so revision fencing, validation and the
 * persistence decision stay with the Host. This component owns only the draft: a
 * field is written on commit, not on every keystroke, because each write is a
 * Host round-trip carrying a revision.
 */
import type { ReactNode } from 'react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'

import { Banner, Skeleton } from './feedback.tsx'
import { Field, NumberField, SecretField, TextField } from './fields.tsx'
import { ListEditor, ReadonlySummary, SettingsCard } from './layout.tsx'
import { Select } from './Select.tsx'
import { Switch } from './toggles.tsx'
import { describeConfigFields, type ConfigField } from './config-schema.ts'

/**
 * One path-addressed edit, as the Host's settings write carries it.
 *
 * Declared structurally rather than imported: this package must stay loadable
 * in a deployment with no settings UI, so it takes no build-time dependency on
 * the settings package.
 */
export type ConfigPathOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

/** The state one namespace's form reports. */
export interface ConfigFormSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: Record<string, unknown> | undefined
  readonly writable: boolean
  readonly revision: number | undefined
}

/**
 * The Host-owned per-namespace form (`ctx.configForms.get(ns)`).
 *
 * Structurally identical to the settings package's `ConfigForm`, which is what
 * lets a caller pass its own form straight through.
 */
export interface ConfigFormHandle {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ConfigPathOp[], expectedRevision?: number): Promise<boolean>
}

/** One namespace as the describe mirror reports it. */
interface NamespaceView {
  readonly ns: string
  readonly schema?: unknown
}

/** The shared describe face (`ctx.configForms.describe()`). */
export interface ConfigDescribeHandle {
  getSnapshot(): { readonly status: string; readonly view?: { readonly namespaces: readonly NamespaceView[] } }
  subscribe(listener: () => void): () => void
}

export interface ConfigFormProps {
  /** The settings namespace this plugin's host half registered. */
  readonly namespace: string
  readonly form: ConfigFormHandle
  readonly describe: ConfigDescribeHandle
  readonly title?: ReactNode
  readonly description?: ReactNode
  /**
   * Sections appended inside the card, below the schema-driven fields.
   *
   * A schema describes scalars. It cannot describe a credential owned by the
   * credentials service, a model list fetched from the plugin's own HTTP route,
   * or a structured editor for a list of objects — and three shipped cards have
   * exactly those. Without this slot the migration would have deleted them.
   */
  readonly children?: ReactNode
  /**
   * Replace one field's control, keeping its schema label and description.
   *
   * Return `undefined` to keep the default control. Used where the right control
   * depends on data the schema cannot carry: the route fields render a provider
   * dropdown when a model catalog is available and a text input when it is not.
   */
  readonly renderControl?: (field: ConfigField) => ReactNode | undefined
}

/** Subscribe to the namespace's serialized `Config` schema, if it is published. */
function useConfigSchema(namespace: string, describe: ConfigDescribeHandle): unknown {
  const snapshot = useSyncExternalStore(
    useCallback((listener) => describe.subscribe(listener), [describe]),
    useCallback(() => describe.getSnapshot(), [describe]),
  )
  return useMemo(
    () => snapshot.view?.namespaces.find((entry) => entry.ns === namespace)?.schema,
    [snapshot, namespace],
  )
}

function useFormSnapshot(form: ConfigFormHandle): ConfigFormSnapshot {
  return useSyncExternalStore(
    useCallback((listener) => form.subscribe(listener), [form]),
    useCallback(() => form.getSnapshot(), [form]),
  )
}

export function ConfigForm({
  namespace,
  form,
  describe,
  title = '配置',
  description,
  children,
  renderControl,
}: ConfigFormProps) {
  const schema = useConfigSchema(namespace, describe)
  const fields = useMemo(() => describeConfigFields(schema), [schema])
  const { status, value, writable, revision } = useFormSnapshot(form)
  const disabled = !writable

  /**
   * Draft text for the controls that hold a string while being edited.
   *
   * A number input keeps the user's half-typed text (`1.` and `-`) instead of
   * round-tripping through `Number`, which would rewrite it mid-keystroke. The
   * entry is dropped once the write is accepted, so the Host value shows through.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const setDraft = useCallback((key: string, next: string) => {
    setDrafts((prev) => ({ ...prev, [key]: next }))
  }, [])

  const commit = useCallback(
    (field: string, next: unknown) => {
      void form.mutate([{ op: 'set', path: [field], value: next }], revision).then((accepted) => {
        if (!accepted) return
        setDrafts((prev) => {
          if (!(field in prev)) return prev
          const copy = { ...prev }
          delete copy[field]
          return copy
        })
      })
    },
    [form, revision],
  )

  const clear = useCallback(
    (field: string) => {
      void form.mutate([{ op: 'unset', path: [field] }], revision)
    },
    [form, revision],
  )

  if (status === 'loading') {
    return (
      <SettingsCard title={title} description={description}>
        <Skeleton />
      </SettingsCard>
    )
  }

  if (status === 'unavailable') {
    return (
      <SettingsCard title={title} description={description}>
        <Banner kind="warn">当前部署没有开放设置读写，配置项无法在此修改。</Banner>
        {children}
      </SettingsCard>
    )
  }

  // The empty notice belongs to a card that has nothing else to show. A card
  // whose whole surface is `children` (a credential section, a fetched model
  // catalog) declares no schema fields on purpose and must not be told it is
  // missing them.
  if (fields.length === 0 && children === undefined) {
    return (
      <SettingsCard title={title} description={description}>
        <Banner kind="info">该插件没有声明可配置项。</Banner>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard title={title} description={description}>
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          raw={value?.[field.key]}
          draft={drafts[field.key]}
          disabled={disabled}
          override={renderControl?.(field)}
          onDraft={setDraft}
          onCommit={commit}
          onClear={clear}
        />
      ))}
      {children}
    </SettingsCard>
  )
}

function FieldRow({
  field,
  raw,
  draft,
  disabled,
  override,
  onDraft,
  onCommit,
  onClear,
}: {
  field: ConfigField
  raw: unknown
  draft: string | undefined
  disabled: boolean
  /** A caller-supplied control for this field, or `undefined` for the default. */
  override: ReactNode | undefined
  onDraft: (key: string, next: string) => void
  onCommit: (key: string, next: unknown) => void
  onClear: (key: string) => void
}) {
  const { label, description } = field

  // An override replaces the control only. The row, its label and its
  // description still come from the schema, so an overridden field never
  // becomes an unlabelled block.
  if (override !== undefined) {
    return (
      <Field label={label} description={description} inline={field.kind === 'boolean'}>
        {override}
      </Field>
    )
  }

  switch (field.kind) {
    case 'boolean':
      return (
        <Field label={label} description={description} inline>
          <Switch
            checked={raw === true}
            disabled={disabled}
            label={label}
            onCheckedChange={(next) => {
              onCommit(field.key, next)
            }}
          />
        </Field>
      )

    case 'string': {
      if (field.secret) {
        return (
          <Field label={label} description={description}>
            <SecretField
              value={draft ?? ''}
              configured={typeof raw === 'string' && raw !== ''}
              disabled={disabled}
              onValueChange={(next) => {
                onDraft(field.key, next)
              }}
              onBlur={() => {
                // An emptied secret box clears the stored value, which is the
                // only way back to the inherited default.
                if (draft === undefined) return
                if (draft === '') onClear(field.key)
                else onCommit(field.key, draft)
              }}
            />
          </Field>
        )
      }
      return (
        <Field label={label} description={description}>
          <TextField
            value={draft ?? (typeof raw === 'string' ? raw : field.fallback)}
            disabled={disabled}
            onValueChange={(next) => {
              onDraft(field.key, next)
            }}
            onBlur={() => {
              if (draft !== undefined) onCommit(field.key, draft)
            }}
          />
        </Field>
      )
    }

    case 'number': {
      const text = draft ?? String(typeof raw === 'number' ? raw : field.fallback)
      return (
        <Field label={label} description={description}>
          <NumberField
            value={text}
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            onValueChange={(next) => {
              onDraft(field.key, next)
            }}
            onBlur={() => {
              const parsed = Number.parseFloat(text)
              if (Number.isFinite(parsed)) onCommit(field.key, parsed)
              else onDraft(field.key, String(typeof raw === 'number' ? raw : field.fallback))
            }}
          />
        </Field>
      )
    }

    case 'select':
      return (
        <Field label={label} description={description}>
          <Select
            value={typeof raw === 'string' ? raw : field.fallback}
            options={field.options}
            disabled={disabled}
            label={label}
            onChange={(next) => {
              onCommit(field.key, next)
            }}
          />
        </Field>
      )

    case 'string-list': {
      const items = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : field.fallback
      return (
        <Field label={label} description={description}>
          <ListEditor
            items={items}
            addLabel="添加"
            onChange={(next) => {
              onCommit(field.key, next)
            }}
          />
        </Field>
      )
    }
  }
}

/**
 * Read-only projection of the same schema, for the `summary` view.
 *
 * The list page renders a plugin's one-liner through `view: 'summary'`, and the
 * design shows it as the two-column block: schema label on the left, current
 * value on the right. Values come from the same form as the page, so the summary
 * and the page can never disagree.
 */
export function ConfigSummary({
  namespace,
  form,
  describe,
}: {
  namespace: string
  form: ConfigFormHandle
  describe: ConfigDescribeHandle
}) {
  const schema = useConfigSchema(namespace, describe)
  const fields = useMemo(() => describeConfigFields(schema), [schema])
  const { value } = useFormSnapshot(form)
  return <ReadonlySummary rows={fields.map((field) => ({ label: field.label, value: summarize(field, value?.[field.key]) }))} />
}

function summarize(field: ConfigField, raw: unknown): string {
  if (field.kind === 'boolean') return (raw === undefined ? field.fallback : raw === true) ? '已启用' : '已关闭'
  if (field.kind === 'string-list') {
    const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : field.fallback
    return list.length === 0 ? '未设置' : list.join(', ')
  }
  if (raw === undefined) {
    if (field.kind === 'string') return field.fallback === '' ? '未设置' : field.fallback
    return String(field.fallback)
  }
  return String(raw)
}
