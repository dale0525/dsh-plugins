/**
 * Tests for the panel's HTTP routes.
 *
 * The two file-serving routes take their filename straight from the request
 * path, which is the only untrusted input in this plugin — so traversal is the
 * one thing here that genuinely needs pinning. `..%2f` and friends must fail as
 * a 404 rather than resolving a path outside `~/.stitch`; the strict
 * character-class check is what makes that true, and it is easy to "simplify"
 * away without any test noticing.
 *
 * The JSON routes are exercised against a stubbed Stitch client to pin the
 * index-lag fallback: a screen Stitch's `list_screens` no longer reports is
 * still recovered from the ids this machine remembered.
 *
 * As in `store.test.js`, `$HOME` moves before `src/routes.js` is imported,
 * because that module's store resolves `~/.stitch` from `os.homedir()` at load
 * time. Each test starts from an empty `.stitch` so one test's persisted state
 * cannot decide another's outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = await mkdtemp(join(tmpdir(), 'stitch-routes-'));
process.env.HOME = HOME;

const { HTML_API, SCREENS_PATH, makeRoutes } = await import('../src/routes.js');

test.beforeEach(async () => {
  await rm(join(HOME, '.stitch'), { recursive: true, force: true });
});

test.after(async () => {
  await rm(HOME, { recursive: true, force: true });
});

/** Minimal response recorder implementing the surface the handlers use. */
function makeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** Find a route by path. */
function routeFor(routes, path) {
  const route = routes.find((candidate) => candidate.path === path);
  assert.ok(route, `no route registered for ${path}`);
  return route;
}

/** A Stitch client stub with per-method canned results. */
function stubStitch(handlers) {
  return {
    callTool: async (name, args) => handlers[name]?.(args) ?? { content: [] },
  };
}

test('the screenshot route refuses traversal and anything off-pattern', async () => {
  const routes = makeRoutes({ stitch: stubStitch({}) });
  const route = routeFor(routes, SCREENS_PATH);

  // Plant a file OUTSIDE the screens directory that traversal would reach.
  await mkdir(join(HOME, '.stitch'), { recursive: true });
  await writeFile(join(HOME, '.stitch', 'secret.png'), 'top secret');

  for (const url of [
    '/stitch/screens/..%2Fsecret.png',
    '/stitch/screens/../secret.png',
    '/stitch/screens/secret.png',
    '/stitch/screens/a/b.png',
    '/stitch/screens/nope.txt',
    '/stitch/screens/',
  ]) {
    const res = makeResponse();
    await route.handler({ url }, res);
    assert.equal(res.status, 404, `${url} should 404`);
    assert.notEqual(res.body, 'top secret', `${url} leaked a file outside the cache`);
  }
});

test('the screenshot route serves a cached file', async () => {
  const routes = makeRoutes({ stitch: stubStitch({}) });
  const route = routeFor(routes, SCREENS_PATH);

  await mkdir(join(HOME, '.stitch', 'screens'), { recursive: true });
  await writeFile(join(HOME, '.stitch', 'screens', 's1.png'), 'png-bytes');

  const res = makeResponse();
  await route.handler({ url: '/stitch/screens/s1.png' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(String(res.body), 'png-bytes');
});

test('the HTML route refuses traversal too', async () => {
  const routes = makeRoutes({ stitch: stubStitch({}) });
  const route = routeFor(routes, '/stitch/html');

  await mkdir(join(HOME, '.stitch'), { recursive: true });
  await writeFile(join(HOME, '.stitch', 'secret.html'), 'top secret');

  for (const url of ['/stitch/html/../secret.html', '/stitch/html/secret.html', '/stitch/html/a/b.html']) {
    const res = makeResponse();
    await route.handler({ url }, res);
    assert.equal(res.status, 404, `${url} should 404`);
    assert.notEqual(res.body, 'top secret');
  }
});

test('state reports the remembered screen that list_screens has not caught up with', async () => {
  const stitch = stubStitch({
    list_projects: () => ({ structuredContent: { projects: [{ name: 'projects/p1', title: 'Workbench' }] } }),
    // The index is still empty: this is the lag being compensated for.
    list_screens: () => ({ structuredContent: { screens: [] } }),
    get_screen: (args) =>
      String(args.name).endsWith('/s1')
        ? { structuredContent: { screen: { name: 'projects/p1/screens/s1', title: 'Recovered' } } }
        : { content: [] },
  });

  // Seed the memory the way a previous session's generate would have.
  const { saveState, rememberScreenId } = await import('../src/store.js');
  await saveState({ projectId: 'p1', lastScreenId: 's1' });
  await rememberScreenId('p1', 's1');

  const routes = makeRoutes({ stitch });
  const res = makeResponse();
  await routeFor(routes, '/stitch/api/state').handler({ url: '/stitch/api/state' }, res);

  const payload = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.projectId, 'p1');
  assert.equal(payload.projectTitle, 'Workbench');
  assert.deepEqual(
    payload.screens.map((screen) => screen.id),
    ['s1'],
  );
});

test('state falls back to the first project when memory is empty', async () => {
  const stitch = stubStitch({
    list_projects: () => ({ structuredContent: { projects: [{ name: 'projects/p9', title: 'Newest' }] } }),
    list_screens: () => ({ structuredContent: { screens: [{ name: 'projects/p9/screens/s9', title: 'Home' }] } }),
  });

  const routes = makeRoutes({ stitch });
  const res = makeResponse();
  await routeFor(routes, '/stitch/api/state').handler({ url: '/stitch/api/state' }, res);

  const payload = JSON.parse(res.body);
  // The configured default project is not among the live ids, so the panel
  // must land on a real one instead of showing nothing.
  assert.equal(payload.projectId, 'p9');
  assert.deepEqual(
    payload.screens.map((screen) => screen.id),
    ['s9'],
  );
});

test('state survives a Stitch failure and still reports an empty panel', async () => {
  const stitch = {
    callTool: async () => {
      throw new Error('Stitch API key is not configured');
    },
  };

  const routes = makeRoutes({ stitch });
  const res = makeResponse();
  await routeFor(routes, '/stitch/api/state').handler({ url: '/stitch/api/state' }, res);

  const payload = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.projects, []);
  assert.deepEqual(payload.screens, []);
});

test('the HTML export route refuses a screen id it cannot fetch', async () => {
  const routes = makeRoutes({ stitch: stubStitch({ list_projects: () => ({ structuredContent: { projects: [] } }) }) });
  const res = makeResponse();
  await routeFor(routes, HTML_API).handler({ url: '/stitch/api/html/../../etc/passwd' }, res);
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).ok, false);
});
