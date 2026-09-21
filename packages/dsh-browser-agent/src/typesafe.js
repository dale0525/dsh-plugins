/**
 * The TypeSafe System One client.
 *
 * One request carries the state, the operation question, and one target
 * question per operation with candidates. The response is validated before it
 * can cause anything — see `./validate.js` for why that is a refusal and not a
 * repair.
 *
 * @module @logictan/dsh-browser-agent/typesafe
 */

/** Default endpoint; the API's one evaluation route. */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Default model alias. */
export const DEFAULT_MODEL = 'jev-latest';

/** HTTP statuses worth a retry: rate limiting and transient unavailability. */
const RETRY_STATUSES = new Set([429, 503, 529]);

/** Total attempts, matching the upstream client. */
const ATTEMPTS = 3;

/** Request timeout in milliseconds. */
const TIMEOUT_MS = 25_000;

/** Backoff before attempt `n` (1-based), in milliseconds. */
function backoffMs(attempt) {
  return 500 * 2 ** (attempt - 1);
}

/** Sleep, honouring an abort signal. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('browser_agent: the run was cancelled.', { cause: signal?.reason }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Ask TypeSafe for one decision.
 *
 * @param input - the request body, the endpoint, the API key and an abort signal.
 * @returns the parsed response body, with an `answers` map.
 * @throws {Error} an actionable message; nothing is executed on failure.
 */
export async function ask(input) {
  const { body, endpoint, apiKey, signal } = input;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean)),
      });
    } catch (cause) {
      throw new Error(
        `browser_agent: TypeSafe request failed (${cause instanceof Error ? cause.message : String(cause)}); no action executed.`,
        { cause },
      );
    }

    if (RETRY_STATUSES.has(response.status) && attempt < ATTEMPTS) {
      await sleep(backoffMs(attempt), signal);
      continue;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `browser_agent: TypeSafe returned HTTP ${response.status}${detail === '' ? '' : ` — ${detail.slice(0, 300)}`}; no action executed.`,
      );
    }
    return await response.json();
  }
  throw new Error('browser_agent: TypeSafe was unavailable after retries; no action executed.');
}
