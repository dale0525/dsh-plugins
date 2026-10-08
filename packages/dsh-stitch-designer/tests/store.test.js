/**
 * Tests for the local asset store.
 *
 * Everything here exists to cover one measured failure: Stitch's
 * `list_screens` index lags a generation by up to a couple of minutes, while
 * `generate_screen_from_text` returns the finished screen immediately. A panel
 * built only on `list_screens` therefore shows an empty project right after a
 * design lands — the bug the reference implementation was written to fix. The
 * index-lag fallback re-fetches ids this machine has already seen and persists
 * them across restarts (`state.json`, not a module variable).
 *
 * `src/store.js` resolves `~/.stitch` from `os.homedir()` when it loads, and
 * `os.homedir()` honours `$HOME`. The home is therefore moved BEFORE the module
 * is imported: a static import would evaluate it against the real home and
 * write the user's own `~/.stitch`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = await mkdtemp(join(tmpdir(), 'stitch-store-'));
process.env.HOME = HOME;

const store = await import('../src/store.js');

test.beforeEach(async () => {
  await rm(join(HOME, '.stitch'), { recursive: true, force: true });
});

test.after(async () => {
  await rm(HOME, { recursive: true, force: true });
});

test('the store lives under the home directory it resolves at load time', () => {
  assert.equal(store.STITCH_HOME, join(HOME, '.stitch'));
  assert.equal(store.SCREENS_DIR, join(HOME, '.stitch', 'screens'));
  assert.equal(store.HTML_DIR, join(HOME, '.stitch', 'html'));
  assert.equal(store.STATE_FILE, join(HOME, '.stitch', 'state.json'));
});

test('loadState treats a missing or corrupt state file as no memory', async () => {
  assert.deepEqual(await store.loadState(), {});

  await mkdir(store.STITCH_HOME, { recursive: true });
  await writeFile(store.STATE_FILE, '{ not json');
  assert.deepEqual(await store.loadState(), {});
});

test('saveState never lets an empty value erase a remembered one', async () => {
  await store.saveState({ projectId: 'p1', lastScreenId: 's1' });
  // The panel calls this with whatever it has in hand; an uninitialised
  // variable must not blank the project the panel is meant to remember.
  await store.saveState({ projectId: '', lastScreenId: '' });

  const state = await store.loadState();
  assert.equal(state.projectId, 'p1');
  assert.equal(state.lastScreenId, 's1');
});

test('rememberScreenId dedupes and survives a fresh read', async () => {
  await store.rememberScreenId('p1', 's1');
  await store.rememberScreenId('p1', 's2');
  await store.rememberScreenId('p1', 's1');

  // Re-read from disk: this is the restart-persistence property, and it is
  // why the registry is a file rather than a module variable.
  assert.deepEqual(store.knownScreenIds(await store.loadState(), 'p1'), ['s1', 's2']);
  assert.deepEqual(store.knownScreenIds(await store.loadState(), 'other'), []);
});

test('hdImageUrl upgrades a thumbnail once and leaves a sized URL alone', () => {
  assert.equal(store.hdImageUrl('https://lh3.googleusercontent.com/abc'), 'https://lh3.googleusercontent.com/abc=s0');
  assert.equal(
    store.hdImageUrl('https://lh3.googleusercontent.com/abc=w512'),
    'https://lh3.googleusercontent.com/abc=w512',
  );
  assert.equal(store.hdImageUrl('https://example.com/abc'), 'https://example.com/abc');
  assert.equal(store.hdImageUrl(undefined), '');
});

test('extractScreenFromResult finds the screen Stitch returns inline', () => {
  const screen = { name: 'projects/p/screens/s', title: 'Home' };
  assert.deepEqual(
    store.extractScreenFromResult({ structuredContent: { outputComponents: [{}, { design: { screens: [screen] } }] } }),
    screen,
  );
  assert.equal(store.extractScreenFromResult({ structuredContent: { outputComponents: [] } }), undefined);
  assert.equal(store.extractScreenFromResult({}), undefined);
});

test('toPanelScreen derives the id from the resource name', () => {
  const row = store.toPanelScreen({
    name: 'projects/p1/screens/s1',
    title: 'Home',
    deviceType: 'MOBILE',
    width: 390,
    height: 844,
    screenshot: { downloadUrl: 'https://x/y' },
    htmlCode: { downloadUrl: 'https://x/z' },
  });
  assert.equal(row.id, 's1');
  assert.equal(row.preview, '/stitch/screens/s1.png');
  assert.equal(row.htmlUrl, 'https://x/z');

  assert.equal(store.toPanelScreen({ title: 'no name' }), undefined);
});

test('adoptScreen caches assets, remembers the id and persists the project', async () => {
  const original = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  try {
    const adopted = await store.adoptScreen('p1', {
      name: 'projects/p1/screens/s1',
      title: 'Home',
      screenshot: { downloadUrl: 'https://lh3.googleusercontent.com/png' },
      htmlCode: { downloadUrl: 'https://lh3.googleusercontent.com/html' },
    });

    assert.equal(adopted.ok, true);
    assert.equal(adopted.screenId, 's1');
    assert.equal(adopted.source, 'list');
    // The screenshot URL is upgraded to full resolution before download.
    assert.deepEqual(fetched, [
      'https://lh3.googleusercontent.com/png=s0',
      'https://lh3.googleusercontent.com/html=s0',
    ]);

    const state = await store.loadState();
    assert.equal(state.projectId, 'p1');
    assert.equal(state.lastScreenId, 's1');
    assert.deepEqual(await readFile(join(HOME, '.stitch', 'screens', 's1.png')), Buffer.from([1, 2, 3]));
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed asset download does not fail adoption', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    const adopted = await store.adoptScreen('p1', {
      name: 'projects/p1/screens/s1',
      screenshot: { downloadUrl: 'https://lh3.googleusercontent.com/png' },
    });
    // The panel falls back to the remote URL; only the local cache is lost.
    assert.equal(adopted.ok, true);
    assert.equal(adopted.screenId, 's1');
  } finally {
    globalThis.fetch = original;
  }
});
