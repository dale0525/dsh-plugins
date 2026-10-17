/**
 * Config-schema projection: serialized schemastery → renderable field list.
 *
 * A plugin declares `export const Config = Schema.object({...})` in its host
 * half and the Host publishes that schema's `toJSON()` envelope on the settings
 * describe view. This module turns that envelope into the flat field list a
 * settings page renders, so adding a configuration item is one line in the
 * schema and no change in the browser half.
 *
 * It walks the envelope directly instead of rehydrating it with schemastery:
 * the browser half must not carry a schema library, and the envelope is already
 * the whole description — `{uid, refs}` where a composite node points into
 * `refs` through `dict` / `list` / `inner` (shape verified against the three
 * real `Config` schemas in this repo: object, boolean, number, string, union,
 * array, const).
 */

/** One renderable configuration item. */
export type ConfigField =
  | { key: string; label: string; description?: string; kind: 'boolean'; fallback: boolean }
  | { key: string; label: string; description?: string; kind: 'string'; secret: boolean; fallback: string }
  | {
      key: string
      label: string
      description?: string
      kind: 'number'
      min?: number
      max?: number
      step?: number
      fallback: number
    }
  | {
      key: string
      label: string
      description?: string
      kind: 'select'
      options: ReadonlyArray<{ value: string; label: string }>
      fallback: string
    }
  | { key: string; label: string; description?: string; kind: 'string-list'; fallback: string[] }

interface Node {
  type?: string
  meta?: Record<string, unknown>
  dict?: Record<string, number>
  list?: number[]
  inner?: number
  value?: unknown
}

interface Envelope {
  uid?: number
  refs?: Record<string, Node>
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Project one envelope into its top-level fields.
 *
 * Field order follows the schema's own declaration order, which is what the
 * author of the schema reads in the source — so the page and the code agree
 * without a second ordering list. A field whose node type has no control here
 * is skipped rather than rendered as an empty row, and so is one the schema marks
 * `.hidden()`.
 *
 * `hidden` is not a style choice: a key can be part of the stored shape while
 * having no sensible manual editor. `dsh-imagegen` carries `apiUrl` and
 * `imageModels` purely as the migration source for its channel list (its own
 * `normalizeChannels` reads them, then writes channels), so rendering them would
 * offer the user two dead text boxes that the next channel edit overwrites.
 * Marking them `.hidden()` keeps the keys in the schema — where the migration
 * still reads them — and off the page.
 *
 * @param serialized - the `schema.toJSON()` envelope from the describe view.
 * @returns one entry per renderable top-level field; `[]` for anything else.
 */
export function describeConfigFields(serialized: unknown): ConfigField[] {
  if (serialized === null || typeof serialized !== 'object') return []
  const envelope = serialized as Envelope
  const refs = envelope.refs
  if (refs === undefined) return []
  const root = envelope.uid === undefined ? undefined : refs[String(envelope.uid)]
  if (root?.type !== 'object' || root.dict === undefined) return []

  const fields: ConfigField[] = []
  for (const [key, id] of Object.entries(root.dict)) {
    const field = projectField(key, refs[String(id)], refs)
    if (field !== undefined) fields.push(field)
  }
  return fields
}

function projectField(key: string, node: Node | undefined, refs: Record<string, Node>): ConfigField | undefined {
  if (node === undefined) return undefined
  const meta = node.meta ?? {}
  if (meta.hidden === true) return undefined
  // `comment` is the short human label and `description` the sentence under it;
  // a schema that declares neither still renders, labelled by its own key.
  const label = text(meta.comment) ?? key
  const description = text(meta.description)
  const base = description === undefined ? { key, label } : { key, label, description }

  switch (node.type) {
    case 'boolean':
      return { ...base, kind: 'boolean', fallback: meta.default === true }

    case 'string':
      return {
        ...base,
        kind: 'string',
        secret: meta.role === 'secret',
        fallback: typeof meta.default === 'string' ? meta.default : '',
      }

    case 'number': {
      // Bounds and step are only carried when the schema declares them: an
      // explicit `undefined` would read as "declared, but empty" to a caller
      // that tests for key presence.
      const number: Extract<ConfigField, { kind: 'number' }> = {
        ...base,
        kind: 'number',
        fallback: typeof meta.default === 'number' ? meta.default : 0,
      }
      if (typeof meta.min === 'number') number.min = meta.min
      if (typeof meta.max === 'number') number.max = meta.max
      if (typeof meta.step === 'number') number.step = meta.step
      return number
    }

    case 'union': {
      // A union of literals is a choice: each member is a `const` node whose
      // `value` is the literal. Anything else (a union of shapes) has no
      // single-control representation, so it is left to a hand-written card.
      const options = (node.list ?? []).flatMap((id) => {
        const member = refs[String(id)]
        if (member?.type !== 'const' || typeof member.value !== 'string') return []
        return [{ value: member.value, label: member.value }]
      })
      if (options.length === 0) return undefined
      return { ...base, kind: 'select', options, fallback: typeof meta.default === 'string' ? meta.default : options[0].value }
    }

    case 'array': {
      // Only a list of plain strings maps to the list editor. A list of objects
      // is a structured editor this layer does not own.
      const inner = node.inner === undefined ? undefined : refs[String(node.inner)]
      if (inner?.type !== 'string') return undefined
      const fallback = Array.isArray(meta.default) ? meta.default.filter((v): v is string => typeof v === 'string') : []
      return { ...base, kind: 'string-list', fallback }
    }

    default:
      return undefined
  }
}
