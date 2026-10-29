/**
 * Contract tests for the dsh-imagegen settings card after the shared-layer
 * migration.
 *
 * The card is the one place in this package where a security property and a
 * presentation property are easy to confuse. Its API keys are NOT settings
 * fields: the bridge diverts `promptApiKey` and every `channelSecrets.<id>` into
 * the credential store, so the settings document never holds them. The host's
 * own settings service cannot do that — `dsh-settings`'s `write()` has no
 * `role('secret')` branch at all, so a secret declared in a schema would land in
 * `settings.yaml` in plaintext.
 *
 * That is why the migration moves only the SCALAR fields onto the shared
 * `ConfigForm` and leaves the key inputs, and the whole channel editor, on this
 * plugin's own bridge. These tests pin both halves: the schema-driven fields
 * must come from the schema, and the key path must still be the bridge.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const card = readFileSync(join(root, 'src', 'client', 'SettingsCard.tsx'), 'utf8')
const scope = readFileSync(join(root, 'src', 'client', 'settings-scope.ts'), 'utf8')
const host = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
const locales = readFileSync(join(root, 'src', 'client', 'locales.ts'), 'utf8')

test('the card renders the schema through the shared ConfigForm', () => {
  assert.match(card, /from '@logictan\/dsh-plugins-shared-client\/client'/)
  assert.ok(
    /ConfigForm/.test(card),
    'the scalar fields must render through the shared form, or the schema is not the source of truth',
  )
  assert.ok(
    /describeConfigFields|ConfigForm/.test(card),
    'the card must consume the schema projection rather than hand-writing each field',
  )
})

test('the channel editor and the key inputs stay on this plugin’s own bridge', () => {
  // `channels` is a structured editor over an array of objects; the shared form
  // has no control for that, and it must not grow one for a single consumer.
  assert.ok(
    /ChannelsForm/.test(card),
    'the channel editor must survive the migration',
  )
  // The key inputs write through the bridge, which is the only path that
  // diverts them into the credential store.
  assert.ok(
    /promptApiKey/.test(card),
    'the prompt key input must survive the migration',
  )
  assert.ok(
    /mutateOps|props\.edit/.test(card),
    'key and channel writes must keep going through the scope, not through the host form',
  )
})

test('the three legacy keys are hidden from the form, not deleted from the schema', () => {
  // `apiUrl` / `imageModels` / `defaultChannelId` are machine-owned: the first
  // two are only read by `normalizeChannels` to migrate the pre-channels shape,
  // and the third is read from `channels.defaultChannelId` by the UI. They have
  // no sensible manual editor, but the migration still needs them in the value,
  // so they are marked hidden rather than removed.
  for (const key of ['apiUrl', 'imageModels', 'defaultChannelId']) {
    const pattern = new RegExp(`${key}[\\s\\S]{0,160}?\\.hidden\\(\\)`)
    assert.ok(pattern.test(host), `${key} must be marked .hidden() so the form skips it`)
  }
})

test('the schema carries the labels the form renders', () => {
  // `describeConfigFields` falls back to the bare key when a field has no
  // comment, so a schema without these would show `announceToAgent` to the user.
  for (const key of ['enabled', 'announceToAgent', 'allowAgentImageGeneration', 'promptApiUrl', 'promptModel']) {
    const pattern = new RegExp(`${key}[\\s\\S]{0,200}?\\.comment\\('`)
    assert.ok(pattern.test(host), `${key} must carry a comment, which is the label the form renders`)
  }
})

test('a refused write is reported instead of being silently dropped', () => {
  // The shared form keeps the user's draft when `mutate` resolves `false`, which
  // is what stops a rejected edit from looking applied. The scope must therefore
  // resolve a boolean, not `void`.
  assert.match(
    scope,
    /mutate\(ops: readonly SettingsPathOpView\[\], expectedRevision\?: number\): Promise<boolean>/,
    'the scope mutate must resolve whether the write was accepted',
  )
})

test('the channel editor is passed as the form’s children, not beside it', () => {
  // The shared form owns the card's frame; anything the schema cannot describe
  // is its children so it lands inside that frame, after the schema fields. A
  // sibling section would render outside the card and lose the form's padding.
  const open = card.indexOf('<ConfigForm')
  const close = card.indexOf('</ConfigForm>')
  assert.ok(open !== -1 && close > open, 'the card must mount the shared form')
  const inside = card.slice(open, close)
  assert.ok(
    /channelSection/.test(inside),
    'the channel editor must sit between <ConfigForm> and </ConfigForm>',
  )
  assert.ok(
    /promptApiKey/.test(inside),
    'the key input must also be inside the form, so both halves share one card frame',
  )
})

test('the schema fields commit themselves, so the footer is only the staged forms\' save', () => {
  // The migration's own contract: every scalar in the schema commits on blur and
  // must NOT be staged here. There is no page-level save band a plugin can
  // reach, so the schema fields cannot wait for one.
  //
  // This is NOT a reason to drop the footer. The staged forms below (the channel
  // list, the prompt-enhancement key) have no commit-on-blur equivalent — the
  // channel editor's own hint says "changes take effect with the card's Save
  // button", and the card header shows an "Unsaved changes" badge. Deleting the
  // footer (8baf7a1f2) left `ChannelsForm.commit()` with zero call sites, so
  // every channel edit was staged and silently dropped.
  for (const migrated of ['enabled', 'announceToAgent', 'allowAgentImageGeneration', 'promptApiUrl', 'promptModel']) {
    assert.ok(
      !new RegExp(`props\\.edit\\('${migrated}'`).test(card),
      `${migrated} commits through the schema; staging it again would double-write`,
    )
  }
  assert.match(
    card,
    /void props\.channels\.commit\(\);\s*void props\.save\(\)/,
    'the footer save must write the staged channels together with the staged key',
  )
})

test('the card stages only the key, not the fields the schema renders', () => {
  // The crash this pins: `projection()` kept reading `this.form.field('enabled')`
  // for every migrated scalar after `CardForm` had been narrowed to the single
  // `secretField('promptApiKey')` spec. `CardForm.specOf` throws on an unknown
  // field, so the whole `plugins.row.config` slot rendered as an error node and
  // the settings page showed the plugin's title with no controls under it.
  //
  // Field-by-field: any `form.field(...)` here must name a spec the card
  // actually registers, and the migrated scalars must not appear at all.
  const specs = [...card.matchAll(/secretField\('([^']+)'\)/g)].map(m => m[1])
  const reads = [...card.matchAll(/this\.form\.field\('([^']+)'\)/g)].map(m => m[1])
  assert.deepEqual(specs, ['promptApiKey'], 'the card registers exactly one staged field')
  assert.deepEqual(reads, ['promptApiKey'], 'and reads exactly that one back')
  for (const migrated of ['enabled', 'announceToAgent', 'allowAgentImageGeneration', 'promptApiUrl', 'promptModel']) {
    assert.ok(
      !new RegExp(`this\\.form\\.field\\('${migrated}'\\)`).test(card),
      `${migrated} is rendered from the schema; staging it again throws`,
    )
  }
})

test('the form handle and its snapshot keep their identity between calls', () => {
  // The crash this pins: `getSnapshot()` built a fresh object on every call, and
  // `asConfigFormHandle()` was built inline in the render body. `useSyncExternal
  // Store` compares snapshots by reference, so every call looked like a change,
  // every render subscribed again, and React stopped at error #185 (maximum
  // update depth exceeded). The slot rendered as an error node: the page showed
  // the plugin's title with no controls under it.
  //
  // Both halves are pinned here: the handle must be memoized in the component,
  // and the projection must be cached against the scope's own snapshot.
  assert.match(
    card,
    /const formHandle = useMemo\(\s*\(\) => asConfigFormHandle\(/,
    'the handle must be memoized, not rebuilt each render',
  )
  assert.match(card, /form=\{formHandle\}/, 'and the memoized handle is what the form receives')
  assert.ok(
    !/form=\{asConfigFormHandle\(/.test(card),
    'building the handle inline re-renders forever',
  )
  assert.match(
    card,
    /if \(snapshot !== cachedFrom\) \{/,
    'the projected snapshot must be cached against the scope snapshot identity',
  )
})

test('the card offers a save action, and it is the only thing that writes staged channels', () => {
  // The crash this pins (reported 2026-10-29): the channel editor staged its
  // edits and told the user they "take effect with the card's Save button", but
  // the card had no Save button. `ChannelsForm.commit()` had no call site at
  // all — every channel edit (add, delete, set default, per-channel key) was
  // written into the draft and then dropped, with no way to persist it.
  //
  // A staged form whose save is unreachable is not a UI nit: it is a silent data
  // loss path. Both halves are pinned here — the card must render the control,
  // and the control must call commit.
  assert.match(
    card,
    /props\.channels\.commit\(\)/,
    'something in the card must call ChannelsForm.commit(); without a call site the staged channels can never be written',
  )
  assert.match(
    card,
    /t\(!?[^)]*'settings\.save'/,
    'the save control must be labelled from settings.save (the key the discard/save pair used before the migration)',
  )
  // The discard half must reach BOTH staged forms: the scalars' secret field and
  // the channels. Discarding only one leaves the card "dirty" with no way back.
  assert.match(
    card,
    /props\.discard\(\);\s*props\.channels\.discard\(\)/,
    'discard must reset both the staged secret field and the staged channels',
  )
})

test('the save and discard copy exists in every shipped language', () => {
  // The migration deleted these three keys from all three dictionaries while the
  // code that used them was removed. Restoring the control without the copy
  // would render the raw key (or an empty label) in zh/en/ru.
  for (const key of ['settings.save', 'settings.saving', 'settings.discard']) {
    const hits = [...locales.matchAll(new RegExp(`'${key}':`, 'g'))]
    assert.equal(hits.length, 3, `${key} must be defined in zh, en and ru`)
  }
})
