/**
 * Local asset store behind the preview panel: the screenshot/HTML cache, the
 * "last used project" state, and the per-project screen registry.
 *
 * Stitch's `list_screens` index lags behind generation by up to a couple of
 * minutes, and `generate_screen_from_text` returns the finished screen in its
 * own payload long before that index catches up. The cache and registry here
 * are what let the panel show a design the moment it exists instead of showing
 * an empty project — the failure the reference implementation was written to
 * fix, and the reason `state.json` is persisted rather than held in memory
 * (an in-memory `lastScreenId` is lost on every restart, blanking the panel).
 *
 * Everything lives under `~/.stitch`, the same location the reference plugin
 * used, so an existing cache keeps working. The API key is deliberately NOT
 * here: it belongs to the credentials file (see `src/index.js`).
 *
 * @module @logictan/dsh-stitch-designer/store
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Root of the local cache. */
export const STITCH_HOME = join(homedir(), '.stitch');
/** Cached screenshots, served at `/stitch/screens/<id>.png`. */
export const SCREENS_DIR = join(STITCH_HOME, 'screens');
/** Exported 1:1 HTML sources, served at `/stitch/html/<id>.html`. */
export const HTML_DIR = join(STITCH_HOME, 'html');
/** Persisted project/screen state. */
export const STATE_FILE = join(STITCH_HOME, 'state.json');
/** Cap on remembered screen ids per project. */
const MAX_REMEMBERED_SCREENS = 50;

/**
 * Read `state.json`, tolerating absence and corruption.
 *
 * A missing or malformed file means "no memory yet", which is a normal first
 * run — not a failure worth surfacing, and definitely not one worth letting
 * abort a panel refresh.
 *
 * @returns the parsed state, or an empty object.
 */
export async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge a patch into `state.json`.
 *
 * Empty values never overwrite a stored one: callers pass whatever they happen
 * to have in hand, and an uninitialised variable would otherwise erase the
 * project the panel is supposed to remember.
 *
 * @param patch - fields to merge.
 * @returns the merged state.
 */
export async function saveState(patch) {
  const previous = await loadState();
  const next = { ...previous, ...patch };
  if (!patch.projectId && previous.projectId) next.projectId = previous.projectId;
  if (!patch.lastScreenId && previous.lastScreenId) next.lastScreenId = previous.lastScreenId;
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(next, null, 2));
  } catch {
    // The state file is an optimisation; losing it degrades the panel to
    // "whatever Stitch's index reports" and must not fail the request.
  }
  return next;
}

/**
 * Screen ids this machine has already seen for one project.
 *
 * @param state - a loaded state object.
 * @param projectId - the project id.
 * @returns the remembered ids, oldest first.
 */
export function knownScreenIds(state, projectId) {
  const registry = state?.screensByProject?.[projectId];
  return Array.isArray(registry) ? registry : [];
}

/**
 * Record one screen id against its project.
 *
 * @param projectId - the project id.
 * @param screenId - the screen id to remember.
 */
export async function rememberScreenId(projectId, screenId) {
  if (!projectId || !screenId) return;
  const state = await loadState();
  const registry = { ...(state.screensByProject ?? {}) };
  const list = Array.isArray(registry[projectId]) ? [...registry[projectId]] : [];
  if (!list.includes(screenId)) list.push(screenId);
  registry[projectId] = list.slice(-MAX_REMEMBERED_SCREENS);
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ ...state, screensByProject: registry }, null, 2));
  } catch {
    // See saveState: a lost registry only costs the index-lag fallback.
  }
}

/**
 * Upgrade a Google image URL to full resolution.
 *
 * Stitch hands out thumbnail URLs; `=s0` asks the image service for the
 * original. Applied only when no size directive is already present, so a URL
 * that already carries one is left alone.
 *
 * @param url - the download URL.
 * @returns the URL to fetch.
 */
export function hdImageUrl(url) {
  const value = String(url ?? '');
  return value.includes('googleusercontent.com') && !/=[sw]\d+/.test(value) ? `${value}=s0` : value;
}

/**
 * Download a URL to a local path, creating parent directories.
 *
 * @param url - source URL.
 * @param dest - absolute destination path.
 * @returns the destination path.
 * @throws when the response is not OK or the write fails.
 */
export async function downloadTo(url, dest) {
  const response = await fetch(hdImageUrl(url));
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await response.arrayBuffer()));
  return dest;
}

/**
 * Cache one screen's screenshot and HTML source, best effort.
 *
 * A failed download is not an error: the panel falls back to the remote
 * `downloadUrl`, and the next refresh retries. Only the returned record's
 * shape matters to callers.
 *
 * @param screen - a Stitch screen object.
 * @returns the screen's id, or `undefined` when it carries none.
 */
export async function cacheScreenAssets(screen) {
  const screenId = String(screen?.name ?? '').split('/').pop();
  if (!screenId) return undefined;
  if (screen?.screenshot?.downloadUrl) {
    await downloadTo(screen.screenshot.downloadUrl, join(SCREENS_DIR, `${screenId}.png`)).catch(() => {});
  }
  if (screen?.htmlCode?.downloadUrl) {
    await downloadTo(screen.htmlCode.downloadUrl, join(HTML_DIR, `${screenId}.html`)).catch(() => {});
  }
  return screenId;
}

/**
 * Project one Stitch screen into the panel's row shape.
 *
 * @param screen - a Stitch screen object.
 * @returns the panel row, or `undefined` when the screen carries no id.
 */
export function toPanelScreen(screen) {
  const screenId = String(screen?.name ?? '').split('/').pop();
  if (!screenId) return undefined;
  return {
    name: screen.name,
    id: screenId,
    title: screen.title ?? '',
    deviceType: screen.deviceType ?? '',
    width: screen.width ?? '',
    height: screen.height ?? '',
    preview: `/stitch/screens/${screenId}.png`,
    screenshotUrl: screen.screenshot?.downloadUrl ?? '',
    htmlUrl: screen.htmlCode?.downloadUrl ?? '',
  };
}

/**
 * Pull the freshly generated screen out of a `generate`/`edit` result.
 *
 * Stitch returns the finished screen inside
 * `structuredContent.outputComponents[].design.screens[]` immediately, which is
 * strictly earlier than `list_screens` will report it.
 *
 * @param result - the MCP result of a generate/edit call.
 * @returns the first screen found, or `undefined`.
 */
export function extractScreenFromResult(result) {
  const components = result?.structuredContent?.outputComponents;
  if (!Array.isArray(components)) return undefined;
  for (const component of components) {
    const screens = component?.design?.screens;
    if (Array.isArray(screens) && screens.length > 0) return screens[0];
  }
  return undefined;
}

/**
 * Adopt a screen into the cache and the persisted state.
 *
 * @param projectId - the project the screen belongs to.
 * @param screen - the Stitch screen object.
 * @param source - provenance tag recorded for the panel (`list`, `generate`, ...).
 * @returns the panel response, or `undefined` when the screen carries no id.
 */
export async function adoptScreen(projectId, screen, source = 'list') {
  const screenId = await cacheScreenAssets(screen);
  if (screenId === undefined) return undefined;
  await rememberScreenId(projectId, screenId);
  await saveState({ projectId, lastScreenId: screenId });
  return {
    ok: true,
    screenId,
    title: screen.title ?? '',
    deviceType: screen.deviceType ?? '',
    width: screen.width ?? '',
    height: screen.height ?? '',
    preview: `/stitch/screens/${screenId}.png`,
    html: `/stitch/html/${screenId}.html`,
    source,
  };
}
