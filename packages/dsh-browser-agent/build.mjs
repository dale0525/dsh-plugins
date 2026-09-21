/**
 * dsh-browser-agent build script: copy both halves from `src/` to `lib/` verbatim.
 *
 * `lib/` is not version-controlled (see `.gitignore`); a fresh clone builds it
 * through `prepare`/`prepack`. Both halves are already publishable verbatim —
 * the host half is plain ESM, and `src/client.js` is already in the client
 * module loader's protocol and inlines no asset — so a recursive copy is the
 * whole build. Keeping it a copy (rather than publishing `src/` directly)
 * matches the repo-wide `main: lib/index.js` convention.
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
console.log(`[dsh-browser-agent] built: ${libDir}`);
