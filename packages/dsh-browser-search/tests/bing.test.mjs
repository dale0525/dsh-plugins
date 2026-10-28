import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decodeBingUrl, parseBingSerp } from '../src/bing.js';

const here = dirname(fileURLToPath(import.meta.url));
const serp = await readFile(join(here, 'fixtures/bing-serp.html'), 'utf8');

test('parseBingSerp reads every organic result of the captured SERP', () => {
  const results = parseBingSerp(serp);

  assert.equal(results.length, 9);

  const [first] = results;
  assert.equal(first.title, 'GitHub - TimeMachineLab/awesome-deepseek-harness-zh: DeepSeek Harness ...');
  // Bing wraps result links in `/ck/a?…&u=a1<base64url>`; the parser decodes
  // them, so a caller never has to follow the redirector.
  assert.equal(first.url, 'https://github.com/TimeMachineLab/awesome-deepseek-harness-zh');
  assert.equal(first.displayUrl, 'https://github.com › TimeMachineLab › awesome-deepseek-harness-zh');
  assert.match(first.snippet, /^4 days ago · DeepSeek Harness（简称 dsh）是 DeepSeek 开源的 AI Agent/);
});

test('parseBingSerp reports a real destination for every result', () => {
  for (const result of parseBingSerp(serp)) {
    assert.match(result.url, /^https?:\/\//);
    assert.doesNotMatch(result.url, /bing\.com\/ck\//);
  }
});

test('decodeBingUrl unwraps the ck redirector and passes direct links through', () => {
  // `a1` prefixes a base64url payload; padding is stripped by Bing.
  assert.equal(
    decodeBingUrl('https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRo&ntb=1'),
    'https://example.com/path',
  );
  assert.equal(decodeBingUrl('https://example.com/direct'), 'https://example.com/direct');
});

test('parseBingSerp returns an empty list when the page holds no results', () => {
  assert.deepEqual(parseBingSerp('<!DOCTYPE html><html><body><p>nothing</p></body></html>'), []);
});

test('parseBingSerp decodes the entities Bing puts in titles and snippets', () => {
  const html = `
    <li class="b_algo">
      <h2><a href="https://example.com/a">Tom &amp; Jerry&#39;s &quot;guide&quot;</a></h2>
      <cite>https://example.com</cite>
      <p>one &lt; two &amp;&amp; three &gt; zero</p>
    </li>`;

  const [result] = parseBingSerp(html);

  assert.equal(result.title, 'Tom & Jerry\'s "guide"');
  assert.equal(result.snippet, 'one < two && three > zero');
});
