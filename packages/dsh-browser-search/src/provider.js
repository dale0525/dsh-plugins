/**
 * The `ctx.web` search provider backed by the user's own Chrome.
 *
 * Selection is a ladder rather than a single engine: Google through the browser
 * gives the best results but needs Chrome listening, so a plain-HTTP Bing request
 * takes over when it fails. Both causes are reported together when neither works,
 * because the model sees one error string and "Google failed" alone would hide
 * that the fallback was never reached.
 *
 * @module @logictan/dsh-browser-search/provider
 */
import { WebError } from '@deepseek-ai/dsh-web';

/** Stable id this provider registers under in the search registry. */
export const PROVIDER_ID = 'browser-search';

/**
 * The browser-backed search provider.
 *
 * `available()` is a local check only, as the seam requires: it reports whether
 * at least one engine is switched on, never whether Chrome is reachable. Chrome
 * being down is a per-search failure that the ladder handles, not a reason to
 * make the whole capability look unusable.
 */
export class BrowserSearchProvider {
  id = PROVIDER_ID;
  #config;
  #searchGoogle;
  #searchBing;

  /**
   * @param options - `config` returns the current plain settings; `searchGoogle`
   *   and `searchBing` run one query each and resolve to raw results.
   */
  constructor(options) {
    this.#config = options.config;
    this.#searchGoogle = options.searchGoogle;
    this.#searchBing = options.searchBing;
  }

  /** True when at least one engine is enabled. */
  available() {
    const config = this.#config();
    return config.googleEnabled || config.bingEnabled;
  }

  /**
   * Run one search through the ladder.
   *
   * @param request - the query and result cap.
   * @param signal - cancellation signal.
   * @returns the normalized result.
   * @throws {WebError} when every enabled engine failed.
   */
  async search(request, signal) {
    const config = this.#config();
    const engines = [];
    if (config.googleEnabled) {
      engines.push({ name: 'Google (CDP)', run: () => this.#searchGoogle(request.query, signal, config) });
    }
    if (config.bingEnabled) {
      engines.push({ name: 'Bing (HTTP)', run: () => this.#searchBing(request.query, signal, config) });
    }

    if (engines.length === 0) {
      throw new WebError(
        'browser-search: every search engine is disabled. Enable Google or Bing in Settings → Plugins → browser-search.',
        'WEB_PROVIDER_UNAVAILABLE',
      );
    }

    const failures = [];
    for (const engine of engines) {
      try {
        const raw = await engine.run();
        if (raw.length > 0) return toResult(raw);
        failures.push({ engine: engine.name, error: new Error('returned no results') });
      } catch (error) {
        failures.push({ engine: engine.name, error });
      }
    }

    throw new WebError(describeFailures(failures), 'WEB_PROVIDER_ERROR', {
      cause: failures.at(-1).error,
    });
  }
}

/**
 * Build the model-facing failure message.
 *
 * @param failures - one entry per attempted engine.
 * @returns the message naming every attempt and its cause.
 */
function describeFailures(failures) {
  const lines = failures.map(({ engine, error }) => `  - ${engine}: ${error.message}`);
  const hints = [];
  if (failures.some(({ engine }) => engine.startsWith('Google'))) {
    hints.push(
      'Google needs Chrome running with a debugging port: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.dsh/chrome-agent-profile"',
    );
  }
  return ['browser-search: every search engine failed.', ...lines, ...hints].join('\n');
}

/**
 * Whether a URL is one a search result may cite.
 *
 * `URL.canParse` accepts `javascript:` and `data:` — both are syntactically valid
 * and both appear in real SERP markup (Google's "read more" controls are
 * `javascript:void(0)`). A source the model cannot open is worse than no source.
 *
 * @param url - the candidate.
 * @returns true for an http(s) URL.
 */
function isWebUrl(url) {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === 'https:' || protocol === 'http:';
}

/**
 * Project raw engine results onto the seam's source shape.
 *
 * `maxResults` is deliberately NOT applied here: `WebRuntime.search` already
 * wraps every provider's result in `capSources`, which truncates `sources[]` and
 * sets `truncated` for the whole capability. Capping again would mean two places
 * deciding the same thing, and the copy in here would silently win.
 *
 * @param raw - the engine's results.
 * @returns the seam result.
 */
function toResult(raw) {
  const sources = [];
  const seen = new Set();
  for (const item of raw) {
    // A page of results repeats itself (Google lists the same URL under a video
    // carousel and under web results); the seam shows the model one entry each.
    if (!isWebUrl(item.url)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    sources.push({
      url: item.url,
      ...item.title.length > 0 ? { title: item.title } : {},
      ...item.snippet.length > 0 ? { snippet: item.snippet } : {},
    });
  }
  return { sources, truncated: false };
}
