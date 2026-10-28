/**
 * The two search engines behind the provider.
 *
 * `searchGoogle` drives the user's Chrome; `searchBing` is a plain HTTP request.
 * Both resolve to the same raw result shape (`title`, `url`, `displayUrl`,
 * `snippet`), so the provider's ladder does not need to know which one answered.
 *
 * @module @logictan/dsh-browser-search/engines
 */
import { JSDOM } from 'jsdom';

import { parseBingSerp } from './bing.js';
import { connect, openHiddenPage, resolveRedirect, USER_AGENT } from './cdp.js';
import { BLOCKED_SOURCE, EXTRACT_SOURCE } from './google.js';

/**
 * Search Google through the user's Chrome.
 *
 * Every result link is Google's own redirector, whose token is not decodable
 * offline. They are resolved concurrently with cookie-less requests — one extra
 * round trip per result, measured at 170–390 ms for a whole page of ten — rather
 * than sequentially, which would dominate the search's latency.
 *
 * @param query - what to search for.
 * @param signal - cancellation signal.
 * @param config - the settings in effect.
 * @returns the raw results.
 * @throws when Chrome is unreachable or Google serves an interstitial.
 */
export async function searchGoogle(query, signal, config) {
  throwIfAborted(signal);
  const connection = await connect(config.cdpEndpoint);
  try {
    const page = await openHiddenPage(connection);
    try {
      await page.goto(googleUrl(query, config), config.googleTimeoutMs);
      // Wait for the results themselves, not for `readyState === "complete"`:
      // Google's result headings are present within ~400 ms of the navigation
      // settling, while `complete` waits on ad and analytics subresources and was
      // measured at 1.5 s longer for the same page.
      //
      // The interstitial is part of the same condition on purpose. A blocked page
      // has no result heading and would otherwise be waited out to the full
      // timeout — measured at 15.4 s before the ladder fell back, versus 0.3 s when
      // the condition also watches for the block.
      await page
        .waitFor(
          'document.querySelector("a h3") !== null || ' +
            `(${BLOCKED_SOURCE})(document) || document.readyState === "complete"`,
          config.googleTimeoutMs,
        )
        .catch(() => {});

      if (await page.evaluate(`(${BLOCKED_SOURCE})(document)`)) {
        throw new Error('Google served a consent wall or a bot check instead of results');
      }

      const results = await page.evaluate(`(${EXTRACT_SOURCE})(document)`);
      if (results.length === 0) return [];

      const resolved = await Promise.all(results.map(async (result) => ({
        ...result,
        url: await resolveResultUrl(result.url, signal),
      })));
      return resolved;
    } finally {
      await page.close();
    }
  } finally {
    connection.close();
  }
}

/**
 * Turn a result's link into a destination the model can open.
 *
 * @param url - the link as found on the page.
 * @param signal - cancellation signal.
 * @returns the destination, or the original link when it does not redirect.
 */
async function resolveResultUrl(url, signal) {
  if (!url.startsWith('https://www.google.com/')) return url;
  try {
    return await resolveRedirect(url, { signal });
  } catch {
    // A single unresolvable link must not fail the search: the remaining results
    // are still useful, and the redirector itself is a working URL.
    return url;
  }
}

/**
 * Build the SERP URL.
 *
 * `num=20` asks for more than the ten a default page shows; `hl` follows the
 * query's script so a Chinese query is not answered in an English interface,
 * which changes both the snippets and the result set.
 *
 * @param query - what to search for.
 * @param config - the settings in effect.
 * @returns the URL to navigate to.
 */
function googleUrl(query, config) {
  const params = new URLSearchParams({
    q: query,
    num: String(config.googleMaxResults),
    hl: /[\u3400-\u9fff]/u.test(query) ? 'zh-CN' : 'en',
  });
  return `https://www.google.com/search?${params.toString()}`;
}

/**
 * Search Bing over plain HTTP, without a browser.
 *
 * @param query - what to search for.
 * @param signal - cancellation signal.
 * @param config - the settings in effect.
 * @returns the raw results.
 * @throws when the request fails or the page holds no results.
 */
export async function searchBing(query, signal, config) {
  throwIfAborted(signal);
  const params = new URLSearchParams({ q: query, count: String(config.bingMaxResults) });
  // `fetch` has no timeout of its own and `signal` is the caller's cancellation,
  // so a stalled connection would otherwise hang until the tool's own 30 s budget
  // ran out — long after the ladder could have reported a real failure.
  const timeout = AbortSignal.timeout(config.bingTimeoutMs);
  const response = await fetch(`https://www.bing.com/search?${params.toString()}`, {
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) throw new Error(`Bing answered HTTP ${response.status}`);

  const html = await response.text();
  const results = parseBingSerp(new JSDOM(html).window.document);
  if (results.length === 0) throw new Error('Bing returned a page with no organic results');
  return results;
}

/**
 * Reject before doing any work when the caller already cancelled.
 *
 * @param signal - cancellation signal.
 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw new Error('search cancelled');
}
