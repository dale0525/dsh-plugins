/**
 * Tests for removing a screen from a Stitch canvas.
 *
 * Stitch has no screen-delete route: `DELETE /projects/<p>/screens/<s>` answers
 * 404 for every spelling (`:delete` included), and the CLI rejects it outright
 * with `UNSUPPORTED_RESOURCE / "Stitch screens do not support delete."`.
 * Measured 2026-11-08 against project 4697019860827468919.
 *
 * What does work is a project-level PATCH of `screenInstances`: the canvas is a
 * list of instances, each pointing at a `sourceScreen`, and writing back the
 * list minus one instance removes that screen from the canvas. The screen object
 * survives at `GET .../screens/<id>`; removing it from the canvas is what makes
 * the project readable again, which is the whole complaint this tool answers.
 *
 * Two facts the tests pin, both measured:
 *
 *  - The instance id is NOT always the screen id. Generated screens reuse their
 *    id, but uploaded images get a fresh instance id (a UUID) whose
 *    `sourceScreen` ends in the screen id. Matching therefore has to go through
 *    `sourceScreen`, not `id`.
 *  - The list is written whole. `updateMask=screenInstances` replaces the field,
 *    so every remaining instance is sent back verbatim — a dropped field would
 *    be a silently lost canvas position.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CANVAS_API_URL, createCanvasClient } from '../src/canvas.js';

/**
 * Run `body` with `fetch` replaced by a recorder.
 *
 * @param reply - the response the stub returns, or a function of the call index.
 * @param body - receives the recorded calls.
 * @returns the recorded calls.
 */
async function withFetch(reply, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const response = typeof reply === 'function' ? reply(calls.length) : reply;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json,
      text: async () => response.text ?? '',
    };
  };
  try {
    await body(calls);
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

/** A project whose uploaded screen uses a UUID instance id, the awkward case. */
const PROJECT = {
  name: 'projects/p1',
  title: 'Redesign',
  screenInstances: [
    { id: 'generated-1', sourceScreen: 'projects/p1/screens/generated-1', x: 0, width: 1280, height: 1024 },
    { id: 'uuid-2', sourceScreen: 'projects/p1/screens/uploaded-2', x: 1920, width: 1280, height: 1024, label: 'image.png' },
  ],
};

test('the instance is matched by sourceScreen, not by its id', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test', url: CANVAS_API_URL });
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: { ...PROJECT, screenInstances: [PROJECT.screenInstances[0]] } }),
    async () => {
      await client.removeScreen('p1', 'uploaded-2');
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, `${CANVAS_API_URL}/projects/p1`);
  assert.equal(calls[1].init.method, 'PATCH');
  assert.equal(calls[1].url, `${CANVAS_API_URL}/projects/p1?updateMask=screenInstances`);
  assert.deepEqual(calls[1].body.screenInstances, [PROJECT.screenInstances[0]]);
});

test('the remaining instances are written back verbatim', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: PROJECT }),
    async () => {
      await client.removeScreen('p1', 'uploaded-2');
    },
  );

  const written = calls[1].body.screenInstances;
  assert.equal(written.length, 1);
  // Every field of the survivor, including its canvas position, must survive.
  assert.deepEqual(written[0], PROJECT.screenInstances[0]);
});

test('a screen already off the canvas is reported instead of patched', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch({ json: PROJECT }, async () => {
    await assert.rejects(() => client.removeScreen('p1', 'not-on-canvas'), /not on the canvas/);
  });
  assert.equal(calls.length, 1, 'only the GET should have been sent');
});

test('the API key travels on both requests', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: PROJECT }),
    async () => {
      await client.removeScreen('p1', 'uploaded-2');
    },
  );
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'AQ.test');
  assert.equal(calls[1].init.headers['X-Goog-Api-Key'], 'AQ.test');
});

test('an unconfigured key fails before any request is sent', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => '' });
  const calls = await withFetch({ json: PROJECT }, async () => {
    await assert.rejects(() => client.removeScreen('p1', 'uploaded-2'), /Stitch API key is not configured/);
  });
  assert.equal(calls.length, 0);
});

test('a failed PATCH surfaces the status instead of reporting success', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { ok: false, status: 403, text: 'PERMISSION_DENIED' }),
    async () => {
      await assert.rejects(() => client.removeScreen('p1', 'uploaded-2'), /HTTP 403 PERMISSION_DENIED/);
    },
  );
});