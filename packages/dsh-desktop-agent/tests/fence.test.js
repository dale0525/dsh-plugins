/**
 * Tests for the vision-catalog route's trust fence.
 *
 * The route family answers under `/api/dsh-desktop-agent`, which the host
 * matches before Connection's `/api` prefix route — so the plugin has to ask
 * the composition's fence itself. These tests pin that delegation: the route
 * must report the verdict the fence gives it, and must refuse rather than
 * serve when the fence is absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRoutes } from '../src/routes.js';

/** A response stub recording the status and JSON body. */
function recordingResponse() {
  const res = {
    status: 0,
    body: '',
    writeHead(status) { res.status = status; },
    end(chunk) { if (chunk !== undefined) res.body += chunk; },
  };
  return res;
}

const llm = {
  listProviders: () => [{ id: 'p', name: 'P' }],
  listModels: async () => [{ id: 'seer', name: 'Seer' }],
  resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
};

/** Invoke the single route with a fence verdict. */
async function call(connection) {
  const [route] = makeRoutes({ llm, connection });
  const res = recordingResponse();
  await route.handler({ method: 'GET', headers: {} }, res);
  return { status: res.status, body: res.body === '' ? undefined : JSON.parse(res.body) };
}

test('a request the fence admits is served', async () => {
  const seen = [];
  const { status, body } = await call(() => ({
    requestRejection: (request) => { seen.push(request); return undefined; },
  }));
  assert.equal(status, 200);
  assert.deepEqual(body.groups, [{ id: 'p', name: 'P', models: [{ id: 'seer', name: 'Seer' }] }]);
  assert.equal(seen.length, 1, 'the fence was asked');
});

test('the fence 401 is reported as unauthorized', async () => {
  const { status, body } = await call(() => ({ requestRejection: () => 401 }));
  assert.equal(status, 401);
  assert.deepEqual(body, { error: 'unauthorized' });
});

test('the fence 403 is reported as forbidden', async () => {
  const { status, body } = await call(() => ({ requestRejection: () => 403 }));
  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'forbidden' });
});

test('a missing fence refuses instead of serving unfenced', async () => {
  const { status, body } = await call(() => undefined);
  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'forbidden' });
});
