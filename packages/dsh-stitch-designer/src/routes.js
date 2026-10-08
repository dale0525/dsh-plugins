/**
 * HTTP routes behind the preview panel.
 *
 * Four routes, and only the four the panel actually calls (the reference
 * plugin's `POST /stitch/api/generate` and `POST /stitch/api/edit` are
 * deliberately not ported: they existed so an agent could drive Stitch over
 * HTTP, and in this plugin the agent calls `mcp__stitch__*` tools directly, so
 * those two routes would have no caller at all).
 *
 * Two of the four are plain file servers over the local cache, and both take
 * their filename from the request path — the only genuinely untrusted input in
 * this plugin. Each therefore validates the segment against a strict
 * character-class pattern before touching the filesystem, so `..` and any other
 * traversal attempt fails as a 404 rather than resolving a path outside
 * `~/.stitch`.
 *
 * @module @logictan/dsh-stitch-designer/routes
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  HTML_DIR,
  SCREENS_DIR,
  cacheScreenAssets,
  downloadTo,
  knownScreenIds,
  loadState,
  rememberScreenId,
  saveState,
  toPanelScreen,
} from './store.js';

/** Path prefix of the panel's JSON API. */
export const STATE_API = '/stitch/api/state';
/** Path prefix of the 1:1 HTML export endpoint. */
export const HTML_API = '/stitch/api/html';
/** Path prefix of the cached screenshot files. */
export const SCREENS_PATH = '/stitch/screens';
/** Path prefix of the exported HTML files. */
export const HTML_PATH = '/stitch/html';

/** A screen id or file stem: no dots, no slashes, so it cannot escape its directory. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Write a JSON response.
 *
 * `no-store` matters: the panel polls this while a design is being generated,
 * and a cached response would show a stale project.
 *
 * @param res - the response.
 * @param status - HTTP status.
 * @param value - the JSON body.
 */
function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/**
 * Write a file from the local cache.
 *
 * @param res - the response.
 * @param dir - the cache directory the file must live in.
 * @param file - the validated file name.
 * @param contentType - the response content type.
 */
async function serveFile(res, dir, file, contentType) {
  try {
    const body = await readFile(join(dir, file));
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

/** Extract the last path segment after a prefix. */
function segmentAfter(url, prefix) {
  const path = String(url ?? '').split('?')[0];
  if (!path.startsWith(`${prefix}/`)) return undefined;
  return path.slice(prefix.length + 1);
}

/**
 * Build the plugin's routes.
 *
 * @param options - the Stitch client.
 * @returns the route list.
 */
export function makeRoutes(options) {
  const { stitch } = options;

  /** List every project the account can see, flattened for the picker. */
  const listProjects = async () => {
    const result = await stitch.callTool('list_projects', {}, undefined);
    const projects = result?.structuredContent?.projects;
    return Array.isArray(projects) ? projects : [];
  };

  /** List one project's screens. */
  const listScreens = async (projectId) => {
    const result = await stitch.callTool('list_screens', { projectId }, undefined);
    const screens = result?.structuredContent?.screens;
    return Array.isArray(screens) ? screens : [];
  };

  /** Fetch one screen directly, which works before the index catches up. */
  const getScreen = async (projectId, screenId) => {
    const result = await stitch.callTool('get_screen', { name: `projects/${projectId}/screens/${screenId}` }, undefined);
    return result?.structuredContent?.screen ?? result?.structuredContent;
  };

  return [
    // ------------------------------------------------- state (prefix)
    {
      kind: 'prefix',
      path: STATE_API,
      handler: async (req, res) => {
        try {
          const url = new URL(String(req.url ?? ''), 'http://localhost');
          const wanted = url.searchParams.get('projectId') ?? '';

          const projects = (await listProjects().catch(() => []))
            .map((project) => ({
              id: String(project?.name ?? '').split('/').pop(),
              name: project?.name ?? '',
              title: project?.title ?? '',
              deviceType: project?.deviceType ?? '',
              updateTime: project?.updateTime ?? '',
            }))
            .filter((project) => project.id !== '');

          const state = await loadState();
          const targetId = wanted || state.projectId || projects[0]?.id || '';

          const seen = new Set();
          const items = [];
          const adopt = async (screen) => {
            const row = toPanelScreen(screen);
            if (row === undefined || seen.has(row.id)) return;
            seen.add(row.id);
            await rememberScreenId(targetId, row.id);
            await cacheScreenAssets(screen);
            items.push(row);
          };

          for (const screen of await listScreens(targetId).catch(() => [])) await adopt(screen);

          // `list_screens` lags generation by up to a couple of minutes, so any
          // id this machine has already seen is re-fetched directly. Without
          // this the panel shows an empty project right after a design lands.
          const fallbackIds = knownScreenIds(state, targetId);
          if (state.lastScreenId && !fallbackIds.includes(state.lastScreenId)) fallbackIds.unshift(state.lastScreenId);
          for (const screenId of fallbackIds) {
            if (seen.has(screenId) || !SAFE_ID.test(screenId)) continue;
            await getScreen(targetId, screenId)
              .then((screen) => adopt(screen))
              .catch(() => {});
          }

          await saveState({ projectId: targetId });
          const target = projects.find((project) => project.id === targetId);
          json(res, 200, {
            ok: true,
            projectId: targetId,
            projectTitle: target?.title ?? '',
            lastScreenId: state.lastScreenId ?? '',
            projects,
            screens: items,
          });
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },

    // ------------------------------------------------- HTML export (prefix)
    {
      kind: 'prefix',
      path: HTML_API,
      handler: async (req, res) => {
        try {
          const screenId = segmentAfter(req.url, HTML_API);
          if (screenId === undefined || !SAFE_ID.test(screenId)) {
            json(res, 404, { ok: false, error: 'screen 不存在' });
            return;
          }
          // The panel can ask for a screen from any project, so the owning
          // project is resolved from the state and then from the project list
          // rather than assumed to be the currently selected one.
          const state = await loadState();
          const candidates = [state.projectId, ...(await listProjects().catch(() => [])).map((p) => String(p?.name ?? '').split('/').pop())];
          let screen;
          for (const projectId of candidates) {
            if (!projectId) continue;
            screen = await getScreen(projectId, screenId).catch(() => undefined);
            if (screen?.htmlCode?.downloadUrl) break;
            screen = undefined;
          }
          if (screen?.htmlCode?.downloadUrl === undefined) {
            json(res, 404, { ok: false, error: 'screen 不存在' });
            return;
          }
          await downloadTo(screen.htmlCode.downloadUrl, join(HTML_DIR, `${screenId}.html`));
          json(res, 200, { ok: true, html: `${HTML_PATH}/${screenId}.html` });
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },

    // ------------------------------------------------- screenshots (prefix)
    {
      kind: 'prefix',
      path: SCREENS_PATH,
      handler: async (req, res) => {
        const file = segmentAfter(req.url, SCREENS_PATH);
        const match = /^([A-Za-z0-9_-]+)\.png$/.exec(file ?? '');
        if (match === null) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        await serveFile(res, SCREENS_DIR, `${match[1]}.png`, 'image/png');
      },
    },

    // ------------------------------------------------- exported HTML (prefix)
    {
      kind: 'prefix',
      path: HTML_PATH,
      handler: async (req, res) => {
        const file = segmentAfter(req.url, HTML_PATH);
        const match = /^([A-Za-z0-9_-]+)\.html$/.exec(file ?? '');
        if (match === null) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        await serveFile(res, HTML_DIR, `${match[1]}.html`, 'text/html; charset=utf-8');
      },
    },
  ];
}
