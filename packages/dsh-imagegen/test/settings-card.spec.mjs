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

test('the card no longer carries its own save and discard controls', () => {
  // Commit-on-blur is the interaction the design specifies and the only one the
  // host's slot contract can express: there is no page-level save band a plugin
  // can reach.
  assert.ok(
    !/settings\.save\b|t\('settings\.save'\)/.test(card),
    'the per-card save button must be gone',
  )
  assert.ok(
    !/props\.discard\(\)/.test(card),
    'the per-card discard button must be gone',
  )
})
