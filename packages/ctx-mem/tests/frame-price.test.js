/**
 * Pins the test-side pricing mirror in `tests/frame-price.js` against the host's
 * own estimator.
 *
 * Every budget assertion in `render.test.js` is only meaningful if the mirrored
 * arithmetic prices content the way the host does. The host's `estimateMessage`
 * is not exported from the package root, so it is reached by absolute path
 * (resolved through the exported `package.json`, which sidesteps the exports
 * map). When that module cannot be resolved the test SKIPS rather than passing
 * silently — a skip is visible, a green tick over an unverified mirror is not.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateMessage as mirror, framePrice as mirrorFrame } from './frame-price.js';
import { frameCheckpointMessage } from '../src/frame.js';

/** Resolve the host estimator module by absolute path, or `undefined`. */
async function loadHostEstimator() {
  let manifest;
  try {
    manifest = import.meta.resolve('@deepseek-ai/dsh-token-meter/package.json');
  } catch {
    return undefined;
  }
  const path = join(dirname(new URL(manifest).pathname), 'lib/types/estimate.js');
  try {
    readFileSync(path);
  } catch {
    return undefined;
  }
  return import(pathToFileURL(path).href);
}

const host = await loadHostEstimator();

test('the pricing mirror matches the host estimator exactly', { skip: host === undefined ? 'host estimator module not resolvable' : false }, () => {
  const bodies = ['', 'x', 'x'.repeat(100), 'x'.repeat(1000), 'x'.repeat(10000)];
  for (const body of bodies) {
    // Price the same frame through BOTH estimators and compare.
    const framed = frameCheckpointMessage(body);
    assert.equal(
      mirror(framed),
      host.estimateMessage(framed),
      `frame with a ${body.length}-char body must price identically`,
    );
    assert.equal(mirrorFrame(body), mirror(framed), 'framePrice must agree with estimateMessage');
  }
})

test('the mirror prices every content-block arm like the host', { skip: host === undefined ? 'host estimator module not resolvable' : false }, () => {
  const messages = [
    { role: 'user', content: [] },
    { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    { role: 'user', content: [{ type: 'reasoning', text: 'thinking hard' }] },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'bash', arguments: '{"command":"ls"}' }] },
    {
      role: 'user',
      content: [{ type: 'tool-result', content: [{ type: 'text', text: 'output here' }] }],
    },
    { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
    { role: 'system', content: [] },
    { role: 'system', content: [{ type: 'text', text: 'you are a helpful assistant' }] },
  ];
  for (const message of messages) {
    assert.equal(
      mirror(message),
      host.estimateMessage(message),
      `message ${JSON.stringify(message).slice(0, 60)} must price identically`,
    );
  }
})
