/**
 * Tests for removing screens from a Stitch canvas.
 *
 * Stitch has no screen-delete route: `DELETE /projects/<p>/screens/<s>` answers
 * 404 for every spelling (`:delete` included), and the CLI rejects it outright
 * with `UNSUPPORTED_RESOURCE / "Stitch screens do not support delete."`.
 * Measured 2026-11-08 against project 4697019860827468919.
 *
 * What does work is a project-level PATCH of `screenInstances`: the canvas is a
 * list of instances, each pointing at a `sourceScreen`, and writing back the
 * list minus the unwanted instances removes those screens from the canvas. The
 * screen objects survive at `GET .../screens/<id>`; removing them from the
 * canvas is what makes the project readable again, which is the whole complaint
 * this tool answers.
 *
 * Batch is the primitive, not a loop over the single case: the canvas is one
 * field, so N removals are still ONE PATCH. Looping would issue N read-modify-
 * write cycles and lose a removal whenever two of them race — and it is the
 * batch shape the model actually wants when clearing out a project.
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
    { id: 'generated-3', sourceScreen: 'projects/p1/screens/generated-3', x: 3264, width: 1280, height: 1024 },
  ],
};

test('the instance is matched by sourceScreen, not by its id', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test', url: CANVAS_API_URL });
  // Removing the middle instance leaves instances 1 and 3 — not a prefix.
  const survivors = [PROJECT.screenInstances[0], PROJECT.screenInstances[2]];
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: { ...PROJECT, screenInstances: survivors } }),
    async () => {
      await client.removeScreens('p1', ['uploaded-2']);
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, `${CANVAS_API_URL}/projects/p1`);
  assert.equal(calls[1].init.method, 'PATCH');
  assert.equal(calls[1].url, `${CANVAS_API_URL}/projects/p1?updateMask=screenInstances`);
  // The survivor list is what matters; the return value also carries the
  // removed/missing bookkeeping, which is asserted in its own test.
  assert.deepEqual(calls[1].body.screenInstances, survivors);
});

test('several screens are removed with ONE patch, not one patch each', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: { ...PROJECT, screenInstances: [PROJECT.screenInstances[1]] } }),
    async () => {
      await client.removeScreens('p1', ['generated-1', 'generated-3']);
    },
  );

  // Exactly one GET and one PATCH, regardless of how many ids were asked for.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.screenInstances, [PROJECT.screenInstances[1]]);
});

test('one id is just the batch case: same single patch', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: { ...PROJECT, screenInstances: PROJECT.screenInstances.slice(1) } }),
    async () => {
      await client.removeScreens('p1', ['generated-1']);
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(
    calls[1].body.screenInstances.map((i) => i.id),
    ['uuid-2', 'generated-3'],
  );
});

test('the remaining instances are written back verbatim', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: PROJECT }),
    async () => {
      await client.removeScreens('p1', ['uploaded-2']);
    },
  );

  const written = calls[1].body.screenInstances;
  assert.equal(written.length, 2);
  // Every field of each survivor, including its canvas position, must survive.
  assert.deepEqual(written[0], PROJECT.screenInstances[0]);
  assert.deepEqual(written[1], PROJECT.screenInstances[2]);
});

test('ids that are not on the canvas are reported, and the rest still go through', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: { ...PROJECT, screenInstances: PROJECT.screenInstances.slice(1) } }),
    async () => {
      const result = await client.removeScreens('p1', ['generated-1', 'not-on-canvas']);
      assert.deepEqual(result.missing, ['not-on-canvas']);
      assert.deepEqual(result.removed, ['generated-1']);
    },
  );

  // The real removal still happened; a partly-wrong list must not silently no-op.
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].body.screenInstances.map((i) => i.id),
    ['uuid-2', 'generated-3'],
  );
});

test('nothing on the canvas means no patch is sent at all', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch({ json: PROJECT }, async () => {
    await assert.rejects(() => client.removeScreens('p1', ['nope-1', 'nope-2']), /on the canvas/);
  });
  assert.equal(calls.length, 1, 'only the GET should have been sent');
});

test('an empty id list is rejected before any request', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch({ json: PROJECT }, async () => {
    await assert.rejects(() => client.removeScreens('p1', []), /at least one screen id/);
  });
  assert.equal(calls.length, 0);
});

test('the API key travels on both requests', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { json: PROJECT }),
    async () => {
      await client.removeScreens('p1', ['uploaded-2']);
    },
  );
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'AQ.test');
  assert.equal(calls[1].init.headers['X-Goog-Api-Key'], 'AQ.test');
});

test('an unconfigured key fails before any request is sent', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => '' });
  const calls = await withFetch({ json: PROJECT }, async () => {
    await assert.rejects(() => client.removeScreens('p1', ['uploaded-2']), /Stitch API key is not configured/);
  });
  assert.equal(calls.length, 0);
});

test('a failed PATCH surfaces the status instead of reporting success', async () => {
  const client = createCanvasClient({ resolveApiKey: async () => 'AQ.test' });
  await withFetch(
    (n) => (n === 1 ? { json: PROJECT } : { ok: false, status: 403, text: 'PERMISSION_DENIED' }),
    async () => {
      await assert.rejects(() => client.removeScreens('p1', ['uploaded-2']), /HTTP 403 PERMISSION_DENIED/);
    },
  );
});