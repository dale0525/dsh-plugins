/**
 * Tests for the observation retry seam.
 *
 * A click may navigate, and the loop re-observes immediately afterwards. That
 * observation can land while the old document is gone and the new one is not
 * ready — Playwright reports it as "Execution context was destroyed". Treating
 * that as fatal would end the run the moment the agent clicked its first link,
 * which is the single most common browser action.
 *
 * The seam is tested without a browser: `observe` takes a page-shaped object,
 * so a fake page can produce the exact rejection sequence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { observe } from '../src/loop.js';
import { SNAPSHOT_LIMITS, snapshot } from '../src/observe.js';

/** A page whose `evaluate` follows a scripted sequence of outcomes. */
function fakePage(outcomes) {
  const seen = [];
  return {
    seen,
    async evaluate() {
      seen.push(seen.length + 1);
      const outcome = outcomes[seen.length - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async waitForTimeout() {},
  };
}

const destroyed = () => new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
const SNAPSHOT = { url: 'https://example.com', actions: [] };

test('returns the first observation when it succeeds', async () => {
  const page = fakePage([SNAPSHOT]);
  assert.equal(await observe(page), SNAPSHOT);
  assert.equal(page.seen.length, 1);
});

test('retries a destroyed context and returns the document that replaced it', async () => {
  const page = fakePage([destroyed(), SNAPSHOT]);
  assert.equal(await observe(page), SNAPSHOT);
  assert.equal(page.seen.length, 2);
});

test('retries more than once while a navigation is still in flight', async () => {
  const page = fakePage([destroyed(), destroyed(), destroyed(), SNAPSHOT]);
  assert.equal(await observe(page), SNAPSHOT);
  assert.equal(page.seen.length, 4);
});

test('propagates a rejection that is not a navigation', async () => {
  const fault = new Error('Target page, context or browser has been closed');
  const page = fakePage([fault]);
  await assert.rejects(() => observe(page), /has been closed/);
  assert.equal(page.seen.length, 1, 'a real fault must not be retried');
});

test('gives up when the context never comes back', async () => {
  const page = fakePage(Array.from({ length: 10 }, destroyed));
  await assert.rejects(() => observe(page), /Execution context was destroyed/);
  assert.equal(page.seen.length, 5, 'the attempt cap bounds the retries');
});


/**
 * A fake page the real `snapshot` can run against.
 *
 * `snapshot` is serialized into the page, so it must be tested by running the
 * real function over a document-shaped object — a reimplementation in the test
 * would pass against a broken source.
 */
/** A frame-shaped document holding exactly one button of the given name. */
function fakeRootWithControl(label) {
  const element = {
    tagName: 'BUTTON',
    type: 'button',
    labels: [],
    childNodes: [{ nodeType: 3, textContent: label }],
    textContent: label,
    innerText: '',
    getAttribute: () => null,
    closest: () => null,
    matches: () => false,
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 40, height: 20 }),
  };
  const root = {
    body: { childNodes: [] },
    documentElement: { scrollHeight: 500 },
    title: 'Inner',
    querySelectorAll(selector) {
      if (selector === 'iframe,frame') return [];
      if (selector === '*') return [];
      return [element];
    },
    createTreeWalker: () => ({ nextNode: () => null }),
    getElementById: () => null,
  };
  element.getRootNode = () => root;
  return root;
}

function documentPage(roots) {
  let next = 1;
  const makeElement = (spec) => {
    const element = {
      tagName: spec.tagName ?? 'BUTTON',
      type: spec.type ?? 'button',
      labels: [],
      childNodes: spec.childNodes ?? [],
      innerText: '',
      textContent: spec.text ?? '',
      getAttribute: () => null,
      hasAttribute: () => false,
      closest: () => null,
      matches: () => false,
      checkVisibility: () => spec.visible ?? true,
      getBoundingClientRect: () => spec.rect ?? { x: 10, y: 10, width: 40, height: 20 },
      getRootNode() {
        return spec.root ?? root;
      },
      ...spec,
    };
    element.getRootNode = () => spec.root ?? element.__root;
    return element;
  };

  const makeRoot = (spec) => {
    const root = {
      body: { childNodes: [] },
      documentElement: { scrollHeight: spec.scrollHeight ?? 500, tagName: 'HTML' },
      title: spec.title ?? 'Fake',
      defaultView: null,
      querySelectorAll(selector) {
        if (selector === 'iframe,frame') return spec.frames ?? [];
        if (selector === '*') return [...(spec.frames ?? []), ...(spec.shadowHosts ?? []), ...(spec.scrollers ?? [])];
        return spec.controls ?? [];
      },
      createTreeWalker: () => ({ nextNode: () => null }),
      getElementById: () => null,
    };
    for (const element of spec.controls ?? []) element.__root = root;
    return root;
  };

  const document_ = makeRoot(roots.document);
  globalThis.document = document_;
  globalThis.window = { __dshBrowserAgent: undefined };
  globalThis.innerWidth = 1024;
  globalThis.innerHeight = 768;
  globalThis.scrollY = 0;
  globalThis.getComputedStyle = (element) => ({ overflowY: element.__overflowY ?? 'visible' });
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.location = { href: 'https://example.test/' };
  globalThis.document.createRange = () => ({ selectNodeContents() {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }) });
  return document_;
}

function cleanupPage(t) {
  t.after(() => {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.getComputedStyle;
    delete globalThis.NodeFilter;
    delete globalThis.location;
    delete globalThis.innerWidth;
    delete globalThis.innerHeight;
    delete globalThis.scrollY;
  });
}

test('observes controls inside an open shadow root', async (t) => {
  const inner = fakeRootWithControl('Activate');
  const host = { shadowRoot: inner };
  const page = documentPage({ document: { shadowHosts: [host], controls: [] } });
  cleanupPage(t);

  const observation = snapshot(SNAPSHOT_LIMITS);

  assert.deepEqual(observation.actions.map((action) => action.label), ['Activate']);
});

test('observes controls inside a same-origin frame', async (t) => {
  const frameDoc = fakeRootWithControl('Frame button');
  const frame = { tagName: 'IFRAME', contentDocument: frameDoc, getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 50 }) };
  documentPage({ document: { frames: [frame], controls: [] } });
  cleanupPage(t);

  const observation = snapshot(SNAPSHOT_LIMITS);

  assert.deepEqual(observation.actions.map((action) => action.label), ['Frame button']);
});

test('skips a cross-origin frame instead of failing the whole observation', async (t) => {
  const frame = { tagName: 'IFRAME', contentDocument: null, getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 50 }) };
  documentPage({ document: { frames: [frame], controls: [] } });
  cleanupPage(t);

  const observation = snapshot(SNAPSHOT_LIMITS);

  assert.deepEqual(observation.actions, []);
});

test('offers the panel that still has content below it, with the panel as its target', async (t) => {
  const scroller = { __overflowY: 'auto', scrollHeight: 800, clientHeight: 160, scrollTop: 0, isConnected: true, getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 160 }) };
  documentPage({ document: { scrollers: [scroller], controls: [] } });
  cleanupPage(t);

  const observation = snapshot(SNAPSHOT_LIMITS);

  assert.ok(observation.controls.includes('SCROLL_INNER'), 'the inner panel must be offered');
  assert.equal(typeof observation.innerScroll, 'number', 'the control must carry the panel it scrolls');
});

test('does not offer the panel once it is already at the bottom', async (t) => {
  const scroller = { __overflowY: 'auto', scrollHeight: 800, clientHeight: 160, scrollTop: 640, isConnected: true, getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 160 }) };
  documentPage({ document: { scrollers: [scroller], controls: [] } });
  cleanupPage(t);

  const observation = snapshot(SNAPSHOT_LIMITS);

  assert.equal(observation.controls.includes('SCROLL_INNER'), false);
  assert.equal(observation.innerScroll, null);
});
