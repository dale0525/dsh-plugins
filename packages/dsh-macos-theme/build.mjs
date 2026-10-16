/**
 * dsh-macos-theme build script.
 *
 * Three steps, in order:
 *
 *  1. **Compile `src/theme.css`** through Tailwind. Tailwind is used as a
 *     compile-time utility resolver only: the stylesheet writes the design's own
 *     utility strings inside `@apply`, and `content: []` means nothing else is
 *     emitted. The result is plain CSS; Tailwind never ships to the browser.
 *  2. **Inline that CSS into the client half.** `src/client.js` carries a
 *     `__DSH_MACOS_THEME_CSS__` placeholder because it is a single file that the
 *     client module loader consumes verbatim — it cannot `require` the
 *     stylesheet, and a separate asset would have to be fetched at runtime.
 *  3. **Compile the host half** with `tsc` and copy the client half to `lib/`.
 *
 * `lib/` is not version-controlled (see `.gitignore`); a fresh clone builds it
 * through `prepare`/`prepack`.
 *
 * The two halves need different treatment: `src/index.ts` is the host half and
 * goes through `tsc` (declarations land in `lib/types/`, matching the `types`
 * field). `src/client.js` is the browser half and is already in the client
 * module loader's protocol — it is not a module, imports nothing, and calls
 * `window.__ModuleLoader__.load` at top level. `tsc` never sees it (it is not
 * imported by the host half, and `allowJs` is off).
 *
 * Usage: `node build.mjs` (also run by `prepare`, `prepack`, and `test`).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const libDir = join(root, 'lib');
const PLACEHOLDER = '__DSH_MACOS_THEME_CSS__';

/** Compile `src/theme.css` to plain CSS through the local Tailwind CLI. */
function compileStylesheet() {
  const out = join(root, 'node_modules', '.cache', 'macos-theme.css');
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
      '-c',
      join(root, 'tailwind.config.cjs'),
      '-i',
      join(root, 'src', 'theme.css'),
      '-o',
      out,
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return readFile(out, 'utf8');
}

/**
 * Guard the one property that makes this stylesheet safe to inject into a host
 * that is already styled: Tailwind's preflight must never be in the output.
 *
 * Measured damage with it on was 7 of 14 probes — `svg` baseline to middle,
 * `img` max-width to 100%, body line-height normal to 24px, button font-size
 * 13.33px to 14px, sidebar row border none to solid, input box 4x20 to 0x18,
 * table height 557 to 535. `corePlugins.preflight = false` prevents it; this
 * check catches a config regression that would silently repaint the host.
 *
 * Detection is by preflight's own selectors, not by the declarations they set:
 * the stylesheet legitimately sets `box-sizing: border-box` on `body` alone, and
 * a declaration-level check cannot tell that apart from preflight's global
 * `*, ::before, ::after` reset.
 */
function assertNoPreflight(css) {
  const signatures = [
    ['universal box-sizing reset', /(^|[\s,}])\*[\s,]*::?[a-z-]+/m],
    ['::backdrop reset', /::backdrop/],
    ['html reset', /^html\s*\{/m],
    ['heading reset', /^h1,\s*h2,\s*h3/m],
    ['abbr reset', /abbr:where\(\[title\]\)/],
  ];
  const offenders = signatures.filter(([, re]) => re.test(css)).map(([name]) => name);
  if (offenders.length > 0) {
    throw new Error(
      `preflight leaked into the compiled stylesheet (${offenders.join(', ')}). ` +
        'Check `corePlugins.preflight` in tailwind.config.cjs.',
    );
  }
}

await rm(libDir, { recursive: true, force: true });
await mkdir(libDir, { recursive: true });
await mkdir(join(root, 'node_modules', '.cache'), { recursive: true });

const css = await compileStylesheet();
assertNoPreflight(css);

const clientSource = await readFile(join(root, 'src', 'client.js'), 'utf8');
if (!clientSource.includes(PLACEHOLDER)) {
  throw new Error(`src/client.js is missing the ${PLACEHOLDER} placeholder`);
}
// A function replacement, not a string: `$&` and friends are special in a
// string replacement and CSS is not guaranteed to be free of them.
await writeFile(
  join(libDir, 'client.js'),
  clientSource.replace(PLACEHOLDER, () => JSON.stringify(css)),
);

execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc')], {
  cwd: root,
  stdio: 'inherit',
});

console.log(
  `[dsh-macos-theme] built: ${libDir} (stylesheet ${css.length} B, no preflight)`,
);
