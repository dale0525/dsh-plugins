/**
 * dsh-fakeip-fetch build script: copy the host half from `src/` to `lib/`.
 *
 * `lib/` is not version-controlled (see `.gitignore`); a fresh clone builds it
 * through `prepare`/`prepack`. There is no client half and no bundling step —
 * the sources are already plain ESM, so a recursive copy is the whole build.
 *
 * Usage: `node build.mjs` (also run by `prepare` and `prepack`).
 */
import { cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');
const libDir = join(root, 'lib');

await rm(libDir, { recursive: true, force: true });
await cp(srcDir, libDir, { recursive: true });
console.log(`[dsh-fakeip-fetch] built: ${libDir}`);
