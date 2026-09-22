/**
 * Shared vitest setup, applied to every test file after its environment is
 * established.
 *
 * jsdom implements no canvas: every `getContext('2d')` call prints a
 * "Not implemented" error to the console before answering null. The
 * ComposerSlider's radiation effect already treats a null context as "draw
 * nothing" (the reduced-motion degradation path), so stubbing the method to
 * answer null up front keeps that exact path under test without one noise
 * line per mounted slider.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
}

/**
 * Adopt jsdom's Web Storage objects onto the global.
 *
 * vitest 4.1.11's jsdom environment copies a window property onto `globalThis`
 * only when the key is absent from `global` OR listed in its own KEYS
 * allowlist (`populateGlobal` → `getWindowKeys`). Neither `localStorage` nor
 * `sessionStorage` is in that list, while Node >=25 defines BOTH globals — so
 * on Node >=25 vitest drops jsdom's pair and the tests silently run against
 * Node's instead. The two diverge in shape:
 *
 * - `localStorage` answers `undefined` without `--localstorage-file`, so
 *   `window.localStorage.clear()` throws and takes the whole effort-memory
 *   suite down with it;
 * - `sessionStorage` is a WORKING in-memory store, so nothing throws — but it
 *   is not a jsdom `Storage`, so `vi.spyOn(Storage.prototype, 'setItem')`
 *   never observes the write and the "storage refuses the write" test passes
 *   vacuously (the spy is called zero times).
 *
 * Node 22/24 define neither global, so vitest copies jsdom's pair and both
 * `!==` checks below are no-ops there. vitest 5 fixed this by adding the two
 * keys to KEYS; until this package moves to it, the storage-backed tests need
 * the DOM's pair wired up here.
 */
const globalWithDom = globalThis as unknown as {
  jsdom?: { window: Window }
  localStorage?: Storage
  sessionStorage?: Storage
}
if (globalWithDom.jsdom !== undefined) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    const domStorage = globalWithDom.jsdom.window[key]
    if (globalWithDom[key] !== domStorage) {
      Object.defineProperty(globalThis, key, {
        value: domStorage,
        configurable: true,
        writable: true,
      })
    }
  }
}
