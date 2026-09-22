/**
 * dsh-loop-guard build script: compile the host half, copy the client half.
 *
 * `lib/` is not version-controlled (see `.gitignore`); a fresh clone builds it
 * through `prepare`/`prepack`. The two halves need different treatment:
 *
 *  - `src/index.ts` is the host half and goes through `tsc` (declarations land
 *    in `lib/types/`, matching the `types` field and the `./lib/types/index.d.ts`
 *    export).
 *  - `src/client.js` is the browser half and is already in the client module
 *    loader's protocol — it is not a module, imports nothing, and calls
 *    `window.__ModuleLoader__.load` at top level. `tsc` never sees it (it is not
 *    imported by the host half, and `allowJs` is off), so it is copied verbatim.
 *
 * Usage: `node build.mjs` (also run by `prepare`, `prepack`, and `test`).
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const libDir = join(root, 'lib');

await rm(libDir, { recursive: true, force: true });
await mkdir(libDir, { recursive: true });

execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc')], {
  cwd: root,
  stdio: 'inherit',
});
await copyFile(join(root, 'src', 'client.js'), join(libDir, 'client.js'));
console.log(`[dsh-loop-guard] built: ${libDir}`);
