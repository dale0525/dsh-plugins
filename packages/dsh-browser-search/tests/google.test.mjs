import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import { extractResults, isBlockedPage } from '../src/google.js';

const here = dirname(fileURLToPath(import.meta.url));
const serp = await readFile(join(here, 'fixtures/google-serp.html'), 'utf8');

/**
 * Wrap the captured `<div id="rso">` subtree in a document, since the fixture
 * is a fragment and the extractor walks from the result headings upward.
 *
 * @param {string} html - fragment to wrap.
 * @returns {Document} a document whose body holds the fragment.
 */
function doc(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

test('extractResults reads every organic result of the captured SERP', () => {
  const results = extractResults(doc(serp));

  // The fixture holds nine result headings; a tenth heading-free entry would be
  // an ad or a "people also ask" panel and must not be reported as a source.
  assert.equal(results.length, 9);

  const [first] = results;
  assert.equal(first.title, 'dsh-plugin · GitHub Topics');
  // Google wraps every link in `/goto?url=<opaque token>`; the token is not
  // decodable, so the extractor reports the redirector and the resolver turns it
  // into a real URL later.
  assert.match(first.url, /^https:\/\/www\.google\.com\/goto\?url=/);
  assert.equal(first.displayUrl, 'https://github.com › topics › dsh-plugin');
  assert.match(first.snippet, /^DeepSeek Harness \(DSH\) is an agentic, plugin-based/);
});

test('extractResults never reports the display URL or the translate link as a snippet', () => {
  for (const result of extractResults(doc(serp))) {
    assert.doesNotMatch(result.snippet, /^https?:\/\//);
    assert.doesNotMatch(result.snippet, /翻译此页/);
    assert.ok(result.title.length > 0, 'every result has a title');
    assert.ok(result.url.length > 0, 'every result has a url');
  }
});

test('extractResults returns an empty list for a page with no result headings', () => {
  assert.deepEqual(extractResults(doc('<div id="rso"><p>nothing here</p></div>')), []);
});

test('isBlockedPage recognises the consent and captcha interstitials', () => {
  assert.equal(isBlockedPage(doc('<form id="captcha-form">unusual traffic</form>')), true);
  assert.equal(isBlockedPage(doc('<div>Before you continue to Google</div>')), true);
  assert.equal(isBlockedPage(doc('<div id="rso"><a href="/x"><h3>t</h3></a></div>')), false);
});

test('isBlockedPage recognises the "Verifying your request" soft rate limit', () => {
  // Google answers a rapid repeat query with a 149-character interstitial instead
  // of results. Missing it costs the whole timeout, because the page has no `a h3`
  // to find and no captcha form to notice.
  const interstitial = doc(
    '<div>Skip to main content Accessibility help Sign in Verifying your request ' +
      "You'll be able to continue in a few seconds. Don't refresh this page. Continue</div>",
  );
  assert.equal(isBlockedPage(interstitial), true);
});
