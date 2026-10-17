/**
 * dsh-loop-guard build script: compile the host half.
 *
 * `lib/` is not version-controlled (see `.gitignore`); a fresh clone builds it
 * through `prepare`/`prepack`.
 *
 *  - `src/index.ts` is the host half and goes through `tsc` (declarations land
 *    in `lib/types/`, matching the `types` field and the `./lib/types/index.d.ts`
 *    export).
 *
 * Usage: `node build.mjs` (also run by `prepare`, `prepack`, and `test`).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
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
console.log(`[dsh-loop-guard] built: ${libDir}`);
