/**
 * Google SERP extraction, run inside the page.
 *
 * The extractor is ONE self-contained function so the exact code that the tests
 * exercise is the code that ships into the browser: {@link EXTRACT_SOURCE} is
 * this function's source text, evaluated in the page by `cdp.js`. Splitting the
 * helpers out would mean the tested version and the shipped version could drift.
 *
 * It deliberately keys on SEMANTIC anchors only — a result is an `a` containing
 * an `h3`, its display URL is the nearest `cite`, and its snippet is the nearest
 * sibling block long enough to be prose. Google's class names are obfuscated and
 * change between layouts (`tF2Cxc IsZvec` on one capture, `N54PNb BToiNc` on the
 * next), so matching them would break on every redesign.
 *
 * @module @logictan/dsh-browser-search/google
 */

/**
 * Extract the organic results from the page's document.
 *
 * Links are reported as Google's own redirector (`/goto?url=<opaque token>`)
 * because the token is not decodable locally; `google.js` resolves each to its
 * real destination with a cookie-less request afterwards.
 *
 * @param document - the SERP document.
 * @returns the results in page order; empty when the page holds none.
 */
export function extractResults(document) {
  const normalize = (text) => (text ?? '').replace(/\s+/gu, ' ').trim();

  /** The nearest prose sibling block, used as the result's snippet. */
  function snippetFor(anchor) {
    let node = anchor;
    for (let depth = 0; depth < 10 && node.parentElement !== null; depth += 1) {
      const parent = node.parentElement;
      for (const sibling of parent.children) {
        if (sibling === node) continue;
        if (sibling.closest('script,style,noscript') !== null) continue;
        // The heading row also carries the display URL and the "translate this
        // page" link; neither is prose, so a row containing a cite is skipped.
        if (sibling.querySelector('cite') !== null) continue;
        const text = normalize(sibling.textContent);
        if (text.length >= 40) return text;
      }
      node = parent;
    }
    return '';
  }

  const results = [];
  for (const anchor of document.querySelectorAll('a')) {
    const heading = anchor.querySelector('h3');
    if (heading === null) continue;
    const title = normalize(heading.textContent);
    if (title.length === 0) continue;

    let url = anchor.getAttribute('href') ?? '';
    if (url.startsWith('/')) url = `https://www.google.com${url}`;
    if (!url.startsWith('https://') && !url.startsWith('http://')) continue;

    // The cite lives inside the heading anchor on some layouts and beside it on
    // others, so it is looked up from the anchor first and the row second.
    let row = anchor;
    while (row.parentElement !== null && row.querySelector('cite') === null) row = row.parentElement;
    const cite = anchor.querySelector('cite') ?? row.querySelector('cite');

    results.push({
      title,
      url,
      displayUrl: normalize(cite?.textContent),
      snippet: snippetFor(anchor),
    });
  }
  return results;
}

/**
 * Whether the page is a consent wall or a bot check instead of results.
 *
 * Reported as a provider error rather than retried: both interstitials are
 * decisions made by Google about this browser, and re-requesting the same URL
 * only deepens them.
 *
 * @param document - the loaded document.
 * @returns true when the page is not a result list.
 */
export function isBlockedPage(document) {
  const text = document.body?.textContent ?? '';
  if (document.querySelector('#captcha-form') !== null) return true;
  return /unusual traffic|not a robot|Before you continue to Google|Verifying your request/iu.test(text);
}

/** The extractor's source text, evaluated verbatim in the page. */
export const EXTRACT_SOURCE = extractResults.toString();

/** The block check's source text, evaluated verbatim in the page. */
export const BLOCKED_SOURCE = isBlockedPage.toString();
