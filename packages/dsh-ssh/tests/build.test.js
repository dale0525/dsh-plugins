/**
 * Test for the published artifact, not the sources.
 *
 * The host half is an esbuild bundle (`build.mjs`), and two of its properties
 * are load-bearing in ways the source tests cannot see:
 *
 *  - the bundle must be ESM and must `import` the host packages rather than
 *    `require()` them. A CJS bundle turns every external into `require()`, and
 *    Node rejects `require()` of an ESM host package with
 *    ERR_REQUIRE_ESM_RACE_CONDITION while that package is still loading — which
 *    is exactly when the loader is reading this entry. The loader drops a plugin
 *    whose import fails, so the symptom was a plugin that mounted NOTHING in
 *    `dsh web` while every isolated test passed.
 *  - `ssh2` must be inside the bundle and absent from `dependencies`. Its
 *    `install` script is what makes pnpm fail the whole install with
 *    `ERR_PNPM_IGNORED_BUILDS`, so a published package that depends on it is
 *    uninstallable for everyone (see the header of `build.mjs`).
 *
 * Both are checked here because both fail silently at runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the build emits a bundle the loader can unwrap', async () => {
  await run(process.execPath, [join(root, 'build.mjs')]);

  // `import()`, not `require`: that is how the loader reads the entry.
  const namespace = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
  assert.equal(namespace.name, 'dsh-ssh');
  assert.equal(typeof namespace.apply, 'function');
  // Config is read by the settings form; without it the card binds nothing.
  assert.equal(typeof namespace.Config, 'function');
  assert.equal(namespace.PASSWORD_REF_PREFIX, 'SSH_PASSWORD_');
});

test('the entry imports the host packages instead of require()-ing them', async () => {
  // The regression this pins: a CJS bundle emits `require('@deepseek-ai/dsh-tools')`
  // for an ESM host package, which Node rejects with
  // ERR_REQUIRE_ESM_RACE_CONDITION whenever the host is mid-load — and the loader
  // drops a plugin whose import fails, so the plugin mounted nothing at all in
  // `dsh web` while every other test passed. Asserting on the emitted text is the
  // only way to catch it: loading the bundle in isolation resolves the host
  // packages fine, which is exactly why the bug survived until a real boot.
  const text = await readFile(join(root, 'lib', 'index.js'), 'utf8');
  for (const hostPackage of ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-home-paths']) {
    assert.ok(
      text.includes(`from "${hostPackage}"`),
      `${hostPackage} must be a static import`,
    );
    assert.ok(
      !text.includes(`require("${hostPackage}")`),
      `${hostPackage} must not be require()d from an ESM bundle`,
    );
  }
});

test('the published package carries no dependency that needs a build script', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  // ssh2 stays a devDependency: it is bundled at build time, so it is present
  // in `lib/` but never resolved from a user's profile.
  assert.ok(manifest.devDependencies?.ssh2, 'ssh2 must stay available to the build');
  assert.equal(manifest.main, 'lib/index.js');
});
