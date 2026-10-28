import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BrowserSearchProvider } from '../src/provider.js';

/**
 * A provider wired to fakes so the fallback ladder can be driven without a
 * browser or the network. The seams are injected exactly as `index.js` injects
 * the real ones.
 */
function makeProvider(overrides = {}) {
  const calls = [];
  const provider = new BrowserSearchProvider({
    config: () => ({
      cdpEndpoint: 'http://127.0.0.1:9222',
      googleEnabled: true,
      googleTimeoutMs: 15_000,
      bingEnabled: true,
      bingTimeoutMs: 15_000,
      ...overrides.config,
    }),
    searchGoogle: overrides.searchGoogle ?? (async (query) => {
      calls.push(['google', query]);
      return [{ title: 'g', url: 'https://g.example/1', displayUrl: 'g.example', snippet: 's' }];
    }),
    searchBing: overrides.searchBing ?? (async (query) => {
      calls.push(['bing', query]);
      return [{ title: 'b', url: 'https://b.example/1', displayUrl: 'b.example', snippet: 's' }];
    }),
  });
  return { provider, calls };
}

test('search returns the Google results when Google answers', async () => {
  const { provider, calls } = makeProvider();

  const result = await provider.search({ query: 'hello', maxResults: 5 });

  assert.deepEqual(result.sources, [
    { url: 'https://g.example/1', title: 'g', snippet: 's' },
  ]);
  assert.equal(result.truncated, false);
  // Bing must not run once Google produced results; the fallback exists for
  // failures, not for topping up a short list.
  assert.deepEqual(calls, [['google', 'hello']]);
});

test('search falls back to Bing when Google fails', async () => {
  const { provider, calls } = makeProvider({
    searchGoogle: async () => { throw new Error('CDP endpoint refused the connection'); },
  });

  const result = await provider.search({ query: 'hello', maxResults: 5 });

  assert.deepEqual(result.sources, [{ url: 'https://b.example/1', title: 'b', snippet: 's' }]);
  assert.deepEqual(calls, [['bing', 'hello']]);
});

test('search falls back to Bing when Google returns nothing', async () => {
  const { provider, calls } = makeProvider({ searchGoogle: async () => [] });

  const result = await provider.search({ query: 'hello', maxResults: 5 });

  assert.deepEqual(result.sources, [{ url: 'https://b.example/1', title: 'b', snippet: 's' }]);
  assert.deepEqual(calls, [['bing', 'hello']]);
});

test('search reports both failures when neither path works', async () => {
  const { provider } = makeProvider({
    searchGoogle: async () => { throw new Error('no Chrome'); },
    searchBing: async () => { throw new Error('no network'); },
  });

  await assert.rejects(
    () => provider.search({ query: 'hello', maxResults: 5 }),
    (error) => {
      // Both causes must survive into the message: the model sees one string, and
      // "Google failed" alone would hide that Bing never even ran.
      assert.match(error.message, /no Chrome/);
      assert.match(error.message, /no network/);
      assert.equal(error.code, 'WEB_PROVIDER_ERROR');
      return true;
    },
  );
});

test('search skips a disabled engine', async () => {
  const { provider, calls } = makeProvider({ config: { googleEnabled: false } });

  const result = await provider.search({ query: 'hello', maxResults: 5 });

  assert.deepEqual(calls, [['bing', 'hello']]);
  assert.equal(result.sources.length, 1);
});

test('search reports unavailable when every engine is disabled', async () => {
  const { provider } = makeProvider({ config: { googleEnabled: false, bingEnabled: false } });

  assert.equal(provider.available(), false);
  await assert.rejects(
    () => provider.search({ query: 'hello', maxResults: 5 }),
    (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_UNAVAILABLE');
      return true;
    },
  );
});

test('search passes every result through, leaving maxResults to the seam', async () => {
  const many = Array.from({ length: 6 }, (_unused, index) => ({
    title: `t${index}`,
    url: `https://example.com/${index}`,
    displayUrl: 'example.com',
    snippet: '',
  }));
  const { provider } = makeProvider({ searchGoogle: async () => many });

  const result = await provider.search({ query: 'hello', maxResults: 4 });

  // `WebRuntime.search` wraps this result in `capSources`, which truncates and
  // sets `truncated`. Capping here too would put the decision in two places.
  assert.equal(result.sources.length, 6);
  assert.equal(result.truncated, false);
});

test('search drops duplicate URLs from one page', async () => {
  const { provider } = makeProvider({
    searchGoogle: async () => [
      { title: 'first', url: 'https://same.example/', displayUrl: '', snippet: 'a' },
      { title: 'again', url: 'https://same.example/', displayUrl: '', snippet: 'b' },
      { title: 'other', url: 'https://other.example/', displayUrl: '', snippet: 'c' },
    ],
  });

  const result = await provider.search({ query: 'hello', maxResults: 5 });

  assert.deepEqual(
    result.sources.map((source) => source.title),
    ['first', 'other'],
  );
});

test('search drops results without a resolvable URL', async () => {
  const { provider } = makeProvider({
    searchGoogle: async () => [
      { title: 'ok', url: 'https://ok.example/', displayUrl: '', snippet: '' },
      { title: 'bad', url: 'javascript:void(0)', displayUrl: '', snippet: '' },
    ],
  });

  const result = await provider.search({ query: 'hello', maxResults: 5 });

  assert.deepEqual(result.sources.map((source) => source.url), ['https://ok.example/']);
});
