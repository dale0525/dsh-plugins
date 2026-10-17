import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

function contextWith({ agent, streamSink, settings }) {
  const injected = []
  const ctx = {
    inject(names, callback) {
      injected.push(names)
      if (callback !== undefined) callback({})
    },
    on(name, listener) {
      if (name === 'llm/stream') streamSink.push(listener)
    },
    logger: { warn() {}, debug() {}, info() {} },
    agents: { get: () => agent },
    get: (name) => (name === 'settings' ? settings : undefined),
  }
  return { ctx, injected }
}

function fakeAgent() {
  const steered = []
  return {
    steer: (message) => steered.push(message),
    inject: () => {},
    cancel: () => {},
    steered,
  }
}

test('plugin does not export Config schema', () => {
  assert.equal(plugin.Config, undefined, 'Config export must be removed')
})

test('apply mounts without a settings service and requests none', () => {
  const agent = fakeAgent()
  const stream = []
  const { ctx, injected } = contextWith({ agent, streamSink: stream, settings: undefined })

  plugin.apply(ctx)

  assert.equal(stream.length, 1, 'the guard must observe llm/stream')
  assert.deepEqual(
    injected.filter((names) => names.includes('settings')),
    [],
    'the guard must not wait on a settings service to mount',
  )
  assert.deepEqual(plugin.inject, ['agents'], 'the guard declares only the agents service')
})

test('the retired namespace is not referenced anywhere in the package manifest', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh?.client, undefined, 'dsh.client must be completely removed')
  assert.equal(
    manifest.dependencies?.['@deepseek-ai/dsh-settings'],
    undefined,
    'the guard must not depend on dsh-settings',
  )
})
