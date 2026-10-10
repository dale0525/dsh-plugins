// Build the two halves of the plugin.
//
// The host half (`src/index.ts`) is TypeScript and is compiled by the local
// `tsc`, which emits `lib/index.js` plus `lib/types/`. The browser half
// (`src/client.js`) is NOT a module: it is the verbatim body of a
// `window.__ModuleLoader__.load({ id, factory })` call, so it is copied
// byte-for-byte and never passed through a bundler or a transpiler.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const lib = join(root, 'lib');

rmSync(lib, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });

execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc')], {
  cwd: root,
  stdio: 'inherit',
});

copyFileSync(join(root, 'src', 'client.js'), join(lib, 'client.js'));

console.log('[dsh-worktree-session] built: lib/index.js, lib/types/index.d.ts, lib/client.js');
