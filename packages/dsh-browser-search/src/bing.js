/**
 * Bing SERP parsing for the plain-HTTP fallback.
 *
 * This is the path taken when Chrome is not reachable or Google refuses the
 * request. It parses the response text directly — no DOM library — for two
 * reasons:
 *
 * 1. A DOM parser would be the plugin's only third-party runtime dependency, and
 *    `jsdom` in particular breaks the host's module resolver: it is CommonJS and
 *    `require`s Node builtins, and the host's CJS hook calls
 *    `createRequire(...).resolve.paths(name)` on every bare name, which returns
 *    `null` for builtins and throws `... is not iterable`. The plugin then fails
 *    to import and its provider is never registered.
 * 2. The markup it needs is three flat, stable landmarks — `li.b_algo`, `h2 a`,
 *    `cite`, `p` — which a scanner reads as well as a DOM for this shape.
 *
 * The RSS form of this endpoint is deliberately NOT used: its response carries an
 * explicit licence restricting the XML to "rendering Bing results within an RSS
 * aggregator for your personal, non-commercial use".
 *
 * @module @logictan/dsh-browser-search/bing
 */

/** Named and numeric character references that actually appear in Bing's text. */
const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['#39', "'"],
  ['#x27', "'"],
]);

/**
 * Decode the character references Bing leaves in titles and snippets.
 *
 * Only the references in {@link ENTITIES} are decoded: an unknown name is left
 * as written, because inventing a replacement would corrupt the snippet while
 * leaving the original text is merely untidy.
 *
 * @param text - raw markup text.
 * @returns the decoded text.
 */
function decodeEntities(text) {
  return text.replaceAll(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, name) => {
    const direct = ENTITIES.get(name.toLowerCase());
    if (direct !== undefined) return direct;
    if (!name.startsWith('#')) return whole;
    const code = name.startsWith('#x') || name.startsWith('#X')
      ? Number.parseInt(name.slice(2), 16)
      : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Strip tags, decode references, and collapse whitespace.
 *
 * Tags are removed WITHOUT leaving a separator: Bing highlights matched terms by
 * wrapping them in `<strong>`, so `awesome-<strong>deepseek</strong>-harness`
 * must read `awesome-deepseek-harness`. Whitespace between tags in the source
 * survives the collapse, which is where the real word breaks come from.
 */
function textOf(html) {
  return decodeEntities((html ?? '').replaceAll(/<[^>]*>/gu, '')).replaceAll(/\s+/gu, ' ').trim();
}

/**
 * Read the value of one attribute out of an opening tag.
 *
 * @param tag - the raw opening tag, e.g. `<a href="…">`.
 * @param attribute - the attribute name.
 * @returns the decoded value, or undefined when absent.
 */
function attributeOf(tag, attribute) {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'iu').exec(tag);
  if (match === null) return undefined;
  return decodeEntities(match[2] ?? match[3] ?? '');
}

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
 * Each organic result is one `li.b_algo` block. Within it the heading anchor
 * carries the title and the (encoded) destination, `cite` carries the display
 * URL, and the first `p` carries the snippet.
 *
 * @param html - the result page's HTML.
 * @returns the results in page order; empty when the page holds none.
 */
export function parseBingSerp(html) {
  const results = [];
  for (const [, block] of (html ?? '').matchAll(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/giu)) {
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/iu.exec(block);
    if (heading === null) continue;

    const anchor = /<a\b([^>]*)>/iu.exec(heading[1]);
    if (anchor === null) continue;

    const title = textOf(heading[1]);
    if (title.length === 0) continue;

    const url = decodeBingUrl(attributeOf(anchor[0], 'href') ?? '');
    if (!URL.canParse(url)) continue;

    const cite = /<cite\b[^>]*>([\s\S]*?)<\/cite>/iu.exec(block);
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/iu.exec(block);

    results.push({
      title,
      url,
      displayUrl: textOf(cite?.[1]),
      snippet: textOf(paragraph?.[1]),
    });
  }
  return results;
}
