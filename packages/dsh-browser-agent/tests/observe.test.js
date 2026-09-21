/**
 * Tests for the observation retry seam.
 *
 * A click may navigate, and the loop re-observes immediately afterwards. That
 * observation can land while the old document is gone and the new one is not
 * ready — Playwright reports it as "Execution context was destroyed". Treating
 * that as fatal would end the run the moment the agent clicked its first link,
 * which is the single most common browser action.
 *
 * The seam is tested without a browser: `observe` takes a page-shaped object,
 * so a fake page can produce the exact rejection sequence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { observe } from '../src/loop.js';

/** A page whose `evaluate` follows a scripted sequence of outcomes. */
function fakePage(outcomes) {
  const seen = [];
  return {
    seen,
    async evaluate() {
      seen.push(seen.length + 1);
      const outcome = outcomes[seen.length - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async waitForTimeout() {},
  };
}

const destroyed = () => new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
const SNAPSHOT = { url: 'https://example.com', actions: [] };

test('returns the first observation when it succeeds', async () => {
  const page = fakePage([SNAPSHOT]);
  assert.equal(await observe(page), SNAPSHOT);
  assert.equal(page.seen.length, 1);
});

test('retries a destroyed context and returns the document that replaced it', async () => {
  const page = fakePage([destroyed(), SNAPSHOT]);
  assert.equal(await observe(page), SNAPSHOT);
  assert.equal(page.seen.length, 2);
});

test('retries more than once while a navigation is still in flight', async () => {
  const page = fakePage([destroyed(), destroyed(), destroyed(), SNAPSHOT]);
  assert.equal(await observe(page), SNAPSHOT);
  assert.equal(page.seen.length, 4);
});

test('propagates a rejection that is not a navigation', async () => {
  const fault = new Error('Target page, context or browser has been closed');
  const page = fakePage([fault]);
  await assert.rejects(() => observe(page), /has been closed/);
  assert.equal(page.seen.length, 1, 'a real fault must not be retried');
});

test('gives up when the context never comes back', async () => {
  const page = fakePage(Array.from({ length: 10 }, destroyed));
  await assert.rejects(() => observe(page), /Execution context was destroyed/);
  assert.equal(page.seen.length, 5, 'the attempt cap bounds the retries');
});
