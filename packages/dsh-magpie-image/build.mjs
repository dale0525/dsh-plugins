/**
 * dsh-magpie-image build: copy `src/` to `lib/` verbatim.
 *
 * The host half is plain ESM with no asset to inline, so a recursive copy is the
 * whole build. `lib/` is not version-controlled (see `.gitignore`); `prepare` and
 * `prepack` both run this, so a fresh clone and a published tarball each get it.
 *
 * Usage: `node build.mjs`.
 */
import { cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');
const libDir = join(root, 'lib');

await rm(libDir, { recursive: true, force: true });
await cp(srcDir, libDir, { recursive: true });
console.log(`[dsh-magpie-image] built: ${libDir}`);
