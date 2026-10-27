/**
 * Tests for the page-selection seam.
 *
 * A run navigates the page it drives, so which page it picks decides whether the
 * user's own tab survives the run. Picking `context.pages()[0]` picked whichever
 * tab the profile happened to hold first — observed driving a login page the
 * user was not looking at, and navigating it away.
 *
 * There is no reliable way to ask the browser which tab the user is looking at:
 * Playwright's connection enables focus emulation, which makes every tab report
 * `document.visibilityState === 'visible'`. Measured on the real profile — three
 * tabs, one active — all three reported `visible` while attached, and only
 * reported the truth after `Emulation.setFocusEmulationEnabled(false)` was sent
 * to each page. So the run does not guess: it opens a page of its own and leaves
 * every existing tab alone.
 *
 * The seam takes a browser-shaped object, so it is tested without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runPage } from '../src/cdp.js';

/** A browser whose single context exposes the given pages. */
function fakeBrowser(pages) {
  const opened = [];
  const context = {
    pages: () => pages,
    async newPage() {
      const page = { url: () => 'about:blank' };
      opened.push(page);
      return page;
    },
  };
  return { browser: { contexts: () => [context] }, opened };
}

test('opens its own page instead of driving one the user already has', async () => {
  const userPage = { url: () => 'https://qyyuapi.com/' };
  const { browser, opened } = fakeBrowser([userPage]);

  const page = await runPage(browser);

  assert.equal(opened.length, 1, 'exactly one page is opened');
  assert.equal(page, opened[0]);
  assert.notEqual(page, userPage, "the user's tab must never be the one driven");
});

test('picks the same page however many tabs the profile holds', async () => {
  const tabs = [
    { url: () => 'https://a.test/' },
    { url: () => 'https://b.test/' },
    { url: () => 'https://c.test/' },
  ];
  const { browser, opened } = fakeBrowser(tabs);

  const page = await runPage(browser);

  assert.equal(page, opened[0]);
  for (const tab of tabs) assert.notEqual(page, tab, `tab ${tab.url()} must not be driven`);
});

test('opens a page even when the profile has none', async () => {
  const { browser, opened } = fakeBrowser([]);
  assert.equal(await runPage(browser), opened[0]);
});

test('reports a browser that exposes no context', async () => {
  await assert.rejects(() => runPage({ contexts: () => [] }), /no browser context/);
});
