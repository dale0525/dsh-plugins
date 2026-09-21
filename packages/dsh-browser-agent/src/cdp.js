/**
 * CDP attachment to the user's own Chrome.
 *
 * The plugin attaches to a browser the user started with
 * `--remote-debugging-port`; it never launches one and never closes one. That
 * distinction is load-bearing twice over: a launched browser cannot carry login
 * state (launch mode hard-codes `--isolated`, whose documented meaning is
 * "do not save the profile to disk"), and closing the connection at the end of
 * a run must leave the user's windows and tabs untouched.
 *
 * @module @logictan/dsh-browser-agent/cdp
 */
import { chromium } from 'playwright-core';

/** Default CDP endpoint; the dedicated-profile Chrome listens here. */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';

/** How long a connection attempt may take before it is reported as unreachable. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Instructions for making the endpoint reachable.
 *
 * Included in every connection failure because the cause is almost always
 * "Chrome is not listening" rather than a plugin fault, and the exact
 * `--user-data-dir` requirement is the part users get wrong: Chrome refuses
 * the debugging port on its default profile.
 */
export const START_INSTRUCTIONS = [
  'Start Chrome with a dedicated profile and a debugging port:',
  '  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\',
  '    --remote-debugging-port=9222 \\',
  '    --user-data-dir="$HOME/.dsh/chrome-agent-profile"',
  'Chrome refuses --remote-debugging-port on its DEFAULT profile, so --user-data-dir is required.',
  'Log in to the sites you need once; that dedicated profile persists across restarts.',
].join('\n');

/**
 * Attach to the browser behind `endpoint`.
 *
 * @param endpoint - CDP HTTP endpoint.
 * @returns the browser connection; the caller disconnects it, never closes it.
 * @throws {Error} an actionable message naming the endpoint and how to start it.
 */
export async function attach(endpoint = DEFAULT_ENDPOINT) {
  try {
    return await chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
  } catch (cause) {
    throw new Error(
      `browser_agent: could not attach to Chrome at ${endpoint} (${cause instanceof Error ? cause.message : String(cause)}).\n${START_INSTRUCTIONS}`,
    );
  }
}

/**
 * The page a run should drive.
 *
 * The user's own tab is reused when the context already has one, so a run does
 * not silently spawn windows; a new page is opened only when the context has
 * none. The first context is the browser's default one, which is where a
 * CDP-attached Chrome puts the profile's tabs.
 *
 * @param browser - the connection from {@link attach}.
 * @returns the page to drive.
 */
export async function activePage(browser) {
  const context = browser.contexts()[0];
  if (context === undefined) {
    throw new Error('browser_agent: the attached Chrome exposes no browser context.');
  }
  const pages = context.pages();
  return pages.length > 0 ? pages[0] : await context.newPage();
}
