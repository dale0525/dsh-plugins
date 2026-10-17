/**
 * Build.
 *
 * Three steps, in this order:
 *
 *  1. `tsdown` bundles `src/client/index.tsx` into the loader-wrapped
 *     `lib/client.js`. That file still contains the literal identifier
 *     `__DSH_SHARED_CSS__`, which is a free variable in the bundle.
 *  2. The Tailwind CLI compiles `src/theme.css`. Tailwind runs here, at build
 *     time, and never reaches the browser: the stylesheet is one plain CSS
 *     string inlined into the bundle below. `content: []` means the only
 *     utilities that survive are the ones named in `@apply`, so there is no
 *     utility class in the output that could collide with the host's own.
 *  3. `tsc` emits the host half (`lib/index.js` + `lib/types/`).
 *
 * The stylesheet is substituted as a JSON string literal, and the substitution
 * is asserted: without the placeholder check, a bundle that stopped carrying it
 * would ship with no styles at all and no error.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const libDir = join(root, 'lib')
const PLACEHOLDER = '__DSH_SHARED_CSS__'
const require = createRequire(import.meta.url)

function run(script, args) {
  execFileSync(process.execPath, [join(root, ...script), ...args], { cwd: root, stdio: 'inherit' })
}

/**
 * `tsdown`'s bin path comes from its own manifest rather than a hard-coded
 * `dist/run.js`: the file is `run.mjs` in 0.22 and the name has moved before.
 */
function runTsdown() {
  const manifestPath = require.resolve('tsdown/package.json')
  const { bin } = require(manifestPath)
  const rel = typeof bin === 'string' ? bin : bin.tsdown
  execFileSync(process.execPath, [join(dirname(manifestPath), rel)], { cwd: root, stdio: 'inherit' })
}

async function compileStylesheet() {
  const out = join(root, 'node_modules', '.cache', 'shared-client.css')
  run(['node_modules', 'tailwindcss', 'lib', 'cli.js'], [
    '-c',
    'tailwind.config.cjs',
    '-i',
    'src/theme.css',
    '-o',
    out,
  ])
  return readFile(out, 'utf8')
}

/**
 * The host owns the page reset. If Tailwind's preflight ever leaks in, it would
 * rewrite every element on the page from inside a plugin.
 */
function assertNoPreflight(css) {
  const signatures = [
    ['universal box-sizing reset', /(^|[\s,}])\*[\s,]*::?[a-z-]+/m],
    ['::backdrop reset', /::backdrop/],
    ['html reset', /^html\s*\{/m],
    ['heading reset', /^h1,\s*h2,\s*h3/m],
    ['abbr reset', /abbr:where\(\[title\]\)/],
  ]
  const offenders = signatures.filter(([, re]) => re.test(css)).map(([name]) => name)
  if (offenders.length > 0) {
    throw new Error(
      `preflight leaked into the compiled stylesheet (${offenders.join(', ')}). ` +
        'Check `corePlugins.preflight` in tailwind.config.cjs.',
    )
  }
}

await rm(libDir, { recursive: true, force: true })
await mkdir(libDir, { recursive: true })
await mkdir(join(root, 'node_modules', '.cache'), { recursive: true })

runTsdown()

const css = await compileStylesheet()
assertNoPreflight(css)

const bundlePath = join(libDir, 'client.js')
const bundle = await readFile(bundlePath, 'utf8')
if (!bundle.includes(PLACEHOLDER)) {
  throw new Error(`lib/client.js is missing the ${PLACEHOLDER} placeholder`)
}
// A function replacement, not a string: `$&` and friends are special in a
// string replacement and CSS is not guaranteed to be free of them.
await writeFile(bundlePath, bundle.replace(PLACEHOLDER, () => JSON.stringify(css)))

run(['node_modules', 'typescript', 'bin', 'tsc'], ['-p', 'tsconfig.build.json'])

console.log(`[dsh-plugins-shared-client] built: ${libDir}`)
