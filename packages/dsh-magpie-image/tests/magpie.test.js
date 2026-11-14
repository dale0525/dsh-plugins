/**
 * Contract tests for the one trait that is NOT a pass-through: reference-image
 * conversion, plus the content-block projection.
 *
 * magpie refuses a local absolute path from any computer but the one it runs on
 * (measured 2026-11-07 against the live endpoint; the refusal reads
 * "generate_image reads a file only for an agent on the computer magpie runs
 * on"). It accepts a reference only as `data:<mime>;base64,<bytes>` or an
 * http(s) URL. DSH attachments hold decoded bytes, so `toReferenceImage` is the
 * whole adaptation and the reason this package cannot be a thin `mcp-client`
 * pass-through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toReferenceImage } from '../src/reference-image.js';
import { extractText, extractImages } from '../src/content.js';
import { pendingTaskId, createToolDefinitions } from '../src/tools.js';

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('toReferenceImage encodes attachment bytes as a magpie data URL', () => {
  const url = toReferenceImage(PNG_BYTES, 'image/png');
  assert.equal(url, 'data:image/png;base64,iVBORw0KGgo=');
});

test('toReferenceImage keeps the declared media type, not a guessed one', () => {
  const url = toReferenceImage(PNG_BYTES, 'image/jpeg');
  assert.ok(url.startsWith('data:image/jpeg;base64,'));
});

test('extractText joins the text blocks and marks non-text ones positionally', () => {
  const text = extractText([
    { type: 'text', text: 'Generated with linux-hub/gpt-image-2.' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
  ]);
  assert.equal(text, 'Generated with linux-hub/gpt-image-2.\n[image content is not projected to text]');
});

test('extractImages decodes every image block in order', () => {
  const images = extractImages([
    { type: 'text', text: 'ignored' },
    { type: 'image', data: Buffer.from(PNG_BYTES).toString('base64'), mimeType: 'image/png' },
  ]);
  assert.equal(images.length, 1);
  assert.equal(images[0].mediaType, 'image/png');
  assert.deepEqual([...images[0].data], [...PNG_BYTES]);
});

test('extractImages refuses a media type outside the attachment vocabulary', () => {
  // `saveImages` accepts PNG/JPEG/WebP/GIF only; a TIFF from a provider would
  // otherwise reach the attachment store and fail there instead, one layer later.
  assert.throws(
    () => extractImages([{ type: 'image', data: 'AAAA', mimeType: 'image/tiff' }]),
    /not an image type/i,
  );
});

test('extractImages refuses non-canonical base64', () => {
  // `saveImages` re-encodes and compares; a payload that does not round-trip is
  // not the bytes the provider sent.
  assert.throws(
    () => extractImages([{ type: 'image', data: 'AAA', mimeType: 'image/png' }]),
    /base64/i,
  );
});
test('pendingTaskId reads the id out of magpie\'s still-running sentence', () => {
  // Verbatim from a live 1536x1024 high-quality request that outlived magpie's
  // ~20-second budget (2026-11-07). The id is prose, not a bare string.
  const text =
    'The image is still being made (20 s so far; it can take a few minutes). It goes on without this call. '
    + 'Don\'t ask for it again: call generation_result with id "img_26a854463cbc6b695429918a" to wait for it and get it.';
  assert.equal(pendingTaskId(text), 'img_26a854463cbc6b695429918a');
});

test('pendingTaskId reports no id for a finished or failed result', () => {
  assert.equal(pendingTaskId('Generated with linux-hub/gpt-image-2. The image is in this answer'), undefined);
  assert.equal(pendingTaskId('no image: hub.linux.do: 400 Bad Request: invalid request: file too large'), undefined);
});

test('defineTool compiles both output schemas into valid JSON Schema', async () => {
  // defineTool compiles the spec-form schema (`required: true` on a property)
  // into JSON Schema (`required: [...]` on the object node). Registering the raw
  // object instead skipped this and threw at the runtime assertion, leaving NO
  // tool registered — the exact failure this guards.
  const { assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools');
  const defs = createToolDefinitions(
    { attachments: { saveImages: async () => [], readImage: async () => ({}) } },
    { callTool: async () => ({ content: [] }) },
  );
  assert.equal(defs.length, 2);
  for (const def of defs) {
    assertSupportedJsonSchema(def.output.schema);
    assert.equal(typeof def.presentResult, 'function');
    assert.equal(typeof def.output.presentationMeta, 'function');
  }
  // The nested image ref must be a real JSON-Schema required array, not a
  // per-property boolean.
  const imageItems = defs[0].output.schema.properties.images.items;
  assert.deepEqual(imageItems.required, ['attachment_id', 'media_type', 'bytes', 'width', 'height']);
});

test('reference_images parameters compile to a JSON-Schema required array', async () => {
  const { createToolDefinitions: make } = await import('../src/tools.js');
  const [generate] = make(
    { attachments: { saveImages: async () => [], readImage: async () => ({}) } },
    { callTool: async () => ({ content: [] }) },
  );
  const items = generate.parameters.properties.reference_images.items;
  assert.deepEqual(items.required, ['attachment_id', 'media_type', 'bytes', 'width', 'height']);
  assert.equal(items.properties.attachment_id.type, 'string');
});

test('presentResult turns stored image meta into attachment image blocks', async () => {
  // Without this the image exists as an attachment but the chat only shows the
  // JSON text, so the picture never appears beside the call.
  const { createToolDefinitions } = await import('../src/tools.js');
  const def = createToolDefinitions(
    { attachments: { saveImages: async () => [], readImage: async () => ({}) } },
    { callTool: async () => ({ content: [] }) },
  )[0];
  assert.equal(typeof def.presentResult, 'function');
  const result = def.presentResult({ prompt: 'x' }, {
    isError: false,
    meta: { images: [{ attachment_id: 'sha256:abc', media_type: 'image/png', bytes: 10, width: 4, height: 5 }] },
  });
  assert.equal(result.card, 'generic');
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].attachment.attachmentId, 'sha256:abc');
});

test('presentResult contributes nothing when the call failed or returned no image', async () => {
  const { createToolDefinitions } = await import('../src/tools.js');
  const def = createToolDefinitions(
    { attachments: { saveImages: async () => [], readImage: async () => ({}) } },
    { callTool: async () => ({ content: [] }) },
  )[0];
  assert.equal(def.presentResult({ prompt: 'x' }, { isError: true, meta: { images: [] } }), undefined);
  assert.equal(def.presentResult({ prompt: 'x' }, { isError: false, meta: { images: [] } }), undefined);
});

// ---- image route ----------------------------------------------------------

function makeRes() {
  const res = {
    status: 0, headers: {}, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    end(body) { this.body = body; },
  };
  return res;
}

async function callRoute(handler, { method = 'GET', url, fence } = {}) {
  const res = makeRes();
  await handler({ method, url }, res);
  return res;
}

test('image route refuses a missing trust fence', async () => {
  const { makeRoutes } = await import('../src/routes.js');
  const [route] = makeRoutes({ attachments: { readImage: async () => { throw new Error('unused'); } }, connection: () => undefined });
  const res = await callRoute(route.handler, { url: '/api/dsh-magpie-image/image?attachment_id=x' });
  assert.equal(res.status, 403);
});

test('image route propagates the fence rejection status', async () => {
  const { makeRoutes } = await import('../src/routes.js');
  const [route] = makeRoutes({ attachments: { readImage: async () => { throw new Error('unused'); } }, connection: () => ({ requestRejection: () => 401 }) });
  const res = await callRoute(route.handler, { url: '/api/dsh-magpie-image/image?attachment_id=x' });
  assert.equal(res.status, 401);
});

test('image route accepts only GET', async () => {
  const { makeRoutes } = await import('../src/routes.js');
  const [route] = makeRoutes({ attachments: { readImage: async () => { throw new Error('unused'); } }, connection: () => ({ requestRejection: () => undefined }) });
  const res = await callRoute(route.handler, { method: 'POST', url: '/api/dsh-magpie-image/image' });
  assert.equal(res.status, 405);
});

test('image route rejects a malformed reference before touching the store', async () => {
  const { makeRoutes } = await import('../src/routes.js');
  let called = false;
  const [route] = makeRoutes({
    attachments: { readImage: async () => { called = true; throw new Error('should not run'); } },
    connection: () => ({ requestRejection: () => undefined }),
  });
  // media_type not an image type
  let res = await callRoute(route.handler, { url: '/api/dsh-magpie-image/image?attachment_id=sha256:abc&media_type=text/plain&bytes=1&width=4&height=5' });
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('image route serves the stored bytes with the ref media type', async () => {
  const { makeRoutes } = await import('../src/routes.js');
  const stored = { ref: { mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3, 4]) };
  const [route] = makeRoutes({
    attachments: { readImage: async (ref) => { assert.equal(ref.attachmentId, 'sha256:abc'); return stored; } },
    connection: () => ({ requestRejection: () => undefined }),
  });
  const res = await callRoute(route.handler, { url: '/api/dsh-magpie-image/image?attachment_id=sha256:abc&media_type=image/png&bytes=4&width=4&height=5' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['content-length'], 4);
  assert.deepEqual([...res.body], [1, 2, 3, 4]);
});

test('image route reports a missing attachment as 404', async () => {
  const { makeRoutes } = await import('../src/routes.js');
  const [route] = makeRoutes({
    attachments: { readImage: async () => { throw new Error('nope'); } },
    connection: () => ({ requestRejection: () => undefined }),
  });
  const res = await callRoute(route.handler, { url: '/api/dsh-magpie-image/image?attachment_id=sha256:abc&media_type=image/png&bytes=4&width=4&height=5' });
  assert.equal(res.status, 404);
});

test('client view keys match the host tool names exactly', async () => {
  // A client registered under a key that is not the real tool name renders
  // nothing, and the tool stays a JSON row: the exact drift this guards.
  const { readFile } = await import('node:fs/promises');
  const { publicToolName } = await import('../src/tools.js');
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const keys = [...source.matchAll(/"(mcp__magpie__[a-z_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(keys)].sort(),
    [publicToolName('generate_image'), publicToolName('generation_result')].sort(),
  );
});

// ---- internal polling ------------------------------------------------------

/**
 * A fake magpie that answers `generate_image` with a pending sentence, then
 * hands back an image from `generation_result` after N polls.
 *
 * @param polls - how many `generation_result` calls succeed before the image.
 * @returns the client plus a record of every call it received.
 */
function makePollingMagpie(polls) {
  const calls = [];
  let seen = 0;
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'generate_image') {
        return {
          content: [{
            type: 'text',
            text: 'The image is still being made (20 s so far; it can take a few minutes). '
              + 'Don\'t ask for it again: call generation_result with id "img_task1" to wait for it and get it.',
          }],
        };
      }
      seen += 1;
      if (seen < polls) {
        return {
          content: [{ type: 'text', text: 'Still being made. Call generation_result with id "img_task1" again.' }],
        };
      }
      return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
    },
  };
}

const stubCtx = () => ({
  attachments: {
    readImage: async () => ({ data: PNG_BYTES, ref: { mediaType: 'image/png' } }),
    saveImages: async (images) => images.map((_, index) => ({
      attachmentId: `sha256:img${index}`, mediaType: 'image/png', bytes: 8, width: 2, height: 2,
    })),
  },
});

test('generate_image polls generation_result internally and returns the image', async () => {
  // The failure this pins: the two-step protocol was handed to the model, which
  // then had to remember a task_id and pick a second tool by name. In one
  // session it never once called the second tool and looped instead (2026-11-14,
  // measured: 0 magpie calls, 2 openviking calls). Polling belongs here.
  const magpie = makePollingMagpie(3);
  const [generate] = createToolDefinitions(stubCtx(), magpie, { sleep: async () => {} });
  const result = await generate.execute({ prompt: 'a car headlight' }, { signal: undefined });

  assert.equal(result.status, 'completed');
  assert.equal(result.images.length, 1);
  const polls = magpie.calls.filter((call) => call.name === 'generation_result');
  assert.equal(polls.length, 3, 'it must poll until the image arrives');
  assert.equal(polls[0].args.id, 'img_task1', 'the id comes from the pending sentence');
});

test('generate_image stops polling and reports the id when the budget runs out', async () => {
  // The id is the fallback: without it a timed-out generation is unreproducible
  // and the image already paid for cannot be collected.
  const magpie = makePollingMagpie(Number.POSITIVE_INFINITY);
  const [generate] = createToolDefinitions(stubCtx(), magpie, { sleep: async () => {}, budgetMs: 60, intervalMs: 1 });
  const result = await generate.execute({ prompt: 'x' }, { signal: undefined });

  assert.equal(result.status, 'pending');
  assert.equal(result.task_id, 'img_task1');
  assert.ok(magpie.calls.length > 1, 'it must have tried polling at least once');
  // The budget is time-based, so the exact poll count depends on the host; what
  // must hold is that it stops. An unbounded loop here would hang the tool.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const settled = magpie.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(magpie.calls.length, settled, 'polling must have stopped at the deadline');
});

test('a finished image is not polled for', async () => {
  const calls = [];
  const magpie = {
    async callTool(name) {
      calls.push(name);
      return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
    },
  };
  const [generate] = createToolDefinitions(stubCtx(), magpie, { sleep: async () => {} });
  const result = await generate.execute({ prompt: 'x' }, { signal: undefined });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['generate_image']);
});
