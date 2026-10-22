/**
 * dsh-modal-h3 build script: copy the JS halves from `src/` to `lib/` verbatim.
 *
 * `lib/` is not version-controlled (see `.gitignore`); a fresh clone builds it
 * through `prepare`/`prepack`. Both halves are already publishable verbatim —
 * the host half is plain ESM with no asset to inline, and `src/client.js` is
 * already in the client module loader's protocol — so a recursive copy is the
 * whole build.
 *
 * `app/` and `assets/` are NOT copied: they ship from the package root, which is
 * where `src/index.js` derives `APP_DIR` from. Copying them into `lib/` would
 * create a second copy that the runner never reads.
 *
 * The build fails when a file the runtime needs is missing, because the failure
 * it prevents is silent: an npm package whose `app/` was never published installs
 * cleanly and then cannot spawn a single generation.
 *
 * Usage: `node build.mjs` (also run by `prepare` and `prepack`).
 */
import { access, cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');
const libDir = join(root, 'lib');

/** Files the runtime resolves relative to the package root, never through `lib/`. */
const REQUIRED = [
  'app/plugin_runner.py',
  'app/modal_h3_app.py',
  'app/modal_h3_contract.py',
  'assets/h3/modal-minimax-h3-video/minimax_h3_ref2va_turbo6_api.json',
  'assets/h3/modal-minimax-h3-video/model-manifest.json',
];

for (const relative of REQUIRED) {
  await access(join(root, relative));
}

await rm(libDir, { recursive: true, force: true });
await cp(srcDir, libDir, { recursive: true });

// `files: ["app"]` ships the whole directory, and `.npmignore` cannot exclude
// anything from a path the `files` field already admitted. Running the runner by
// hand while debugging writes `app/__pycache__/`, and a stale `.pyc` would ship
// and then take precedence over the `.py` beside it. Deleting them here is the
// one hook that runs before both `npm pack` and `npm publish`.
for await (const directory of glob('app/**/__pycache__', { cwd: root })) {
  await rm(join(root, directory), { recursive: true, force: true });
}

console.log(`[dsh-modal-h3] built: ${libDir}`);
