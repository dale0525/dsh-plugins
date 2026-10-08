/**
 * Tests for the stateless Stitch transport.
 *
 * The load-bearing claim is that Stitch's MCP endpoint needs no handshake: no
 * `initialize`, no session id, no SSE. Measured on 2026-10-08, a bare
 * `tools/list` and a bare `tools/call` both answer HTTP 200 with
 * `application/json`. That is why this client is a single POST per call and
 * why the first request on a fresh process is the call itself — a handshake
 * would be state to keep, resume and invalidate.
 *
 * The key is resolved through a callback per call rather than captured, so the
 * second half of this file pins that a key set or revoked mid-process takes
 * effect on the very next call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TOOL_CALL_TIMEOUT_MS, MCP_URL, createStitchClient } from '../src/stitch.js';

/**
 * Run `body` with `fetch` replaced by a recorder.
 *
 * @param reply - the response the stub returns, or a function of the request.
 * @param body - receives the recorded calls.
 * @returns the recorded calls.
 */
async function withFetch(reply, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
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

test('the first call is the call itself: no initialize, no session id', async () => {
  const client = createStitchClient({ resolveApiKey: async () => 'AQ.test' });
  const calls = await withFetch(
    { json: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } } },
    async () => {
      await client.callTool('list_projects', {});
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MCP_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].body.method, 'tools/call');
  assert.deepEqual(calls[0].body.params, { name: 'list_projects', arguments: {} });
  assert.equal(calls[0].body.jsonrpc, '2.0');
  // No session id is sent, because Stitch issues none.
  assert.equal(calls[0].init.headers['Mcp-Session-Id'], undefined);
});

test('the API key is sent per request and re-resolved on every call', async () => {
  let key = 'AQ.first';
  const client = createStitchClient({ resolveApiKey: async () => key });
  const calls = await withFetch(
    { json: { jsonrpc: '2.0', id: 1, result: { content: [] } } },
    async () => {
      await client.callTool('list_projects', {});
      key = 'AQ.second';
      await client.callTool('list_projects', {});
    },
  );

  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'AQ.first');
  assert.equal(calls[1].init.headers['X-Goog-Api-Key'], 'AQ.second');
});

test('an unconfigured key fails before any request is sent', async () => {
  const client = createStitchClient({ resolveApiKey: async () => '' });
  const calls = await withFetch({ json: {} }, async () => {
    await assert.rejects(() => client.callTool('list_projects', {}), /Stitch API key is not configured/);
  });
  assert.equal(calls.length, 0);
});

test('a JSON-RPC error envelope becomes a thrown Error', async () => {
  const client = createStitchClient({ resolveApiKey: async () => 'AQ.test' });
  await withFetch({ json: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } } }, async () => {
    await assert.rejects(() => client.callTool('get_project', {}), /Invalid params/);
  });
});

test('an HTTP failure names the status and keeps the body excerpt', async () => {
  const client = createStitchClient({ resolveApiKey: async () => 'AQ.test' });
  await withFetch({ ok: false, status: 403, text: 'PERMISSION_DENIED' }, async () => {
    await assert.rejects(() => client.callTool('list_projects', {}), /HTTP 403 PERMISSION_DENIED/);
  });
});

test('listTools returns the descriptors and tolerates a missing list', async () => {
  const client = createStitchClient({ resolveApiKey: async () => 'AQ.test' });

  await withFetch({ json: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'create_project' }] } } }, async () => {
    assert.deepEqual(await client.listTools(), [{ name: 'create_project' }]);
  });

  await withFetch({ json: { jsonrpc: '2.0', id: 1, result: {} } }, async () => {
    assert.deepEqual(await client.listTools(), []);
  });
});

test('the default budget covers a long-running generation', () => {
  assert.equal(DEFAULT_TOOL_CALL_TIMEOUT_MS, 180_000);
});
