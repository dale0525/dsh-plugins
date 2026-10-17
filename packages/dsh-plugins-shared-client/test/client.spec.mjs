import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const stylesheetSource = readFileSync(join(root, 'src', 'theme.css'), 'utf8')

/**
 * The compiled stylesheet, recovered from the built client half.
 *
 * `build.mjs` substitutes the placeholder with a JSON string literal, but the
 * bundler renames the binding it was assigned to, so the value is found by
 * shape (the one long string literal) rather than by variable name.
 */
function compiledCss() {
  let best = ''
  for (const match of clientSource.matchAll(/"((?:[^"\\]|\\.){500,})"/g)) {
    if (match[1].length > best.length) best = match[1]
  }
  assert.ok(best.length > 4000, 'the built client half must carry the inlined stylesheet')
  return JSON.parse(`"${best}"`)
}

test('patch row id equals the host half name', () => {
  // AGENTS.md flags this half as having no automated check: the aggregate patch
  // is assembled verbatim from this row, and the loader crashes the host with
  // `duplicate loader entry id` when two rows collide — but nothing verifies
  // that a row's id matches the `export const name` of the package it loads.
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`- id: ${plugin.name}\\b`))
  assert.match(patch, new RegExp(`name: '${manifest.name.replace(/[/@]/g, (c) => `\\${c}`)}'`))
})

test('client half registers under the package name', () => {
  // The other half AGENTS.md flags: the loader resolves a bundle by this id, so
  // a mismatch silently fails the browser half of every consumer.
  const id = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientSource)
  assert.ok(id, 'client.js must call window.__ModuleLoader__.load({ id })')
  assert.equal(id[1], manifest.name)
})

test('the host half is a plugin and declares no required service', () => {
  // The row exists so the module table gains this package, and the loader then
  // resolves a plugin from these exports: `Registry.resolve` accepts only a
  // function or an object with an `apply` method, so a module exporting neither
  // fails the row with `invalid plugin, expect function or object with an
  // "apply" method`. An `inject` entry the host cannot satisfy would instead
  // make cordis skip `apply` entirely.
  assert.equal(plugin.name, 'plugins-shared-client')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.inject, undefined)
})

test('the stylesheet is inlined and the build placeholder is substituted', () => {
  // The client half is one file consumed verbatim by the loader: it cannot
  // `require` a stylesheet and must not fetch one at runtime. A bundle that kept
  // the placeholder would ship with no styles and no error.
  assert.equal(clientSource.includes('__DSH_SHARED_CSS__'), false, 'the build placeholder must be substituted')
  assert.ok(compiledCss().length > 4000, 'the compiled stylesheet should be substantial')
})

test('the compiled stylesheet carries no Tailwind preflight', () => {
  // Preflight is a global reset. Injected into the host it repaints the host's
  // own components from inside a plugin.
  const css = compiledCss()
  for (const [label, re] of [
    ['universal box-sizing reset', /(^|[\s,}])\*[\s,]*::?[a-z-]+/m],
    ['::backdrop reset', /::backdrop/],
    ['html reset', /^html\s*\{/m],
    ['heading reset', /^h1,\s*h2,\s*h3/m],
    ['abbr reset', /abbr:where\(\[title\]\)/],
  ]) {
    assert.equal(re.test(css), false, `preflight leaked into the stylesheet: ${label}`)
  }
})

test('every rule is scoped to a class this package owns', () => {
  // This sheet is injected into a page the host already styles. Anything not
  // anchored on a `dsp-` class competes with the host at equal specificity, and
  // the base sheet is injected later, so the host wins silently. The only
  // permitted exception is the dark-mode prefix, which is still anchored on a
  // `dsp-` class after the attribute selector.
  const stripped = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...stripped.matchAll(/(^|\})\s*([^{}]+)\{/g)]
    .map((m) => m[2].trim())
    .filter((s) => s !== '' && !s.startsWith('@'))
  assert.ok(selectors.length >= 100, `expected the full component sheet, found ${selectors.length} rules`)
  for (const selector of selectors) {
    for (const part of selector.split(',')) {
      const trimmed = part.trim()
      const scoped = trimmed.startsWith('body[data-ds-dark-theme] ')
        ? trimmed.slice('body[data-ds-dark-theme] '.length)
        : trimmed
      assert.match(scoped, /^\.dsp-/, `selector escapes this package's namespace: ${trimmed}`)
    }
  }
})

test('every colour resolves from a token, not a literal', () => {
  // Colour must come from the token layer so one stylesheet serves both
  // palettes. A literal here would silently pin dark mode to the light palette.
  // The shadow tints in the elevation stack are the exception: they are alpha
  // black, which reads correctly on both palettes.
  const stripped = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const declarations = [...stripped.matchAll(/(?:color|background-color|border-color|border-top-color|border-left-color):\s*([^;}]+)/g)]
    .map((m) => m[1].trim())
  assert.ok(declarations.length > 50, `expected the colour declarations, found ${declarations.length}`)
  for (const value of declarations) {
    assert.match(value, /var\(--dsw-|transparent|inherit/, `a literal colour would not follow the palette: ${value}`)
  }
})

test('the stylesheet source uses @apply rather than runtime utilities', () => {
  // The design's own utility strings are the source, resolved at build time.
  // Shipping them as runtime classes does not work: `content: []` means Tailwind
  // emits no utility classes at all, so the class name would match nothing.
  assert.ok(stylesheetSource.includes('@tailwind utilities'), 'the source must opt into Tailwind utilities')
  assert.ok(/@apply\s/.test(stylesheetSource), 'the source must resolve utilities with @apply')
})

test('activation rewrites the style tag instead of skipping when it exists', () => {
  // Client HMR replaces the plugin fiber without re-running boot. An
  // "already exists → skip" guard therefore makes every later CSS change
  // invisible until a manual page refresh — measured: the new rules matched 0
  // places in the live stylesheet while the tests stayed green.
  assert.match(clientSource, /tag\.textContent = CSS/, 'activation must rewrite the tag content')
  assert.equal(
    /querySelector\(\s*['"]style\[data-tag/.test(clientSource),
    false,
    'the guard must not be the "skip when present" form',
  )
})

test('the package declares the client contract the loader reads', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  // `clientExportOf` accepts a plain string; a `dsh.client.external` entry
  // naming this package itself would throw a module-graph cycle error.
  assert.equal(manifest.dsh?.client?.external, undefined)
  // `clientExportOf` accepts a plain string or an object whose `default` is a
  // string; the object form is what carries the declaration file to TypeScript
  // consumers, and the loader reads `.default` from it.
  const client = manifest.exports?.['./client']
  assert.equal(typeof client === 'string' ? client : client?.default, './lib/client.js')
})
