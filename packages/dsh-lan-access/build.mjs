/**
 * dsh-lan-access build script: copy both halves from `src/` to `lib/`.
 *
 * `lib/` is not version-controlled (see `.gitignore`); a fresh clone builds it
 * through `prepare`/`prepack`.
 *
 * A copy rather than a bundle: the host half imports only `node:` builtins, so
 * there is nothing to inline and nothing to keep out of `dependencies`. The
 * browser half (`src/client.js`) is already written in the client module
 * loader's protocol — it is a factory, not a module — and `package.json` points
 * `./client` straight at `lib/client.js`, so the same copy ships both.
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
console.log(`[dsh-lan-access] built: ${libDir}`);
