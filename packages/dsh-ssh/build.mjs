/**
 * dsh-ssh build: bundle the host half, copy the browser half verbatim.
 *
 * ## Why the host half is bundled rather than copied
 *
 * `ssh2` ships an `install` script that tries to compile an OPTIONAL native
 * crypto binding with node-gyp. The binding is optional — `lib/protocol/crypto.js`
 * wraps its `require` in `try {} catch {}` and falls back to the pure-JS
 * implementation, which is what actually runs here (verified: exec and SFTP both
 * work with the binding absent). But pnpm 12 refuses to run ANY dependency script
 * it has not been told about, and its refusal is fatal for the whole install:
 *
 *   ERR_PNPM_IGNORED_BUILDS
 *   Ignored build scripts: cpu-features@0.0.10, ssh2@1.17.0
 *
 * That failure is not something this package can prevent from its own manifest.
 * `dependenciesMeta.<pkg>.built: false` was tried and does not suppress it;
 * `pnpm.neverBuiltDependencies` was tried and does not either. The policy lives
 * in the CONSUMER's `pnpm-workspace.yaml` (`allowBuilds`), which for a DSH plugin
 * is the user's profile directory — and the profile only records a pending
 * decision AFTER an install has already failed.
 *
 * So every user installing this plugin would hit a failed install and have to
 * approve a build script for a binding nobody needs. Bundling `ssh2` in removes
 * the dependency edge entirely: the published package has NO runtime
 * dependencies, so there is no script to approve and nothing to go wrong on a
 * machine without a C++ toolchain.
 *
 * ## What stays external
 *
 * The host packages (`@deepseek-ai/*`) stay bare: cordis identifies services by
 * module identity, so a second copy of `dsh-tools` or `schemastery` inside this
 * bundle would be a different class than the host's, and `defineTool` results
 * would be rejected by a registry that does not recognize them. They are
 * optional peers, resolved from the profile's install tree.
 *
 * `cpu-features` is external as well, and that is deliberate rather than an
 * oversight: ssh2 loads it inside `try/catch` to size its cipher cache, so a
 * missing module is the normal case. Marking it external keeps the `require`
 * inside that guard instead of inlining a module that cannot exist.
 *
 * Usage: `node build.mjs`.
 */
import { cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const libDir = join(root, 'lib');

await rm(libDir, { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src', 'index.js')],
  outfile: join(libDir, 'index.js'),
  bundle: true,
  // ESM, and the `.js` extension that `"type": "module"` already implies.
  //
  // This was a CJS bundle first, and that shape broke the plugin in a real host:
  // bundling to CJS turns every external into `require()`, so the entry called
  // `require('@deepseek-ai/dsh-tools')` on a package that is ESM. Node answers
  // that with `ERR_REQUIRE_ESM_RACE_CONDITION` — "not yet fully loaded" — when
  // the host happens to be loading that module at the same moment, and the
  // loader's response to a failed import is to drop the plugin. The symptom was
  // the plugin mounting nothing at all in `dsh web`, while every unit test
  // passed because there the host packages were already resolved.
  //
  // ESM output emits real `import` statements for the externals instead, which
  // the ESM loader handles correctly regardless of timing.
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Host packages stay bare: module identity is what cordis keys services by.
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/schemastery',
    'cpu-features',
  ],
  // `ssh2` is CommonJS and is bundled IN, so its own `require()` calls and its
  // `__dirname` lookups still have to work inside an ESM file. These three
  // bindings restore them for the bundled code only; nothing outside the bundle
  // sees them.
  banner: {
    js: [
      "import { createRequire as __dshCreateRequire } from 'node:module';",
      "import { fileURLToPath as __dshFileURLToPath } from 'node:url';",
      "import { dirname as __dshDirname } from 'node:path';",
      'const require = __dshCreateRequire(import.meta.url);',
      'const __filename = __dshFileURLToPath(import.meta.url);',
      'const __dirname = __dshDirname(__filename);',
    ].join(' '),
  },
  // The one thing bundling must not do is minify the dependency into
  // unreadable output: a stack trace from a failed connection is the primary
  // diagnostic, and it has to name ssh2's own functions.
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

// The browser half is already in the client loader's protocol; it is copied.
await cp(join(root, 'src', 'client.js'), join(libDir, 'client.js'));

console.log(`[dsh-ssh] built: ${libDir}`);
