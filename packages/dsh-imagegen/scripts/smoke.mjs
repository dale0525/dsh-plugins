/**
 * Standalone smoke test for the built @logictan/dsh-imagegen artifacts:
 *
 *  A. host half loads and exposes the plugin contract
 *  B. generate engine works against a mock OpenAI-compatible upstream
 *     (text mode with b64_json, edit mode with multipart + url result)
 *  C. route handlers (settings bridge + generate) work over real HTTP
 *  D. client bundle registers via window.__ModuleLoader__ and the factory
 *     exposes apply/inject with the right shape
 *
 * Run: node scripts/smoke.mjs   (from the package root)
 */
import { createServer, request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const results = []
/** Run one check; async-aware and sequential so nothing races the servers. */
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------- A. host half
const host = await import(new URL('lib/index.js', root).href)

await check('A1 host exports the plugin contract', () => {
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.name, 'imagegen')
  assert.deepEqual(host.inject, ['webServer', 'systemPrompt', 'commands'])
  assert.equal(typeof host.Config, 'function')
  assert.equal(typeof host.ImageGenSettingsNamespace, 'string') // branded at runtime as string
  assert.equal(typeof host.makeRoutes, 'function')
  assert.equal(typeof host.generateImage, 'function')
})
await check('A2 Config schema validates + marks apiKey secret', () => {
  // The root schema is marked volatile (the host commits settings edits into
  // the running fiber), so resolve() hands back a live handle whose value is
  // read through get(), with defaults applied on the way in.
  const resolved = host.Config({ apiUrl: 'https://x/v1', apiKey: 'sk-1' })
  const value = resolved.get()
  assert.equal(value.apiKey, 'sk-1')
  assert.equal(value.enabled, true)
  assert.equal(value.allowAgentImageGeneration, true)
  assert.deepEqual(value.imageModels, [])
  // Config is the schemastery schema itself: the secret role lives on the
  // schema node, which the settings seam's redactor walks.
  assert.equal(host.Config.dict?.apiKey?.meta?.role, 'secret')
})

// ---------------------------------------------- B. engine vs mock upstream
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
let activeGenerationRequests = 0
let maxGenerationRequests = 0
// A second listener = a different origin (port) from the API base. It stands in
// for a malicious relay pointing image URLs at an attacker-controlled host.
const foreignAuthHeaders = []
const resultAuthHeaders = []
const foreignHost = createServer((req, res) => {
  foreignAuthHeaders.push(req.headers.authorization)
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(pngBytes)
})
await new Promise(resolve => foreignHost.listen(0, '127.0.0.1', resolve))
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/v1/models') {
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [
      { id: 'grok-imagine-image' },
      { id: 'gpt-image-2' },
      { id: 'gpt-4o' },
      { id: 'text-embedding-3-small' },
      { id: 'glm-image', capabilities: { image_generation: true } },
      { id: 'chat-only-model', capabilities: { image_generation: false } },
      { id: 'gpt-image-legacy', capabilities: { image_generation: false } },
      { id: 'gpt-image-2' },
    ] }))
    return
  }
  if (url.pathname === '/v1/images/generations') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    assert.ok(body.model === 'gpt-image-2' || body.model === 'grok-imagine-image')
    assert.ok(body.prompt === 'a cat' || body.prompt === 'a mismatch cat' || body.prompt === 'a background cat' || body.prompt === 'cancel this' || body.prompt === 'signed urls' || body.prompt === 'foreign url')
    if (body.model === 'gpt-image-2') {
      assert.equal(body.size, '1024x1024')
      assert.equal(body.quality, 'high')
    } else {
      assert.equal(body.aspect_ratio, '1:1')
      assert.equal(body.response_format, 'b64_json')
    }
    // The engine never sends `n`: Responses-API gateways reject the batch
    // parameter, so the requested count is satisfied by parallel requests.
    assert.equal(body.n, undefined)
    assert.equal(body.detail, body.model === 'grok-imagine-image' || body.prompt === 'signed urls' || body.prompt === 'foreign url' ? undefined : 'standard')
    res.writeHead(200, { 'content-type': 'application/json' })
    const data = body.prompt === 'foreign url'
      ? [{ url: `http://127.0.0.1:${foreignHost.address().port}/steal.png` }]
      : body.prompt === 'signed urls'
      ? [
          { b64_json: '', url: `http://127.0.0.1:${upstream.address().port}/image/gcs-signed.png?X-Goog-Credential=test&X-Goog-Signature=test` },
          { b64_json: '   ', url: `http://127.0.0.1:${upstream.address().port}/image/s3-signed.png?X-Amz-Credential=test&X-Amz-Signature=test` },
        ]
      : [
          { b64_json: pngBytes.toString('base64'), revised_prompt: 'a refined cat' },
          { url: `http://127.0.0.1:${upstream.address().port}/image/${body.prompt === 'a mismatch cat' ? 'mismatch' : 'result'}.png` },
        ]
    res.end(JSON.stringify({ created: 1, data }))
    return
  }
  if (url.pathname === '/v1/images/edits') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    assert.ok(req.headers['content-type'].startsWith('multipart/form-data'), 'multipart expected')
    const commandEdit = body.includes('edit via command') || body.includes('edit attached image')
    assert.ok(body.includes('name="prompt"') && (body.includes('edit this') || commandEdit), 'prompt part missing')
    assert.ok(body.includes('name="model"') && body.includes('gpt-image-2'), 'model part missing')
    if (!commandEdit) assert.ok(body.includes('name="size"') && body.includes('1536x1024'), 'size part missing')
    assert.ok(!body.includes('name="n"'), 'n must not be sent (batch param rejected)')
    assert.ok(body.includes('name="image"'), 'image part missing')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
    return
  }
  if (url.pathname === '/v1/chat/completions') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    const asked = body.messages.at(-1).content
    const reply = asked === 'think leak'
      ? '<think>\u9996\u5148\u5206\u6790\u7528\u6237\u9700\u6c42\u2026\uff08\u5927\u6bb5\u63a8\u7406\uff09</think>\nA lighthouse at dusk over a stormy sea.'
      : asked === 'dangling think'
        ? '<think>reasoning that never closes'
        : 'A calm meadow under morning light.'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
    return
  }
  if (url.pathname === '/image/result.png') {
    // Same-origin downloads (B1: API base is this server) keep the key; other
    // suites (Qwen / async providers on their own ports) point here from a
    // foreign origin and must arrive without it.
    resultAuthHeaders.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
    return
  }
  if (url.pathname === '/image/mismatch.png') {
    // Regression fixture: the provider declares JPEG while returning PNG bytes.
    res.writeHead(200, { 'content-type': 'image/jpeg' })
    res.end(pngBytes)
    return
  }
  if (url.pathname === '/image/gcs-signed.png' || url.pathname === '/image/s3-signed.png') {
    assert.equal(req.headers.authorization, undefined, 'presigned URLs must not receive the channel API key')
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

await check('B1 text generation normalizes b64_json + url items', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    // n=1: one request returns two data items (b64_json + url), both normalized.
    { mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '4k', n: 1, detail: 'standard' },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(result.images[0].revisedPrompt, 'a refined cat')
  assert.equal(result.images[1].b64, pngBytes.toString('base64'))
  assert.equal(result.images[1].mime, 'image/png')
  assert.equal(resultAuthHeaders.at(-1), 'Bearer sk-test', 'same-origin result URLs keep the channel API key')
})

await check('B2 signed URLs bypass API-key auth and empty base64 falls back to URL', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'signed urls', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(result.images[1].b64, pngBytes.toString('base64'))
})

await check('B2b result URLs on a foreign origin never receive the channel API key', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'foreign url', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(foreignAuthHeaders.length, 1)
  assert.equal(foreignAuthHeaders[0], undefined, 'a foreign-origin image URL must not carry the Bearer key')
})

await check('B3 edit mode sends multipart and normalizes', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'edit', model: 'gpt-image-2', prompt: 'edit this', size: '3:2', quality: '2k', n: 1, detail: '', image: `data:image/png;base64,${pngBytes.toString('base64')}` },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B3b edit mode forwards every reference image', async () => {
  const seen = { fields: [] }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('latin1')
    seen.fields = [...body.matchAll(/name="([^"]+)"/g)].map(match => match[1])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
    await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' },
      { mode: 'edit', model: 'gpt-image-2', prompt: 'combine both references', size: '1:1', quality: 'auto', n: 1, detail: '', image: dataUrl, images: [dataUrl, dataUrl] },
    )
    assert.deepEqual(seen.fields.filter(name => name.startsWith('image')), ['image[]', 'image[]', 'image[]'])
  } finally {
    server.close()
  }
})

await check('B4 config missing errors are user-presentable', async () => {
  await assert.rejects(
    host.generateImage({ apiUrl: '', apiKey: 'k' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
    /api_url 未配置/,
  )
  await assert.rejects(
    host.generateImage({ apiUrl: 'http://x', apiKey: '' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
    /api_key 未配置/,
  )
})

await check('B5 upstream error surfaces its message', async () => {
  const bad = createServer(async (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Unknown parameter: detail' } }))
  })
  await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve))
  const port = bad.address().port
  try {
    await assert.rejects(
      host.generateImage({ apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
      /Unknown parameter: detail/,
    )
  } finally {
    await new Promise(resolve => bad.close(resolve))
  }
})

await check('B6 dall-e-3 clamps params', async () => {
  const seen = []
  const dalle = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
  })
  await new Promise(resolve => dalle.listen(0, '127.0.0.1', resolve))
  const port = dalle.address().port
  try {
    await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      { mode: 'text', model: 'dall-e-3', prompt: 'x', size: '512x512', quality: 'high', n: 4, detail: 'high' },
    )
    // dall-e-3: params clamp to { model, size } and no `n` is ever sent.
    assert.deepEqual(seen[0], { model: 'dall-e-3', size: '1024x1024', prompt: 'x' })
  } finally {
    await new Promise(resolve => dalle.close(resolve))
  }
})

await check('B7 Volcengine Seedream uses Ark size and URL response fields', async () => {
  const seen = []
  const seedream = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push(body)
      assert.equal(body.model, 'doubao-seedream-5-0-pro-260628')
      assert.equal(body.size, '2K')
      assert.equal(body.response_format, 'url')
      assert.equal(body.resolution, undefined)
      assert.equal(body.prompt, 'a volcano')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${seedream.address().port}/seedream.png` }] }))
      return
    }
    if (url.pathname === '/seedream.png') {
      assert.equal(req.headers.authorization, 'Bearer sk-seedream')
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(pngBytes)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => seedream.listen(0, '127.0.0.1', resolve))
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${seedream.address().port}/v1`, apiKey: 'sk-seedream' },
      { mode: 'text', model: 'doubao-seedream-5-0-pro-260628', prompt: 'a volcano', size: '16:9', quality: '4k', n: 1, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(seen.length, 1)
  } finally {
    await new Promise(resolve => seedream.close(resolve))
  }
})

await check('B8 Zhipu GLM-Image uses the official generation contract', async () => {
  const seen = []
  const zhipu = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/api/paas/v4/images/generations') {
      seen.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => zhipu.listen(0, '127.0.0.1', resolve))
  const port = zhipu.address().port
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/api/paas/v4`, apiKey: 'zhipu-key' },
      { mode: 'text', model: 'glm-image', prompt: 'x', size: '1:1', quality: '4k', n: 1, detail: 'high' },
    )
    assert.equal(result.images.length, 1)
    assert.deepEqual(seen[0], {
      path: '/api/paas/v4/images/generations',
      body: { model: 'glm-image', prompt: 'x', size: '1024x1024', quality: 'hd' },
    })
  } finally {
    await new Promise(resolve => zhipu.close(resolve))
  }
})

await check('B9 Qwen-Image speaks the DashScope native contract', async () => {
  const seen = []
  const qwen = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
      seen.push({
        auth: req.headers.authorization,
        path: url.pathname,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: `http://127.0.0.1:${upstreamPort}/image/result.png` }] } }] },
        usage: { image_count: 1 },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => qwen.listen(0, '127.0.0.1', resolve))
  const port = qwen.address().port
  const base = `http://127.0.0.1:${port}/api/v1`
  try {
    // Versioned series: wide ratio maps to the HD size set and n batches natively.
    const result = await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'text', model: 'qwen-image-3.0', prompt: 'a cat', size: '16:9', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.deepEqual(seen[0], {
      auth: 'Bearer qwen-key',
      path: '/api/v1/services/aigc/multimodal-generation/generation',
      body: {
        model: 'qwen-image-3.0',
        input: { messages: [{ role: 'user', content: [{ text: 'a cat' }] }] },
        parameters: { size: '2688*1536', n: 2 },
      },
    })
    // Classic series: single image per call, fixed size list, no n parameter.
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'text', model: 'qwen-image-plus', prompt: 'x', size: '9:16', quality: '2k', n: 4, detail: '' },
    )
    assert.deepEqual(seen[0].body.parameters, { size: '928*1664' })
    // Edit mode rides the reference image as a message content item.
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'edit', model: 'qwen-image-3.0', prompt: 'edit this', size: '1:1', quality: 'auto', n: 1, detail: '', image: `data:image/png;base64,${pngBytes.toString('base64')}` },
    )
    assert.deepEqual(seen[0].body.input.messages[0].content, [
      { image: `data:image/png;base64,${pngBytes.toString('base64')}` },
      { text: 'edit this' },
    ])
    assert.deepEqual(seen[0].body.parameters, { size: '2048*2048' })
  } finally {
    await new Promise(resolve => qwen.close(resolve))
  }
})

await check('B9b MiniMax image-01 speaks the native /image_generation contract', async () => {
  const seen = []
  let reply = () => ({ id: 'req-1', data: { image_base64: [pngBytes.toString('base64')] }, metadata: { failed_count: '0', success_count: '1' }, base_resp: { status_code: 0, status_msg: 'success' } })
  const minimax = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/v1/image_generation') {
      seen.push({ auth: req.headers.authorization, path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      // MiniMax answers HTTP 200 for failures too; base_resp carries the verdict.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply()))
      return
    }
    res.writeHead(404)
    res.end('404 page not found')
  })
  await new Promise(resolve => minimax.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${minimax.address().port}/v1`
  try {
    // Text mode: aspect_ratio passthrough, native n batching, base64 results.
    const result = await host.generateImage(
      { apiUrl: base, apiKey: 'mm-key' },
      { mode: 'text', model: 'image-01', prompt: 'a boat', size: '16:9', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(result.images[0].mime, 'image/png')
    assert.deepEqual(seen[0], {
      auth: 'Bearer mm-key',
      path: '/v1/image_generation',
      body: { model: 'image-01', prompt: 'a boat', response_format: 'base64', aspect_ratio: '16:9', n: 2 },
    })
    // auto size omits aspect_ratio; n=1 omits n; n is capped at 9.
    seen.length = 0
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: 'auto', quality: '4k', n: 1, detail: '' })
    assert.deepEqual(seen[0].body, { model: 'image-01', prompt: 'x', response_format: 'base64' })
    seen.length = 0
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 50, detail: '' })
    assert.ok(seen[0].body.n <= 9, `n must be capped at 9, got ${seen[0].body.n}`)
    // Edit mode: one character subject_reference with the data URL.
    seen.length = 0
    const ref = `data:image/png;base64,${pngBytes.toString('base64')}`
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'edit', model: 'image-01', prompt: 'same person, beach', size: '3:4', quality: 'auto', n: 1, detail: '', image: ref })
    assert.deepEqual(seen[0].body.subject_reference, [{ type: 'character', image_file: ref }])
    assert.equal(seen[0].body.aspect_ratio, '3:4')
    // Prompts at MiniMax's 1500-char limit fail fast, before any upstream call.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1600), size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'prompt-too-long' && /1500/.test(error.message),
    )
    assert.equal(seen.length, 0)
    // Unsupported panel ratio is rejected locally before any upstream call.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '5:7', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'size-unsupported',
    )
    assert.equal(seen.length, 0)
    // HTTP 200 + non-zero base_resp.status_code surfaces as an upstream rejection.
    reply = () => ({ id: 'req-2', data: null, base_resp: { status_code: 2013, status_msg: 'invalid params, unsupported model: image-99' } })
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'upstream-rejected' && /2013/.test(error.message) && /image-99/.test(error.message),
    )
    reply = () => ({ id: 'req-3', data: null, base_resp: { status_code: 2049, status_msg: 'invalid api key' } })
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'upstream-unauthorized',
    )
    // The catalog classifies the family so the UI shows the right badge, and a
    // wrong-family model on the same base must NOT hit /image_generation.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
    )
    assert.equal(seen.length, 0, 'non-MiniMax models keep the OpenAI route')
  } finally {
    await new Promise(resolve => minimax.close(resolve))
  }
})

await check('B9c prompt character limits share one source between engine and panel counter', async () => {
  // Only MiniMax documents a limit today; everything else — including
  // unrecognized ids — must report null so the panel hides the counter.
  assert.equal(host.promptCharLimit('image-01'), 1500)
  assert.equal(host.promptCharLimit('minimax-image-01'), 1500)
  assert.equal(host.promptCharLimit('gpt-image-2'), null)
  assert.equal(host.promptCharLimit('doubao-seedream-4.0'), null)
  assert.equal(host.promptCharLimit('totally-unknown'), null)
  // The engine enforces exactly that shared number: 1499 chars pass through
  // to the fake upstream, 1500 fail fast before any network call.
  const seen = []
  const minimax = createServer(async (req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'r', data: { image_base64: [pngBytes.toString('base64')] }, base_resp: { status_code: 0, status_msg: 'ok' } }))
  })
  await new Promise(resolve => minimax.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${minimax.address().port}/v1`
  try {
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1499), size: '1:1', quality: 'auto', n: 1, detail: '' })
    assert.equal(seen.length, 1, '1499 chars must reach the upstream')
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1500), size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'prompt-too-long' && /1500/.test(error.message),
    )
    assert.equal(seen.length, 1, '1500 chars must fail fast without an upstream call')
  } finally {
    await new Promise(resolve => minimax.close(resolve))
  }
})

await check('B10 async two-step providers submit, poll, and flatten URL arrays', async () => {
  const submissions = []
  const polls = new Map()
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/v1/images/generations') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const taskId = `task-${submissions.length + 1}`
      submissions.push({ taskId, body, authorization: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ status: 'submitted', task_id: taskId }] }))
      return
    }
    if (url.pathname.startsWith('/v1/tasks/')) {
      const taskId = url.pathname.slice('/v1/tasks/'.length)
      const count = (polls.get(taskId) ?? 0) + 1
      polls.set(taskId, count)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (count === 1) {
        res.end(JSON.stringify({ data: { status: 'processing', task_id: taskId } }))
      } else {
        res.end(JSON.stringify({ data: { status: 'completed', task_id: taskId, result: { images: [{ url: [`http://127.0.0.1:${upstreamPort}/image/result.png`, `data:image/png;base64,${pngBytes.toString('base64')}`] }] } } }))
      }
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'async image', size: '1:1', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(submissions.length, 2, 'one upstream task is submitted for each requested image')
    assert.equal(result.images.length, 4, 'each completed task URL array is flattened')
    assert.ok(submissions.every(item => item.authorization === 'Bearer async-key'))
    assert.ok([...polls.values()].every(count => count >= 2), 'submitted tasks are polled until completed')
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

await check('B11 async provider failures surface the remote error', async () => {
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'submitted', task_id: 'failed-task' } }))
      return
    }
    if (url.pathname === '/v1/tasks/failed-task') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'failed', error: { message: 'content rejected' } } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  try {
    await assert.rejects(
      host.generateImage(
        { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
        { mode: 'text', model: 'gpt-image-2', prompt: 'bad', size: '1:1', quality: 'auto', n: 1, detail: '' },
      ),
      /content rejected/,
    )
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

await check('B12 async provider cancellation aborts polling', async () => {
  let pollCount = 0
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ status: 'submitted', task_id: 'cancel-task' }] }))
      return
    }
    if (url.pathname === '/v1/tasks/cancel-task') {
      pollCount += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'processing', task_id: 'cancel-task' } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  const controller = new AbortController()
  try {
    const pending = host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'cancel', size: '1:1', quality: 'auto', n: 1, detail: '' },
      { signal: controller.signal },
    )
    await new Promise(resolve => setTimeout(resolve, 80))
    controller.abort()
    await assert.rejects(pending)
    assert.ok(pollCount >= 1)
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

// ------------------------------------------------- C. routes over real HTTP
const stored = new Map() // namespace -> user section
const seam = {
  writable: true,
  describe({ redactSecrets } = {}) {
    const value = { enabled: true, announceToAgent: true, apiUrl: 'http://upstream/v1', apiKey: 'sk-secret' }
    const user = stored.get('imagegen')
    const merged = { ...value, ...user }
    const view = {
      ns: 'imagegen',
      value: redactSecrets ? { ...merged, apiKey: undefined } : merged,
      revision: stored.get('rev') ?? 0,
      ...user !== undefined ? { user: redactSecrets ? { ...user, apiKey: undefined } : user } : {},
      applies: 'live',
      ...redactSecrets ? { secrets: [{ path: ['apiKey'], set: (user?.apiKey ?? '') !== '' }] } : {},
    }
    return [view]
  },
  async mutate(ns, ops, expectedRevision) {
    assert.equal(String(ns), 'imagegen')
    const current = { ...(stored.get('imagegen') ?? {}) }
    for (const op of ops) {
      if (op.op === 'set') current[op.path[0]] = op.value
      else if (op.op === 'unset') delete current[op.path[0]]
    }
    stored.set('imagegen', current)
    stored.set('rev', (stored.get('rev') ?? 0) + 1)
  },
}
const agentPreviewImage = Buffer.from('agent-preview-image')
const agentPreviewRef = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: agentPreviewImage.length,
  width: 1,
  height: 1,
}
const attachments = {
  async readImage(ref) {
    assert.equal(ref.attachmentId, agentPreviewRef.attachmentId)
    assert.equal(ref.mediaType, agentPreviewRef.mediaType)
    assert.equal(ref.bytes, agentPreviewRef.bytes)
    return { ref: agentPreviewRef, data: agentPreviewImage }
  },
  async saveImage(input) {
    return {
      attachmentId: `sha256:${'b'.repeat(64)}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }
  },
}
const pendingConversationImages = new Map()
const routes = host.makeRoutes({
  settings: seam,
  resolve: () => ({ apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' }),
  resolvePrompt: () => ({ apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test', model: 'chat-test' }),
  attachments,
  pendingConversationImages,
})
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const route = routes.find(r => r.kind === 'exact'
    ? r.path === pathname
    : pathname === r.path || pathname.startsWith(`${r.path}/`))
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  route.handler(req, res).catch(error => {
    res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const post = async (path, body, headers = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    throw new Error(`HTTP ${response.status} returned non-JSON body: ${text || '<empty>'}`)
  }
}

await check('C0b prompt enhance strips reasoning-model <think> blocks', async () => {
  // Closed think block: only the visible answer may reach the prompt box.
  const leak = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'think leak' })
  assert.equal(leak.status, 200)
  assert.equal(leak.body.ok, true)
  assert.equal(leak.body.prompt, 'A lighthouse at dusk over a stormy sea.')
  // Dangling unclosed <think>: everything after it is reasoning, so the
  // enhancer must fail loudly instead of returning the raw reasoning text.
  const dangling = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'dangling think' })
  assert.equal(dangling.body.ok, false)
  assert.match(dangling.body.message, /only reasoning content/)
  // Clean content passes through untouched.
  const clean = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'clean please' })
  assert.equal(clean.body.prompt, 'A calm meadow under morning light.')
})

await check('C1 settings describe serves the redacted namespace', async () => {
  const { status, body } = await post('/api/dsh-imagegen/settings/describe', {})
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value.writable, true)
  assert.equal(body.value.namespaces.length, 1)
  const view = body.value.namespaces[0]
  assert.equal(view.ns, 'imagegen')
  assert.equal(view.value.apiUrl, 'http://upstream/v1')
  assert.equal(view.value.apiKey, undefined)
  assert.deepEqual(view.secrets, [{ path: ['apiKey'], set: false }])
})

await check('C2 settings mutate writes + redacts the key', async () => {
  const { body } = await post('/api/dsh-imagegen/settings/mutate', {
    ns: 'imagegen',
    ops: [{ op: 'set', path: ['apiKey'], value: 'sk-new' }],
    expectedRevision: 0,
  })
  assert.equal(body.ok, true)
  assert.equal(body.value.secrets.find(s => s.path[0] === 'apiKey').set, true)
  assert.equal(body.value.value.apiKey, undefined)
  assert.equal(stored.get('imagegen').apiKey, 'sk-new')
})

await check('C5 image model discovery and configured-model allow-list work', async () => {
  const discovered = await post('/api/dsh-imagegen/image-models', {})
  assert.equal(discovered.body.ok, true)
  assert.deepEqual(discovered.body.models, ['glm-image', 'gpt-image-2', 'grok-imagine-image'])
  const presets = await post('/api/dsh-imagegen/presets', {})
  assert.equal(presets.body.ok, true)
  assert.deepEqual(presets.body.presets.find(preset => preset.id === 'openai-official').models, [{ alias: 'gpt-image-2.5', id: 'gpt-image-2.5' }, { alias: 'gpt-image-2', id: 'gpt-image-2' }])
  assert.deepEqual(presets.body.presets.find(preset => preset.id === 'zhipu-official').models, [{ alias: 'glm-image', id: 'glm-image' }])
  const rejected = await post('/api/dsh-imagegen/tasks/submit', {
    mode: 'text', model: 'not-configured', prompt: 'a cat', size: 'auto', quality: 'auto', n: 1, detail: '',
  })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.code, 'image-model-not-configured')
})

await check('C7 Agent tool-result image route serves durable attachments without a session-log image reference', async () => {
  const query = new URLSearchParams({
    attachment_id: agentPreviewRef.attachmentId,
    media_type: agentPreviewRef.mediaType,
    bytes: String(agentPreviewRef.bytes),
    width: String(agentPreviewRef.width),
    height: String(agentPreviewRef.height),
  })
  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/agent-image?${query}`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), agentPreviewImage)
  const invalid = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/agent-image?attachment_id=bad`)
  assert.equal(invalid.status, 400)
})

await check('C8 composer images can be staged for the direct edit_image command', async () => {
  const staged = await post('/api/dsh-imagegen/conversation-image', {
    sessionId: 'session-staged',
    dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
    name: 'staged.png',
  })
  assert.equal(staged.body.ok, true)
  assert.equal(pendingConversationImages.has('session-staged'), true)
  assert.equal(pendingConversationImages.get('session-staged').mediaType, 'image/png')
})

await check('C9 Agent tools wait for results, keep images in the UI view, edit, and enforce the allow setting', async () => {
  const tools = new Map()
  const saved = new Map()
  let serial = 0
  const attachmentStore = {
    async saveImages(images) {
      return images.map((image) => {
        assert.equal(image.mediaType, 'image/png', 'attachment media type must match the encoded image bytes')
        const attachmentId = `attachment-${++serial}`
        const ref = { attachmentId, mediaType: image.mediaType, bytes: image.data.byteLength, width: 1, height: 1, name: image.name }
        saved.set(attachmentId, { ref, data: image.data })
        return ref
      })
    },
    async readImage(ref) {
      lastReadImageAttachmentId = ref.attachmentId
      const storedImage = saved.get(ref.attachmentId)
      assert.ok(storedImage, 'the returned source_image must resolve through the attachment store')
      return storedImage
    },
  }
  let enabled = true
  let lastReadImageAttachmentId
  const sent = []
  const agent = { send: (...args) => { sent.push(args) } }
  const runtime = new host.ImageGenerationRuntime(
    () => ({
      channels: [{
        id: 'default',
        preset: '',
        name: 'Default',
        apiUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test',
        models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      }],
      defaultChannelId: 'default',
    }),
    { append: async () => [] },
  )
  const dispose = host.registerAgentImageTools({
    tools: { register: definition => { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } } },
    attachments: attachmentStore,
  }, runtime, () => ({
    enabled: true,
    allowAgentImageGeneration: enabled,
    defaultChannelId: 'default',
    channels: [{
      id: 'default',
      preset: '',
      name: 'Default',
      apiUrl: 'configured',
      apiKey: 'configured',
      models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
    }],
  }))
  try {
    const generated = await tools.get('generate_image').execute({ prompt: 'a mismatch cat', size: '1:1', quality: '4k', detail: 'standard' }, { agent })
    assert.equal(generated.status, 'completed', 'the Agent tool waits for the task to finish')
    assert.equal(generated.images.length, 2)
    const generatedRendered = tools.get('generate_image').output.render({ prompt: 'a cat' }, generated)
    assert.equal(generatedRendered.filter(block => block.type === 'image').length, 0, 'generated images stay out of model-facing tool content')
    const generatedArgs = { prompt: 'a cat' }
    const generatedMeta = tools.get('generate_image').output.presentationMeta(generatedArgs, generated)
    const generatedView = tools.get('generate_image').presentResult(generatedArgs, {
      content: generatedRendered,
      isError: false,
      meta: generatedMeta,
    })
    assert.equal(generatedView?.card, 'generic')
    assert.equal(generatedView?.content?.filter(block => block.type === 'image').length, 2, 'completed tool results keep image attachments in the UI view')
    assert.equal(saved.size, 2, 'completed generation stores attachments once')
    assert.equal(sent.length, 0, 'completion does not inject a conversation message')
    const complete = await tools.get('get_image_generation_task').execute({ task_id: generated.task_id }, {})
    assert.equal(complete.status, 'completed')
    assert.equal(complete.images.length, 2)
    assert.equal(saved.size, 2, 'status lookup reuses the completion attachments instead of saving duplicate files')

    const background = await tools.get('generate_image').execute({ prompt: 'a background cat', size: '1:1', quality: '4k', detail: 'standard', wait_for_completion: false }, { agent })
    assert.ok(background.status === 'queued' || background.status === 'running', 'background mode returns before completion')
    assert.equal(sent.length, 0, 'background mode also does not inject a conversation message')
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (runtime.queue.list().find(task => task.id === background.task_id)?.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(runtime.queue.list().find(task => task.id === background.task_id)?.status, 'completed')
    const backgroundComplete = await tools.get('get_image_generation_task').execute({ task_id: background.task_id }, {})
    assert.equal(backgroundComplete.status, 'completed')
    assert.equal(saved.size, 4)

    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'a cat', model: 'grok-imagine-image' }, {}),
      /not configured/,
    )

    const edited = await tools.get('edit_image').execute({ prompt: 'edit this', source_image: complete.images[0], size: '3:2', quality: '2k' }, { signal: new AbortController().signal })
    assert.equal(edited.status, 'completed', 'image edits also wait for completion')
    assert.equal(edited.images.length, 1)
    const editedRendered = tools.get('edit_image').output.render({ prompt: 'edit this' }, edited)
    assert.equal(editedRendered.filter(block => block.type === 'image').length, 0, 'edit_image output stays out of model-visible image context')
    assert.equal(saved.size, 5)

    const commands = new Map()
    const pending = new Map()
    const commandDispose = host.registerEditImageCommand({
      commands: { register: definition => { commands.set(definition.name, definition); return () => { commands.delete(definition.name) } } },
      attachments: attachmentStore,
    }, runtime, () => ({
      enabled: true,
      allowAgentImageGeneration: true,
      defaultChannelId: 'default',
      channels: [{
        id: 'default',
        preset: '',
        name: 'Default',
        apiUrl: 'configured',
        apiKey: 'configured',
        models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      }],
    }), {
      get: sessionId => pending.get(sessionId),
      consume: (sessionId, ref) => { if (pending.get(sessionId)?.attachmentId === ref.attachmentId) pending.delete(sessionId) },
    })
    try {
      assert.ok(commands.has('edit_image'), 'the /edit_image command is registered')
      const command = commands.get('edit_image')
      assert.deepEqual(command.input, { hint: 'Describe how to modify the latest image', images: true }, 'the command accepts composer images')
      const noImageAgent = { session: { deriveMessages: () => [] } }
      assert.deepEqual(await command.handler({ agent: noImageAgent, rawInput: '   ', signal: new AbortController().signal }), {
        kind: 'error',
        text: '请提供图片修改描述，例如：/edit_image 把背景改成夜景',
      })
      assert.deepEqual(await command.handler({ agent: noImageAgent, rawInput: 'edit this', signal: new AbortController().signal }), {
        kind: 'error',
        text: '当前对话没有可用图片，请先上传图片或把画廊图片加入对话。',
      })
      const commandSource = complete.images[0]
      const commandReference = {
        attachmentId: commandSource.attachment_id,
        mediaType: commandSource.media_type,
        bytes: commandSource.bytes,
        width: commandSource.width,
        height: commandSource.height,
        name: commandSource.name,
      }
      const commandAgent = { session: { deriveMessages: () => [{ content: [{ type: 'image', attachment: commandReference }] }] } }
      const commandResult = await command.handler({ agent: commandAgent, rawInput: 'edit via command', signal: new AbortController().signal })
      assert.equal(commandResult.kind, 'success')
      assert.match(commandResult.text, /图片编辑已完成/)
      assert.equal(sent.length, 0, 'slash command does not send a chat-model message')
      const invocationReference = { ...commandReference, attachmentId: `sha256:${'d'.repeat(64)}` }
      saved.set(invocationReference.attachmentId, { ref: invocationReference, data: pngBytes })
      const invocationResult = await command.handler({
        agent: noImageAgent,
        attachments: [{ type: 'image', attachment: invocationReference }],
        rawInput: 'edit attached image',
        signal: new AbortController().signal,
      })
      assert.equal(invocationResult.kind, 'success', 'an image carried by the command reaches the plugin edit path')
      assert.equal(lastReadImageAttachmentId, invocationReference.attachmentId, 'the invocation image is used as the edit source')
      const pendingRef = { ...commandReference, attachmentId: `sha256:${'c'.repeat(64)}` }
      saved.set(pendingRef.attachmentId, { ref: pendingRef, data: pngBytes })
      pending.set('pending-session', pendingRef)
      const pendingResult = await command.handler({
        agent: { id: 'pending-session', session: { deriveMessages: () => [{ content: [{ type: 'image', attachment: commandReference }] }] } },
        rawInput: 'edit via command',
        signal: new AbortController().signal,
      })
      assert.equal(pendingResult.kind, 'success', 'staged composer image is accepted without a chat message')
      assert.equal(lastReadImageAttachmentId, pendingRef.attachmentId, 'the staged image takes precedence over older session history')
      assert.equal(pending.has('pending-session'), false, 'staged image is consumed after a successful edit')
    } finally {
      commandDispose()
    }

    const aborted = new AbortController()
    aborted.abort(new Error('test cancellation'))
    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'cancel this' }, { signal: aborted.signal }),
      /test cancellation/,
    )
    assert.equal(runtime.queue.list().find(task => task.request.prompt === 'cancel this')?.status, 'cancelled')

    enabled = false
    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'a cat' }, {}),
      /disabled in Settings/,
    )
  } finally {
    dispose()
  }
})

await new Promise(resolve => server.close(resolve))

// -------------------------------------------------- D. client bundle shape
await check('D1 client bundle registers via __ModuleLoader__ and exposes apply/inject', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (h) => { handoff = h } },
    },
  }
  sandbox.window.window = sandbox.window
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined, 'load() was called')
  assert.equal(handoff.id, '@logictan/dsh-imagegen')
  assert.equal(typeof handoff.factory, 'function')
  // Evaluate the factory with stubbed platform modules; only the exports
  // surface is exercised (apply never runs without a real DOM). The stub set
  // is asserted below, so it stays exactly the platform modules the bundle
  // resolves through the injected require.
  const stubs = {
    'react': {
      Fragment: 'Fragment',
      createContext: (value) => ({ Provider: () => null, Consumer: () => null, _currentValue: value }),
      createElement: () => null,
      forwardRef: (render) => ({ $$typeof: Symbol.for('react.forward_ref'), render }),
      memo: (fn) => ({ $$typeof: Symbol.for('react.memo'), type: fn }),
      useContext: () => ({}),
      useMemo: (factory) => factory(),
      useRef: () => ({ current: null }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: (initial) => ({
      getSnapshot: () => initial,
      set: () => {},
      update: () => {},
      subscribe: () => () => {},
    }) },
  }
  const required = []
  const exportsOf = handoff.factory((spec) => {
    required.push(spec)
    const stub = stubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })
  assert.equal([...new Set(required)].sort().join(','), Object.keys(stubs).sort().join(','))
  assert.equal(typeof exportsOf.apply, 'function')
  // Cross-realm array (VM context): compare contents, not identity.
  assert.equal([...exportsOf.inject].join(','), 'slots,locale,connection')
})

await new Promise(resolve => upstream.close(resolve))

// ------------------------------------------------------------------ summary
console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST OK')
process.exit(process.exitCode === 1 ? 1 : 0)
