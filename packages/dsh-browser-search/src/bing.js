/**
 * Bing SERP parsing for the plain-HTTP fallback.
 *
 * This is the path taken when Chrome is not reachable or Google refuses the
 * request. It runs on a static document, so unlike the Google extractor it is
 * never shipped into a page — it parses the response with jsdom in Node.
 *
 * Bing's organic results are the `li.b_algo` items, which is a stable structural
 * marker (unlike Google's obfuscated class names) and the same markup a browser
 * receives. The RSS form of this endpoint is deliberately NOT used: its response
 * carries an explicit licence restricting the XML to "rendering Bing results
 * within an RSS aggregator for your personal, non-commercial use".
 *
 * @module @logictan/dsh-browser-search/bing
 */

/**
 * Unwrap one Bing result link.
 *
 * Bing routes clicks through `/ck/a?…&u=a1<base64url>`, where the `a1` prefix is
 * a version marker and the remainder is the destination URL encoded with the
 * URL-safe base64 alphabet and no padding. Anything that is not such a redirect
 * is returned unchanged.
 *
 * @param href - the raw `href` from the page.
 * @returns the destination URL.
 */
export function decodeBingUrl(href) {
  let url;
  try {
    url = new URL(href, 'https://www.bing.com');
  } catch {
    return href;
  }
  if (!url.pathname.startsWith('/ck/')) return href;

  const payload = url.searchParams.get('u');
  if (payload === null || !payload.startsWith('a1')) return href;

  const base64 = payload.slice(2).replaceAll('-', '+').replaceAll('_', '/');
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  // A malformed payload decodes to replacement characters; the redirector is a
  // worse answer than nothing only when the payload was never a URL at all.
  return URL.canParse(decoded) ? decoded : href;
}

/**
 * Parse the organic results out of a Bing result page.
 *
 * @param document - the parsed result page.
 * @returns the results in page order; empty when the page holds none.
 */
export function parseBingSerp(document) {
  const normalize = (text) => (text ?? '').replace(/\s+/gu, ' ').trim();

  const results = [];
  for (const item of document.querySelectorAll('li.b_algo')) {
    const heading = item.querySelector('h2 a');
    if (heading === null) continue;

    const title = normalize(heading.querySelector('h2')?.textContent ?? heading.textContent);
    if (title.length === 0) continue;

    const url = decodeBingUrl(heading.getAttribute('href') ?? '');
    if (!URL.canParse(url)) continue;

    results.push({
      title,
      url,
      displayUrl: normalize(item.querySelector('cite')?.textContent),
      snippet: normalize(item.querySelector('.b_caption p, p')?.textContent),
    });
  }
  return results;
}
