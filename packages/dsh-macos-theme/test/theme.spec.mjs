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
 * The compiled stylesheet, recovered from the built client half. `build.mjs`
 * inlines it as a JSON string literal assigned to `var CSS`.
 */
function compiledCss() {
  const match = /var CSS = ("(?:[^"\\]|\\.)*")/.exec(clientSource)
  assert.ok(match, 'the built client half must carry the inlined stylesheet')
  return JSON.parse(match[1])
}

/**
 * The compiled stylesheet as (selector list, body) pairs. `@media` blocks nest
 * rules, so a selector can be preceded by `{` as well as `}`; the run between
 * braces covers both.
 */
function compiledRules() {
  const stripped = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()),
    body: m[2],
  }))
}

/**
 * Every declaration that applies to an exact selector, merged in source order.
 * A surface is usually split across rules (one sets the face, another the
 * weight), so the effective value is the merge, not the last rule alone.
 */
function lastRule(selector) {
  const bodies = compiledRules()
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body)
  return bodies.length === 0 ? undefined : bodies.join('\n')
}

test('host half exports the plugin surface the loader needs', () => {
  assert.equal(plugin.name, 'macos-theme')
  assert.equal(typeof plugin.apply, 'function')
})

test('host half declares no required service', () => {
  // The theme is browser-only. An `inject` entry the host cannot satisfy makes
  // cordis skip `apply` entirely, which would silently drop the whole plugin.
  assert.equal(plugin.inject, undefined)
})

test('patch row id equals the host half name', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`- id: ${plugin.name}\\b`))
})

test('client half registers under the package name', () => {
  // The loader resolves a bundle by this id; a mismatch fails the browser half.
  const id = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(id, 'client.js must call window.__ModuleLoader__.load({ id })')
  assert.equal(id[1], manifest.name)
})

test('client half declares the web platform', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
})

test('every overridden token carries both palettes', () => {
  // `overrideTokens` picks one value per active color scheme; a token missing a
  // scheme resolves to `undefined` and the presenter writes nothing, leaving
  // that element on the base theme's colour.
  const block = clientSource.slice(clientSource.indexOf('var TOKENS = {'))
  const body = block.slice(0, block.indexOf('\n    }'))
  const entries = [...body.matchAll(/'(--[\w-]+)':\s*\{\s*light:\s*'([^']*)',\s*dark:\s*'([^']*)'\s*\}/g)]
  assert.ok(entries.length > 80, `expected the full palette, found ${entries.length} tokens`)
  for (const [, name, light, dark] of entries) {
    assert.ok(light.length > 0, `${name} has an empty light value`)
    assert.ok(dark.length > 0, `${name} has an empty dark value`)
  }
})

test('every overridden token name exists in the base theme', () => {
  // An unknown name injects a variable nothing reads: the intent silently does
  // nothing. The fixture is the live `getComputedStyle(document.body)` inventory
  // of the host generation this package targets (0.2.0-rc.2).
  const known = new Set(JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'base-tokens.json'), 'utf8')))
  // `--dsw-alias-bg-layer-4` is the one deliberate exception, and it is the
  // opposite of inert: the host CONSUMES it (settings form fields, the settings
  // subagent page, the frontend bundle) but defines it nowhere, so the
  // declaration resolves to nothing and those surfaces paint their fallback.
  // Overriding it supplies the missing value; dropping it to satisfy this list
  // would reintroduce the host's bug. Verified against the installed host with
  // `grep -rl 'var(--dsw-alias-bg-layer-4)' node_modules/@deepseek-ai` (3 files)
  // vs `grep -rl -- '--dsw-alias-bg-layer-4:'` (0 files).
  const suppliedByUs = new Set(['--dsw-alias-bg-layer-4'])
  const block = clientSource.slice(clientSource.indexOf('var TOKENS = {'))
  const body = block.slice(0, block.indexOf('\n    }'))
  const names = [...body.matchAll(/'(--[\w-]+)':/g)].map((m) => m[1])
  const unknown = names.filter((n) => !known.has(n) && !suppliedByUs.has(n))
  assert.deepEqual(unknown, [], `unknown tokens would be inert: ${unknown.join(', ')}`)
  // The exception is only justified while it stays an exception.
  for (const name of suppliedByUs) {
    assert.ok(names.includes(name), `${name} is listed as host-undefined but is no longer overridden`)
    assert.equal(known.has(name), false, `${name} now exists upstream; drop it from the exception list`)
  }
})

test('the compiled stylesheet is inlined, not fetched at runtime', () => {
  // The client half is a single file consumed verbatim by the module loader: it
  // cannot `require` a stylesheet and must not fetch one at runtime.
  assert.equal(clientSource.includes('__DSH_MACOS_THEME_CSS__'), false, 'the build placeholder must be substituted')
  assert.ok(compiledCss().length > 4000, 'the compiled stylesheet should be substantial')
})

test('the compiled stylesheet carries no Tailwind preflight', () => {
  // Preflight is a global reset. Injected into the host it repaints the host's
  // own components — measured damage was 7 of 14 probes (`svg` baseline to
  // middle, `img` max-width to 100%, body line-height normal to 24px, button
  // font-size 13.33 to 14px, sidebar row border none to solid, input box 4x20 to
  // 0x18, table height 557 to 535). `build.mjs` asserts this too; the test keeps
  // it true for the committed artifact as well.
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

test('the stylesheet resolves colours from tokens, not literals', () => {
  // Colour must come from the token layer so one stylesheet serves both
  // palettes. A regression that hard-codes the light values here would silently
  // pin dark mode to the light palette.
  const css = compiledCss()
  for (const token of [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    '--dsw-specific-sidebar-fill',
    '--dsw-alias-border-l3',
    '--dsw-alias-label-tertiary',
  ]) {
    assert.ok(css.includes(`var(${token})`), `the stylesheet should resolve ${token}`)
  }
})

test('structural CSS avoids build-hashed class names', () => {
  // CSS-module class names are derived from the build's absolute source path
  // (`Wcetya_*` locally, `A55DgG_*` in CI), so anchoring on a full class name
  // works in exactly one build. Only the `_localName` suffix is stable.
  const fullClass = /\[class[~^|*$]?=\s*["'][A-Za-z0-9_-]{5,}_[A-Za-z]/.exec(compiledCss())
  assert.equal(fullClass, null, `CSS anchors on a hashed class name: ${fullClass?.[0]}`)
})

test('every rule targets a build-stable anchor', () => {
  // A rule anchored on nothing stable either matches nothing after a rebuild or,
  // worse, matches the wrong node silently. `md-code-block` is a hard-coded
  // literal in the host's markdown renderer (`className: ue(rn.block,
  // "md-code-block", ...)`), so it is stable despite looking like a class name.
  const stable = /data-|class\*=|class\^=|^body|^html|^div:has|^\.md-code-block|^\.dsh-easyrewrite-bubble/
  // Strip comments first: the build keeps them, and a comment before a rule
  // would otherwise be read as part of its selector.
  // Keyframes are stripped whole: their steps (`28%, 72% { … }`) are offsets, not
  // selectors, and would otherwise be read as rules anchored on nothing.
  const stripped = compiledCss()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '')
  const rules = [...stripped.matchAll(/(^|\})\s*([^{}]+)\{/g)].map((m) => m[2].trim())
  assert.ok(rules.length >= 25, `expected the structural rules, found ${rules.length}`)
  for (const selector of rules) {
    if (selector.startsWith('@') || selector === '') continue
    assert.match(selector, stable, `selector uses no stable anchor: ${selector}`)
  }
})

test('bordered components restore border-style without a global reset', () => {
  // `@apply border` emits only `border-width`; preflight is what normally
  // supplies `border-style: solid`. With preflight off, every bordered component
  // rendered with an invisible border — measured `border-style: none` on the
  // frame, sidebar, header, selected row, active tab, thinking bar and composer.
  // The compensation must stay scoped: a blanket `border-style: solid` would give
  // the three sides of a single-side divider the initial `medium` (3px) width.
  //
  // Asserting that `border-style: solid` merely *exists* let a real regression
  // through: the sidebar workspace cards were added with `@apply border` but
  // without a slot in the compensation list, so they rendered `border-width: 1px`
  // with `border-style: none` — measured `border=0px` on the live sidebar while
  // this test stayed green. The list itself is the contract, so it is read.
  const css = compiledCss()
  assert.equal(/^\s*\*[^{]*\{[^}]*border-style/s.test(css), false, 'border-style must not be a global reset')
  // Read the list from the comment-stripped copy: the comments above this test
  // and the source block both contain the literal `border-style: solid`, and a
  // match inside a comment would satisfy the assertion no matter what the
  // selector list actually says.
  const list = /([^{}]*)\{[^}]*border-style:\s*solid/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  assert.ok(list, 'the bordered components need border-style restored')
  assert.match(
    list[1],
    /\[class\*='groupSection'\]:has\(> \* > \[data-row-key\^='workspace:'\]\)/,
    'the sidebar workspace cards carry a border and must be in the compensation list',
  )
})

test('no rule declares a backdrop-filter', () => {
  // The design export draws the frame as `backdrop-blur-2xl bg-white/95`, and
  // that blur was implemented as `backdrop-filter: blur(40px) saturate(160%)` on
  // the frame. It is not a constant cost: it makes the whole 1368x897 frame
  // (2736x1794 device px at 2x) a backdrop root, so it re-runs a 40px gaussian
  // over the entire window on EVERY frame in which anything inside repaints.
  // Measured on the live host with the Chrome GPU process idle at 0%:
  //   pet video only ...........................  7.5%
  //   state-dot spinner only ................... 14.3%
  //   both ..................................... 20.0%
  //   both, frame blur restored ................ 25.1%
  // and with this stylesheet removed entirely the spinner alone still costs
  // 12.1%, so the spinner is the host's cost and the blur was the theme's.
  //
  // Removing it is invisible because the fill is 95% opaque: frozen-page
  // captures with and without the filter differ by 0.58/255 mean per channel,
  // and the only pixels differing by more than 8/255 (0.74% of channels) are
  // under translucent popups, which sample the frame's composite through their
  // own blur.
  //
  // Comments are stripped first: the block comment above the frame rule names
  // the property, and a match inside it would satisfy nothing.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  for (const declaration of [/backdrop-filter\s*:/, /-webkit-backdrop-filter\s*:/, /--tw-backdrop-/]) {
    assert.equal(
      declaration.test(css),
      false,
      `a backdrop-filter re-appears in the compiled sheet: ${declaration}`,
    )
  }
  const frame = /body \[data-slot='root'\] > div\s*\{([^}]*)\}/.exec(css)
  assert.ok(frame, 'the frame must stay addressed by its stable slot anchor')
  assert.match(frame[1], /background-color:\s*rgba\(248, 250, 252, 0\.95\)/, 'the frame keeps its 95% fill')
})

test('the conversation header is restyled as a single grid row', () => {
  // The host ships a 76px two-row grid. Measured: a single row with
  // `grid-template-columns: minmax(0,1fr) auto` and the tabs pinned to column 2
  // yields a 57px header with the title still 917px wide. `display: flex` was
  // measured collapsing the title to 0px, so the grid form is load-bearing.
  const css = compiledCss()
  const rule = /body header\[data-window-drag\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the header must be targeted by its stable data attribute')
  assert.match(rule[1], /display:\s*grid/, 'the header must use grid, not flex')
  assert.match(rule[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/, 'the title column must be able to shrink')
  assert.ok(css.includes('[class*=\'_titleRow\']'), 'the title row must be pinned to the grid')
})

test('the tab strip is hidden, anchored on its data attribute', () => {
  // `_tabs` is a CSS-module suffix; the host also publishes the stable
  // `data-conversation-tabs` attribute, which cannot drift with the build.
  // The strip is hidden rather than styled: measured live, it is 104px wide at
  // x=1243 while the sidebar toggle sits at x=1231–1259, so it covered the
  // toggle with a 16px overlap.
  const css = compiledCss()
  const rule = /body \[data-conversation-tabs\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'tabs should anchor on [data-conversation-tabs]')
  assert.match(rule[1], /display:\s*none/, 'the tab strip must be hidden')
  assert.equal(/\[class\*=["']_tabs["']\]/.test(css), false, 'tabs must not anchor on the `_tabs` class suffix')
})

test('the trajectory view is closed off, and a stuck session returns to chat', () => {
  // The strip is hidden above, so the last way into the trajectory View is a tool
  // row's 「查看」 button: it calls the host's `inspectCall`, which opens that View
  // with a focus target. Measured live: one click on a `read` row flipped the strip
  // to 轨迹, rendered the trajectory ledger, and persisted `view: "trajectory"` in
  // the session's store — with no control left that leads back to 对话. So the
  // affordance is hidden, and the browser half re-selects the chat tab whenever the
  // strip reports another View (a preference persisted before this rule shipped, or
  // any path the host adds later).
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(
    css,
    /body \[class\*='_inspectButton'\]\s*\{[^}]*display:\s*none/,
    'the inspect affordance is the last entry point into the View',
  )

  assert.match(clientSource, /function keepChatView\(\)/, 'the View must be repaired by the browser half')
  const body = /function keepChatView\(\) \{[\s\S]*?\n    \}/.exec(clientSource)
  assert.ok(body, 'the repair must resolve to one function')
  assert.match(body[0], /\[data-conversation-tabs\] \[role='tab'\]/, 'the strip is the stable anchor')
  // The tab carries no id or data attribute, so its label is the only handle; both
  // locales must be listed or the repair silently never fires in one of them.
  for (const label of ['对话', 'Chat']) {
    assert.ok(body[0].includes(`'${label}'`), `${label} must be recognised as the chat tab`)
  }
  assert.match(body[0], /aria-selected/, 'the selected tab is what tells the Views apart')
  assert.match(body[0], /\.click\(\)/, 'the repair drives the tab the user would have clicked')
  assert.match(body[0], /new MutationObserver/, 'the selection is re-rendered, so the repair must observe')
  assert.match(
    clientSource,
    /ctx\.effect\(keepChatView,/,
    'the repair must be registered as a disposable effect',
  )
})

test('the substring-matched selectors are qualified to the element they mean', () => {
  // `[class*='x']` is a substring match, so it also matches every descendant
  // whose class contains the same local name. Both of these were measured
  // over-matching and restyling nested spans:
  //   `[class*='_newSession']` matched 5 elements (the button plus
  //   `_newSessionLabelMask`, `_newSessionContent`, `_newSessionLabel`,
  //   `_newSessionShortcut`), forcing 32px onto the label span and pushing its
  //   ink 5px above the button's centre;
  //   `[class*='_trigger']` matched 7 (5 nested: `_triggerIcon`, `_triggerLabel`,
  //   `_triggerEffort`, …), applying `px-3` to the icon and label.
  // Qualifying each with `button` measured n=1 / n=2 with 0 nested matches.
  const css = compiledCss()
  assert.ok(
    css.includes("body [data-slot='sidebar'] button[class*='_newSession']"),
    'the new-session button rule must be qualified to the button element',
  )
  assert.equal(
    /body \[class\*='_newSession'\]\s*\{/.test(css),
    false,
    'the unqualified new-session selector must be gone — it matched 4 nested descendants',
  )
  assert.ok(
    css.includes("body [data-composer-card] button[class*='_trigger']"),
    'the composer chip rule must be qualified to the button element',
  )
  assert.equal(
    /body \[data-composer-card\] \[class\*='_trigger'\]\s*\{/.test(css),
    false,
    'the unqualified composer chip selector must be gone — it matched 5 nested spans',
  )
})

test('the composer chips carry the design fill and the send button is re-centred', () => {
  // 完全权限 and 主检出 are two *different* host components — 完全权限 is a
  // 13px/500 `_trigger`, 主检出 a 12px/400 `_ghost_ _sm_` button with no
  // background at all — so the design's single chip fill has to be applied here.
  // The send button separately carries a host `translateY(-2px)` and the row an
  // asymmetric `padding: 2px 8px 6px`, which together put the 34px button's
  // centre at cy=836 while every other control in the row sat at cy=838.
  const css = compiledCss()
  const chip = /body \[data-composer-card\] button\[class\*='_trigger'\][^{]*\{([^}]*)\}/.exec(css)
  assert.ok(chip, 'the chips must be styled')
  assert.match(chip[1], /background-color:\s*#f1f5f9/, 'the chips need the design grey fill')
  assert.match(chip[1], /height:\s*1\.75rem/, 'the chips must be 28px tall (h-7)')
  // 主检出 carries no `_trigger` class at all (it is a `_ghost_ _sm_` button), so
  // the slot it lives in is what anchors it to the same chip treatment.
  assert.ok(
    css.includes("body [data-composer-card] [data-slot='conversation.input.left'] button"),
    '主检出 must be anchored through its slot, not a class it does not have',
  )
  // The model pill's design hover (`hover:bg-blue-100`).
  assert.match(
    css,
    /body \[data-composer-card\] \[class\*='_standardControls'\] button\[class\*='_trigger'\]:hover\s*\{[^}]*background-color:\s*#dbeafe/,
    "the model pill needs the design's hover fill",
  )

  // The pill holds the model name AND 推理等级 in ONE button, and the host nests
  // both as spans whose class names (`_triggerLabel`, `_triggerEffort`) contain
  // `_trigger` as a substring. A substring match without the `button` qualifier
  // therefore paints each span as its own pill: measured, hovering turned the
  // button and the label `#dbeafe` while the effort span stayed `#eff6ff` and
  // showed through as a lighter block. The design draws one pill, so every
  // `_trigger` rule in the composer must be qualified to the button.
  const unqualified = [...css.matchAll(/(^|\})\s*([^{}]*\[class\*='_trigger'\][^{}]*)\{/g)]
    .map((m) => m[2].trim())
    .filter((selector) => !/button\[class\*='_trigger'\]/.test(selector))
  assert.deepEqual(
    unqualified,
    [],
    `every _trigger rule must be qualified to the button, or it paints the nested spans: ${unqualified.join(' | ')}`,
  )
  // The chips carry a literal light fill, so the dark palette must re-point it;
  // without this they stay #f1f5f9 on a dark card. The merged card needs no
  // override — its fill and border come from tokens that already adapt.
  assert.match(
    css,
    /body\[data-ds-dark-theme\] \[data-composer-card\] button\[class\*='_trigger'\][^{]*\{[^}]*background-color:\s*rgba\(255, 255, 255, 0\.08\)/,
    'the chip fill must be re-pointed for the dark palette',
  )
  const send = /body \[data-composer-card\] \[class\*='_primary'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(send, 'the send button must be styled')
  assert.match(send[1], /transform:\s*none/, "the send button must drop the host's translateY(-2px)")
  const row = /body \[data-composer-card\] \[class\*='_row'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(row, 'the composer bottom row must be styled')
  assert.match(row[1], /padding-top:\s*0/, "the row's asymmetric padding must be neutralised")
  assert.match(row[1], /padding-bottom:\s*0/, "the row's asymmetric padding must be neutralised")
})

test('adjacent thinking and tool calls render as a bounded merged card', () => {
  // The host already merges adjacent thinking steps and tool calls into one
  // `[data-step-process]` group per run (measured 145 groups live), each a bare
  // 20px summary line. The design's card chrome is what was missing. The height
  // bound is the host's own: measured on an 8-member group the expanded body
  // carries `max-height: 400px; overflow-y: auto`, so it scrolls instead of
  // growing without limit — this rule must not re-declare a cap of its own.
  const css = compiledCss()
  const rule = /body \[data-step-process\]:not\(\[hidden\]\)\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the merged process group must be styled as a card')
  assert.match(rule[1], /border-radius:\s*12px/, 'the card needs the design radius')
  assert.match(rule[1], /border-color:\s*var\(--dsw-alias-border-l3\)/, 'the card border must come from a token')
  assert.match(rule[1], /background-color:\s*var\(--dsw-alias-bg-layer-2\)/, 'the card fill must come from a token')
  // `:not([hidden])` is load-bearing: the conversation is virtualized, and an
  // off-screen group is a `hidden="until-found"` placeholder with a 0px box, so
  // padding on it produced a phantom 8px row for each of the 26 placeholders.
  assert.equal(
    /body \[data-step-process\]\s*\{/.test(css),
    false,
    'the unconditional card rule must be gone — it padded the virtualized placeholders',
  )
})

test('the chat status surfaces carry no violet, indigo or purple', () => {
  // The user asked for the three chat status surfaces (merged process cards, the
  // 深度求索中 hint, the 已完成 pill) to match the theme's macOS slate + black-blue
  // palette. Every one of them previously carried a violet/indigo literal, taken
  // from the older design exports: the thinking card was a `#F5F3FF → #ffffff`
  // gradient with an `#e0e7ff` border, the completed pill was `rgba(139,92,246,
  // 0.08)` with `#6d28d9` text, and the running hint inherited indigo `#4338CA`
  // from `--dsw-alias-label-deep-diving`.
  //
  // The new design (`d5bb5fb1a2144c029900c8d113017d79`) removes all of them, so
  // this pins the whole family at once: any violet literal reappearing anywhere
  // in the compiled sheet fails here, whichever selector it arrives through.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const violet = [
    '#8b5cf6', '#6d28d9', '#4338ca', '#e0e7ff', '#f5f3ff',
    '#6366f1', '#7c3aed', '#a78bfa', '#c4b5fd', '#4c1d95',
  ]
  const found = violet.filter((hex) => new RegExp(hex, 'i').test(css))
  assert.deepEqual(
    found,
    [],
    `the status surfaces must use the theme palette, not violet: ${found.join(', ')}`,
  )
  assert.equal(
    /139,\s*92,\s*246/.test(css),
    false,
    'the violet rgb() form must be gone too — the completed pill used it',
  )
})

test('the three chat status surfaces share the theme palette', () => {
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')

  // 1. The completed pill: neutral slate fill, slate text (was violet).
  const pill = /body \[data-turn-process\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(pill, 'the completed pill must have its own rule')
  assert.match(pill[1], /background-color:\s*#f1f5f9/, 'the pill takes the design slate fill')
  assert.match(pill[1], /border-color:\s*rgba\(15, 23, 42, 0\.08\)/, 'the pill takes the hairline border')
  const pillLabel = /body \[data-turn-process\] \[class\*='_label'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(pillLabel, 'the pill label must be styled')
  assert.match(pillLabel[1], /color:\s*#475569/, 'the pill label is slate, not violet')

  // 2. The running hint: the theme's blue, replacing the host's indigo token.
  const running = /body \[data-chat-running\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(running, 'the running hint must be re-pointed')
  assert.match(running[1], /color:\s*#2563eb/, '深度求索中 takes the theme blue')
  // The sweep is a separate token that paints its own spans, so it needs its own
  // rule rather than inheriting the row colour.
  assert.match(
    css,
    /body \[data-chat-running\] \[class\*='_sweep'\][^{]*\{[^}]*color:\s*#93c5fd/,
    'the animated sweep must be re-pointed where it lands',
  )

  // 3. The thinking group is not told apart at all any more. The header is label
  //    text only, so there is no per-kind icon or accent left to colour; a card is
  //    distinguished by whether it is live, not by what kind of step it holds.
  assert.equal(
    /:has\(\[data-process-activity='thinking'\]\)/.test(css),
    false,
    'the per-kind header mark is gone — a card is coloured by its live state instead',
  )
})

test('the card header is the design header line: state mark, label, chevron, rule', () => {
  // The design (`c5764251d7be46239dacff5c161407f6`) gives the header a 16px state
  // mark, a 13px label and a chevron at the far right, under a hairline. The host
  // draws its own two marks in the leading slot and swaps them by `opacity` on
  // hover, focus and `[aria-expanded]`, so those are removed and the design's marks
  // are drawn on the slot and the button instead.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const hide = /body \[data-step-process\]:not\(\[hidden\]\) > div:first-child \[data-step-process-chevron\],\s*body \[data-step-process\]:not\(\[hidden\]\) > div:first-child \[data-step-process-icon\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(hide, 'the host marks must be removed from the flow')
  assert.match(hide[1], /display:\s*none/, 'the host marks must be hidden')

  // The leading slot is the design's 16px mark box.
  const leading = /body \[data-step-process\]:not\(\[hidden\]\) > div:first-child \[class\*='_leading'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(leading, 'the leading slot must be laid out again')
  assert.match(leading[1], /width:\s*16px/, 'the state mark is 16px wide')
  assert.match(leading[1], /height:\s*16px/, 'the state mark is 16px tall')
  assert.match(leading[1], /display:\s*inline-flex/, 'the slot must be a mark again, not hidden')

  // The mark is two stacked mask layers: the arc on `::before` (it spins) and the
  // resting check on `::after` (it sits on top, so a finished step can show its
  // check while the card's turn is still running underneath).
  const arc = /body \[data-step-process\]:not\(\[hidden\]\) > div:first-child \[class\*='_leading'\]::before\s*\{([^}]*)\}/.exec(css)
  assert.ok(arc, 'the live arc must be drawn on the slot')
  assert.match(arc[1], /mask-image:\s*var\(--dsh-card-arc\)/, 'the arc follows the card state')
  // Longhands, because the `animation` shorthand would reset the duration to `0s`
  // and name an animation that never runs — measured, that left the arc sitting
  // still as a half ring, which is the bug the user reported.
  assert.match(arc[1], /animation-name:\s*var\(--dsh-card-spin\)/, 'the arc spins from the card token')
  assert.match(arc[1], /animation-duration:\s*1\.1s/, 'the spin must actually take time')
  assert.match(arc[1], /animation-iteration-count:\s*infinite/, 'the spin must not stop after one turn')
  assert.equal(/animation:/.test(arc[1]), false, 'the shorthand must not be used here')
  // The colour is shared by both layers, so it is declared once on the pair.
  const layers = /body \[data-step-process\]:not\(\[hidden\]\) > div:first-child \[class\*='_leading'\]::before,\s*body \[data-step-process\]:not\(\[hidden\]\) > div:first-child \[class\*='_leading'\]::after\s*\{([^}]*)\}/.exec(css)
  assert.ok(layers, 'both mark layers must share their box')
  assert.match(layers[1], /background-color:\s*currentColor/, 'the mark takes the card icon colour')

  // The `::after` layer is declared twice — once in the shared box rule, once with
  // its own mask — so the layer rule is the one that names a mask.
  const rest = [...css.matchAll(/body \[data-step-process\]:not\(\[hidden\]\) > div:first-child \[class\*='_leading'\]::after\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .find((body) => /mask-image/.test(body))
  assert.ok(rest, 'the resting check must be its own layer')
  assert.match(rest, /mask-image:\s*var\(--dsh-card-mark\)/, 'the check is the resting mark')
  assert.match(rest, /opacity:\s*var\(--dsh-card-rest-opacity\)/, 'the check is shown only at rest')

  // The chevron comes back, at the far right, and points up only when expanded.
  const chevron = /body \[data-step-process\]:not\(\[hidden\]\) > div:first-child button\[data-process-activity\]::after\s*\{([^}]*)\}/.exec(css)
  assert.ok(chevron, 'the header must carry the design chevron')
  assert.match(chevron[1], /margin-left:\s*auto/, 'the chevron sits at the far right')
  assert.match(chevron[1], /transform:\s*rotate\(0deg\)/, 'a collapsed card points the chevron down')
  const open = /button\[data-process-activity\]\[aria-expanded='true'\]::after\s*\{([^}]*)\}/.exec(css)
  assert.ok(open, 'the expanded header must turn its chevron')
  assert.match(open[1], /transform:\s*rotate\(180deg\)/, 'an expanded card points the chevron up')

  // One line in both states: the host's own `padding-bottom: 8px` on the expanded
  // header is what used to make the header grow when the card was opened, and the
  // wrapper carries the design's hairline 10px under the line.
  const header = /body \[data-step-process\]:not\(\[hidden\]\) button\[data-process-activity\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(header, 'the header button must be sized explicitly')
  assert.match(header[1], /height:\s*16px/, 'the header line is 16px tall')
  assert.match(header[1], /gap:\s*8px/, "the design's gap between mark and label")
  assert.match(header[1], /padding:\s*0 !important/, "the header must drop the host's expanded padding")
  assert.match(header[1], /overflow:\s*hidden/, 'the label must stay on one line')
  assert.match(header[1], /font-size:\s*13px/, 'the header label is the design 13px')

  const wrapper = /body \[data-step-process\]:not\(\[hidden\]\) > div:first-child\s*\{([^}]*)\}/.exec(css)
  assert.ok(wrapper, 'the header wrapper must carry the rule')
  assert.match(wrapper[1], /border-bottom:\s*1px solid var\(--dsh-card-rule\)/, 'the design puts a hairline under the header')
  assert.match(wrapper[1], /padding:\s*0 0 10px/, "the design's 10px between line and hairline")
  assert.match(wrapper[1], /display:\s*block !important/, 'the host leaves this wrapper hidden; the header must still show')

  // The host paints a `data-shimmer-text` ghost of the full title behind the label;
  // the label is trimmed to its first half, so the ghost would put the tail back.
  assert.match(
    css,
    /\[class\*='_text_'\]\[data-shimmer-text\]::after\s*\{[^}]*content:\s*none/,
    'the shimmer ghost must not repaint the trimmed title',
  )
})

test('both card states are capped and pinned to the newest row', () => {
  // The user's contract: collapsed shows the last 4 rows, expanded shows at most
  // 12, and both scroll internally with the newest row in view. A host row is 26px
  // (`calc(24px + var(--dsh-content-font-delta))`, measured), which is exactly the
  // design's 16px row on its 10px `space-y-2.5` rhythm — so the card zeroes the
  // host's own 6px gap and the row height supplies the whole pitch.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')

  const body = /body \[data-step-process\]:not\(\[hidden\]\) \[data-step-process-body\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(body, 'the card body must carry the collapsed cap')
  assert.match(body[1], /max-height:\s*calc\(4 \* 26px\)/, 'collapsed shows the last four rows')
  assert.match(body[1], /--dsh-chat-flow-gap:\s*0px/, "the host's gap must not stretch the design pitch")
  assert.match(body[1], /overflow-y:\s*auto/, 'the capped body must scroll')
  assert.match(body[1], /flex-direction:\s*column-reverse/, 'reverse flow is what pins the newest row without script')
  // The host leaves a collapsed body at `hidden="until-found"`, which the UA
  // renders as `content-visibility: hidden` — a 0px box the cap cannot apply to.
  assert.match(body[1], /content-visibility:\s*visible !important/, 'a collapsed body must still lay out')
  assert.match(body[1], /display:\s*flex !important/, 'a collapsed body must still be a flex column')
  assert.match(body[1], /scrollbar-gutter:\s*auto/, "the host's reserved gutter must be dropped on a card whose rows fit")

  const expanded = /body\s*\[data-step-process\]:not\(\[hidden\]\)\s*> div:has\(> \[data-process-activity\]\[aria-expanded='true'\]\)\s*\+ \[data-step-process-body\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(expanded, 'the expanded card needs its own cap')
  assert.match(expanded[1], /max-height:\s*calc\(12 \* 26px\)/, 'expanded shows at most twelve rows')
})

test('a collapsed card only lays out the rows its cap shows', () => {
  // The body rule takes the collapsed card out of the host's
  // `content-visibility: hidden`, so every row of a long card is laid out even
  // though the 104px cap shows four. Row-level `auto` is what takes that back:
  // measured on a 111-row card, a full page relayout went from 3.8ms to 1.8ms
  // with four such cards on screen, and a streaming append from 0.6ms to 0.3ms.
  // `contain-intrinsic-size: auto 26px` reserves the design's row pitch for a
  // skipped row, so the scroll range stays the same length.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')

  const rows = /body \[data-step-process\]:not\(\[hidden\]\) \[data-step-process-content\] > \*\s*\{([^}]*)\}/.exec(css)
  assert.ok(rows, 'the collapsed card must scope its rows')
  assert.match(rows[1], /content-visibility:\s*auto/, 'a row outside the cap must skip layout')
  assert.match(rows[1], /contain-intrinsic-size:\s*auto 26px/, 'a skipped row must still reserve its pitch')

  // Expanded is a different question: the reader scrolls all twelve visible rows
  // through the window, so an estimate would show as a jump when a taller row
  // enters. Measured there, row `auto` bought no frame time — 16.0ms vs 15.7ms.
  const expandedRows = /body\s*\[data-step-process\]:not\(\[hidden\]\)\s*> div:has\(> \[data-process-activity\]\[aria-expanded='true'\]\)\s*\+ \[data-step-process-body\]\s+\[data-step-process-content\]\s*>\s*\*\s*\{([^}]*)\}/.exec(css)
  assert.ok(expandedRows, 'the expanded card must opt its rows back into layout')
  assert.match(expandedRows[1], /content-visibility:\s*visible/, 'an expanded card lays its rows out for real')
})

test('the card colours come from one token set, keyed on the live state', () => {
  // Every colour the card family paints is a variable on the card root, so the
  // dark palette re-points the tokens instead of restating the rules. `accent` is
  // the only blue in a dimmed card and exists to mark the one live row.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const root = /body \[data-step-process\]:not\(\[hidden\]\)\s*\{([^}]*)\}/.exec(css)
  assert.ok(root, 'the card root must declare its token set')
  for (const name of ['head', 'label', 'value', 'icon', 'row-icon', 'chevron', 'rule', 'accent', 'mark']) {
    assert.match(root[1], new RegExp(`--dsh-card-${name}:`), `the card must declare --dsh-card-${name}`)
  }
  // The design's dimmed card: slate-500 header, slate-400 detail, a hairline rule.
  assert.match(root[1], /--dsh-card-head:\s*#64748b/, 'a history header is slate-500')
  assert.match(root[1], /--dsh-card-value:\s*var\(--dsw-alias-label-tertiary\)/, 'a history value is slate-400')
  assert.match(root[1], /--dsh-card-rule:\s*var\(--dsw-alias-border-l2\)/, 'the header rule is a hairline')
  assert.match(root[1], /opacity:\s*0\.8/, "the design dims the whole card to 80%")

  // ACTIVE = the card of the running turn, plus the card holding a running or
  // streaming row that is not followed by another live card (only the newest one
  // is live, which is the bug the user reported: older cards' text sometimes
  // stayed bright). The turn half is what keeps the card lit between two tools.
  const active = /body\s*\[data-step-process\]:not\(\[hidden\]\):has\(\s*\[data-step-process-content\] \[data-state='running'\],\s*\[data-step-process-content\] \[data-shimmer\]\s*\):not\(\s*:has\(\s*~ \[data-step-process\]:not\(\[hidden\]\) \[data-state='running'\],\s*~ \[data-step-process\]:not\(\[hidden\]\) \[data-shimmer\]\s*\)\s*\),\s*body \[data-step-process\]:not\(\[hidden\]\)\[data-dsh-turn-live\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(active, 'the live card must be singled out, and the running turn must share it')
  assert.match(active[1], /--dsh-card-head:\s*var\(--dsw-alias-label-primary\)/, 'the live header is primary text')
  assert.match(active[1], /--dsh-card-icon:\s*var\(--dsh-card-accent\)/, 'the live mark takes the accent')
  assert.match(active[1], /border-color:\s*rgba\(37, 99, 235, 0\.3\)/, 'the live card takes the theme blue hairline')
  assert.match(active[1], /background-color:\s*var\(--dsw-alias-bg-layer-1\)/, "the live card is the design's white card")
  assert.match(active[1], /opacity:\s*1/, 'the live card is the only one at full strength')

  // Rows are coloured from the same set, scoped to the body so the header button
  // — whose class also matches `_title` — is not repainted by the row rule.
  const rowTitle = /body \[data-step-process\]:not\(\[hidden\]\) \[data-step-process-content\][^{]*\[class\*='_title'\][^{]*\{([^}]*)\}/.exec(css)
  assert.ok(rowTitle, 'row titles must be coloured from the card set')
  assert.match(rowTitle[1], /color:\s*var\(--dsh-card-label\)/, 'a row title follows the card state')

  // The design's row glyph is one step darker in the live card than in a history
  // card, so it needs its own token rather than following the row text.
  const rowIcon = /body \[data-step-process\]:not\(\[hidden\]\) \[data-step-process-content\] \[class\*='_iconIdle'\] svg\s*\{([^}]*)\}/.exec(css)
  assert.ok(rowIcon, 'the row glyph must be coloured from the card set')
  assert.match(rowIcon[1], /color:\s*var\(--dsh-card-row-icon\)/, 'a row glyph follows the card state')
})

test('the only motion is the header beat, and it stays inside the header', () => {
  // Two rounds of user direction shaped this. First "移除现在的所有动画，我会后续重新
  // 设计动画", then — seeing the redesigned mark sit still — "转圈动画，我现在看到的
  // 是一个固定不动的下半圆" plus "动画效果正反馈只通过卡片顶部 header 来呈现".
  //
  // So exactly two animations exist, both on the header mark, and nothing else in
  // the sheet may animate. A third keyframe would be a card-level pulse again, which
  // is what the user rejected.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])
  assert.deepEqual(names.sort(), ['dsh-card-arc-dip', 'dsh-card-check', 'dsh-card-rule-sweep', 'dsh-card-spin'])

  // The spin has to be declared, and it has to be on the arc layer: the mark was a
  // static mask before this, which is the "固定不动的下半圆" the user saw.
  assert.match(css, /@keyframes\s+dsh-card-spin\s*\{[^}]*rotate\(360deg\)/, 'the arc must actually turn')
  const arc = /body \[data-step-process\]:not\(\[hidden\]\) > div:first-child \[class\*='_leading'\]::before\s*\{([^}]*)\}/.exec(css)
  assert.ok(arc, 'the arc layer must be styled')
  assert.match(arc[1], /animation-name:\s*var\(--dsh-card-spin\)/, 'the arc spins from the card token')

  // `none` is what a resting card carries, so a finished turn cannot spin a mark
  // nobody sees — and one place (the ACTIVE rule) decides.
  const root = /body \[data-step-process\]:not\(\[hidden\]\)\s*\{([^}]*)\}/.exec(css)
  assert.ok(root, 'the card token block must exist')
  assert.match(root[1], /--dsh-card-spin:\s*none/, 'a resting card does not spin')
  const active = /body \[data-step-process\]:not\(\[hidden\]\)\[data-dsh-turn-live\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(active, 'the live card rule must exist')
  assert.match(active[1], /--dsh-card-spin:\s*dsh-card-spin/, 'the live card names the spin')

  // The per-step beat: check pops in over the arc, arc dips aside, hairline sweeps.
  // All three hang off `[data-dsh-step-done]` on the CARD, and all three select
  // `> div:first-child` — the header. Nothing may target the body or the card box.
  for (const [pattern, what] of [
    [/\[data-dsh-step-done\][^{]*_leading'\]::after\s*\{[^}]*animation-name:\s*dsh-card-check/, 'the check pops in'],
    [/\[data-dsh-step-done\][^{]*_leading'\]::before\s*\{[^}]*animation-name:\s*var\(--dsh-card-spin\), dsh-card-arc-dip/, 'the arc dips aside without stopping'],
    [/\[data-dsh-step-done\][^{]*div:first-child::after\s*\{[^}]*animation:\s*dsh-card-rule-sweep/, 'the hairline sweeps'],
  ]) {
    assert.match(css, pattern, what)
  }
  // Every animated selector stays on the header wrapper or its mark.
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*animation(-name)?:[^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((x) => x.trim()).filter(Boolean)
    for (const selector of selectors) {
      assert.match(
        selector,
        /div:first-child/,
        `motion outside the card header: ${selector}`,
      )
    }
  }

  // The marker is the browser half's, not the stylesheet's.
  assert.match(clientSource, /var BEAT_ATTR = 'data-dsh-step-done'/, 'the beat marker must be named')
  assert.doesNotMatch(clientSource, /data-dsh-settled/, 'the old settle marker must not come back')
})

test('the finished card rests on the check', () => {
  // The design gave a history card a clock and the just-finished card a check. The
  // user kept the check for both and dropped the clock with the animation, so the
  // card carries exactly two glyphs: the live arc and the resting check.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const root = /body \[data-step-process\]:not\(\[hidden\]\)\s*\{([^}]*)\}/.exec(css)
  assert.ok(root, 'the card root must declare its mark')
  const check = "%3Cpath d='M5.5 8.25L7.25 10L10.75 6.25'/%3E"
  const clock = "%3Cpath d='M8 5V8.5L10.5 10'/%3E"
  assert.ok(root[1].includes(check), 'a finished card rests on the check')
  assert.equal(css.includes(clock), false, 'the clock is gone with the animation')

  // The arc is its own layer token, and the live card is what turns it on — the
  // check stays on top so a step finishing mid-turn can show it over a live arc.
  assert.ok(root[1].includes('stroke-dasharray'), 'the card declares the live arc')
  assert.match(root[1], /--dsh-card-arc-opacity:\s*0/, 'a resting card shows no arc')
  const arc = /body \[data-step-process\]:not\(\[hidden\]\)\[data-dsh-turn-live\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(arc, 'the live card must carry its own mark')
  assert.match(arc[1], /--dsh-card-arc-opacity:\s*1/, 'the running card shows the live arc')
  assert.match(arc[1], /--dsh-card-rest-opacity:\s*0/, 'the arc replaces the resting check while it runs')
})

test('the card stays lit for as long as its turn runs', () => {
  // A card used to be ACTIVE only while one of its rows was running or streaming,
  // so it dimmed the moment its last tool finished — in the middle of a turn the
  // user is still watching. The running turn is the state, and the host's hint for
  // it is a SIBLING of the card, which no selector can read, so `client.js` mirrors
  // it onto the card and the sheet paints the card from that.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const lit = /body \[data-step-process\]:not\(\[hidden\]\)\[data-dsh-turn-live\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(lit, 'the running turn must light its card')
  for (const [what, re] of [
    ['the header', /--dsh-card-head:\s*var\(--dsw-alias-label-primary\)/],
    ['the mark', /--dsh-card-icon:\s*var\(--dsh-card-accent\)/],
    ['the hairline', /border-color:\s*rgba\(37, 99, 235, 0\.3\)/],
    ['the fill', /background-color:\s*var\(--dsw-alias-bg-layer-1\)/],
    ['full strength', /opacity:\s*1/],
  ]) {
    assert.match(lit[1], re, `${what} must be the ACTIVE one`)
  }
  // The dark palette re-points the same rule, and has to take the accent back: its
  // base rule dims every card's mark and sits later in the sheet than the light one.
  assert.match(
    css,
    /body\[data-ds-dark-theme\] \[data-step-process\]:not\(\[hidden\]\)\[data-dsh-turn-live\]\s*\{[^}]*--dsh-card-icon:\s*var\(--dsh-card-accent\)/,
    'the dark lit card keeps the accent mark',
  )
})

test('the browser half marks what the stylesheet cannot select', () => {
  // Two things are unselectable in CSS: a settings row whose only discriminator is
  // its localized title, and the card that belongs to the running turn (the host's
  // running hint is a sibling of the card). Both are written by `client.js`, and
  // both attribute names must agree with the sheet, or the rules silently never
  // match.
  assert.ok(clientSource.includes("var HIDE_ATTR = 'data-dsh-hide'"), 'the row marker must match the sheet')
  assert.ok(
    clientSource.includes("var TURN_LIVE_ATTR = 'data-dsh-turn-live'"),
    'the turn marker must match the sheet',
  )
  for (const title of ['工作步骤展示', 'Work details']) {
    assert.ok(
      clientSource.includes(`'${title}'`),
      `the row is found by its title, so ${title} must be listed for that locale`,
    )
  }
  // A hidden row is marked, never removed: React owns the host's settings list and
  // deleting its node makes the next reconciliation throw.
  assert.equal(
    /removeChild|remove\(\)/.test(
      clientSource.slice(
        clientSource.indexOf('function hideTranscriptSettingRow'),
        clientSource.indexOf('function liveTurnCard'),
      ),
    ),
    false,
    'the settings row must be marked, not removed',
  )

  // The turn state is the host's own hint, mounted only while the session runs, and
  // the card it belongs to is that hint's previous sibling (measured: turn 8, the
  // hint sat directly under the card with nothing in between).
  assert.match(clientSource, /\[data-chat-running\]/, 'the turn state is read from the host hint')
  assert.match(clientSource, /previousElementSibling/, "the card is the hint's previous sibling")

  // Each effect must be registered with the context so a hot reload disposes it; a
  // bare call would stack observers on every activation.
  for (const name of ['hideTranscriptSettingRow', 'syncCardHeaderLabels']) {
    assert.match(
      clientSource,
      new RegExp(`ctx\\.effect\\(${name},`),
      `${name} must be registered as a disposable effect`,
    )
  }
})

test('the card header reads the first half of the host title', () => {
  // The host composes the header as `label + " · " + detail` (its own
  // `message.turnProcess.separator`), where the detail is the live command or the
  // reasoning text. The design's header is the label alone, and truncation cannot
  // express that: the tail starts after a separator whose position CSS cannot know.
  // So `client.js` rewrites the label's text node, and it must also drop the
  // `data-shimmer-text` ghost the host paints behind it — the stylesheet hides that
  // ghost, and a rewrite that missed the mirror would put the tail back on screen.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(css, /\[class\*='_text_'\]\[data-shimmer-text\]::after\s*\{[^}]*content:\s*none/, 'the ghost must be off')

  assert.match(clientSource, /function syncCardHeaderLabels\(\)/, 'the label must be rewritten by the browser half')
  assert.match(clientSource, /var TITLE_SEPARATOR = ' · '/, "the separator must be the host's own")
  // The header is the card's DIRECT first child. A bare `div:first-child` also
  // matches every row, whose own first child is its label — measured, that made a
  // finished card read `执行了命令 执行了命令` on each of its rows.
  assert.match(
    clientSource,
    /var CARD_LABEL = ":scope > div:first-child span\[class\*='_text_'\]"/,
    'the label lookup must be scoped to the card header, not to every row',
  )
  const body = /function syncCardHeaderLabels\(\) \{[\s\S]*?\n    \}\n\n    \/\*\*/.exec(clientSource)
  assert.ok(body, 'the label logic must resolve to one function')
  assert.match(body[0], /indexOf\(TITLE_SEPARATOR\)/, 'the cut is made at the separator')
  assert.match(body[0], /nodeValue = text\.slice\(0, at\)/, 'only the first half is kept')
  // The label is re-rendered on every streamed token, so a one-off pass would be
  // overwritten at once: this has to observe, and it has to skip the ghost.
  assert.match(body[0], /new MutationObserver/, 'the label streams, so the cut must be observed')
  assert.match(body[0], /characterData: true/, 'a streamed token arrives as a characterData change')
  assert.match(body[0], /hasAttribute\('data-shimmer-text'\)/, 'the ghost must be left alone')
  assert.match(
    clientSource,
    /ctx\.effect\(syncCardHeaderLabels,/,
    'the label logic must be registered as a disposable effect',
  )
})

test('a finished tool reports what it did, not the next analysis', () => {
  // Reported: "刚运行完命令，不是应该显示「执行了命令」之类的结果吗". The host's live
  // label is `summary.running ?? 'thinking'`, so with no tool running it falls back
  // to 正在分析请求 — between two tools, and for the whole rest of a turn whose last
  // row was a tool. The card must announce the result instead.
  //
  // The strings are the host's own `message.turnProcess.done.*`, hard-coded in both
  // locales because this half has no dictionary (the same arrangement as the
  // settings row). Every variant and every refining tool must have one, or a card
  // would keep the wrong wording for that tool.
  for (const [label, locale] of [
    ['执行了命令', 0],
    ['修改了文件', 0],
    ['已读取文件', 0],
    ['已搜索代码', 0],
    ['已写入文件', 0],
    ['已调用工具', 0],
    ['已读取图片', 0],
    ['已搜索网页', 0],
    ['已访问网页', 0],
    ['已协调子智能体', 0],
    ['更新了计划', 0],
    ['向用户提出了问题', 0],
    ['Ran commands', 1],
    ['Edited files', 1],
    ['Read files', 1],
  ]) {
    assert.ok(clientSource.includes(`'${label}'`), `the done label ${label} must be hard-coded (${locale})`)
  }
  // The tools whose wording differs from their row variant are looked up by
  // `data-tool` first: a `read` variant carries both a read and a read_image.
  const byTool = /var DONE_BY_TOOL = \{([\s\S]*?)\n    \}/.exec(clientSource)
  assert.ok(byTool, 'the tool table must exist')
  for (const tool of ['read_image', 'web_search', 'web_fetch', 'subagent', 'ask_user_question']) {
    assert.match(byTool[1], new RegExp(`${tool}:`), `${tool} must override its variant's wording`)
  }
  const byVariant = /var DONE_BY_VARIANT = \{([\s\S]*?)\n    \}/.exec(clientSource)
  assert.ok(byVariant, 'the variant table must exist')
  for (const variant of ['read', 'search', 'write', 'edit', 'bash', 'code', 'others']) {
    assert.match(byVariant[1], new RegExp(`\\b${variant}:`), `the ${variant} variant must have a done label`)
  }

  // Only a FINISHED row reports a result. A row that is still running keeps the
  // host's 正在… wording, and so does a finished reasoning row: the model really is
  // analysing again, which is exactly what 正在分析请求 says.
  const running = /function runningLabel\(card\) \{[\s\S]*?\n      \}/.exec(clientSource)
  assert.ok(running, 'the label must be chosen per card state')
  assert.match(running[0], /\[data-state='running'\]/, 'a running row keeps the host wording')
  assert.match(running[0], /\[data-shimmer\]/, 'a streaming row keeps the host wording')
  assert.match(running[0], /getAttribute\('data-tool'\)/, "the tool's own label wins over the variant's")
  assert.match(running[0], /getAttribute\('data-variant'\)/, 'the row variant is the fallback')
  assert.equal(/think/.test(byVariant[1] + byTool[1]), false, 'a reasoning row is not a tool and has no result')

  // Only the running turn's card is rewritten; a closed card keeps the host's own
  // summary title (执行了命令，修改了文件，已读取文件等), which is what the user asked to
  // keep for folded history.
  assert.match(clientSource, /var result = card === live \? runningLabel\(card\) : null/, 'only the live card is rewritten')
})

test('the transcript-mode setting row is hidden, not removed', () => {
  // Section 7 gives every mode the same behaviour, so the selector is a control
  // with no effect. React owns that node; deleting it makes the host's next
  // reconciliation throw, so `client.js` marks it and the sheet takes it out of
  // the flow.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(css, /body \[data-dsh-hide\]\s*\{[^}]*display:\s*none/, 'a marked settings row must leave the flow')
})

test('every status-surface literal is re-pointed for the dark palette', () => {
  // Each light rule above pins a literal colour, so the dark palette has to
  // re-point it or the surface stays light-on-dark.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [label, re] of [
    ['the completed pill', /body\[data-ds-dark-theme\] \[data-turn-process\]\s*\{[^}]*background-color:\s*rgba\(255, 255, 255, 0\.06\)/],
    ['the card accent', /body\[data-ds-dark-theme\] \[data-step-process\]:not\(\[hidden\]\)\s*\{[^}]*--dsh-card-accent:\s*#60a5fa/],
    // The dark base rule dims every card's mark, and it sits after the light ACTIVE
    // rule, so the lit card takes the accent back — otherwise a running card would
    // show a dimmed glyph while its fill stayed lit.
    ['the lit card mark', /body\[data-ds-dark-theme\] \[data-step-process\]:not\(\[hidden\]\)\[data-dsh-turn-live\]\s*\{[^}]*--dsh-card-icon:\s*var\(--dsh-card-accent\)/],
    ['the running hint', /body\[data-ds-dark-theme\] \[data-chat-running\]\s*\{[^}]*color:\s*#60a5fa/],
  ]) {
    assert.match(css, re, `${label} must be re-pointed for the dark palette`)
  }
  // The old violet dark overrides must be gone with the light ones.
  assert.equal(
    /body\[data-ds-dark-theme\][^{]*\{[^}]*139, 92, 246/.test(css),
    false,
    'no violet dark override may survive',
  )
})

test('the sidebar workspace cards tell a worktree from its owner', () => {
  // A workspace and its sessions share one `groupSection`, and nested worktrees
  // are *separate* `groupSection`s inside their parent's — so the same element
  // type appears at both levels. The discriminator has to be the card's own
  // workspace row (`> * > ` reaches it through the host's `display:contents`
  // wrapper), because a parent card also *contains* worktree rows: a plain
  // `:has([data-dsh-worktree])` would match the parent too. Measured against the
  // live sidebar with this pair: 8 plain cards, 5 worktree cards, 0 overlap.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const plain = /body \[class\*='groupSection'\]:has\(> \* > \[data-row-key\^='workspace:'\]:not\(\[data-dsh-worktree\]\)\)\s*\{([^}]*)\}/.exec(css)
  const worktree = /body \[class\*='groupSection'\]:has\(> \* > \[data-row-key\^='workspace:'\]\[data-dsh-worktree\]\)\s*\{([^}]*)\}/.exec(css)
  assert.ok(plain, 'the plain workspace card must be targeted through its own workspace row')
  assert.ok(worktree, 'the worktree card must be targeted through its own workspace row')
  assert.match(plain[1], /background-color:\s*#f8fafc/)
  assert.match(plain[1], /border-radius:\s*14px/)
  assert.match(worktree[1], /background-color:\s*#eff6ff/)
  assert.match(worktree[1], /border-radius:\s*10px/)
  // Indentation is the host's job: it already offsets worktree rows and their
  // sessions by +12px through `--dsh-workspace-indent`, so a second indent here
  // would read as two levels.
  assert.equal(/padding-(left|inline-start)/.test(worktree[1]), false, 'the worktree card must not add a second indent')
})

test('the sidebar status surfaces paint only the three reachable states', () => {
  // The sidebar only ever shows idle (host paints nothing), ongoing and warning.
  // `done` and `error` are deliberately not styled: a finished session should
  // read as quiet rather than as a green/red badge competing with the cards.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const waiting = /body \[data-slot='sidebar'\] \[data-state='warning'\]\s*\{([^}]*)\}/.exec(css)
  const ongoing = /body \[data-slot='sidebar'\] \[data-state='ongoing'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(waiting, 'the waiting-answer dot must be targeted by its state attribute')
  assert.ok(ongoing, 'the running ring must be targeted by its state attribute')
  assert.match(waiting[1], /color:\s*#fbbf24/)
  assert.match(waiting[1], /box-shadow:\s*0 0 0 2px #fef3c7/)
  assert.match(ongoing[1], /color:\s*#2563eb/)
  for (const state of ['done', 'error']) {
    assert.equal(
      new RegExp(`\\[data-slot='sidebar'\\][^{]*\\[data-state='${state}'\\]`).test(css),
      false,
      `${state} must stay unstyled in the sidebar`,
    )
  }
  // `dot` / `spinner` are CSS-Module local names that compile to build-path
  // hashes (measured `_spinner_1i3xo_37`), so they cannot be anchored on.
  assert.equal(
    /\[data-slot='sidebar'\][^{]*\.(dot|spinner)\b/.test(css),
    false,
    'the status rules must not anchor on CSS-Module class names',
  )
})

test('both sidebar cards and the waiting dot are re-pointed for the dark palette', () => {
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [label, re] of [
    ['the plain card', /body\[data-ds-dark-theme\] \[class\*='groupSection'\]:has\(> \* > \[data-row-key\^='workspace:'\]:not\(\[data-dsh-worktree\]\)\)\s*\{[^}]*background-color:\s*rgba\(255, 255, 255, 0\.04\)/],
    ['the worktree card', /body\[data-ds-dark-theme\] \[class\*='groupSection'\]:has\(> \* > \[data-row-key\^='workspace:'\]\[data-dsh-worktree\]\)\s*\{[^}]*background-color:\s*rgba\(37, 99, 235, 0\.16\)/],
    ['the waiting dot', /body\[data-ds-dark-theme\] \[data-slot='sidebar'\] \[data-state='warning'\]\s*\{[^}]*box-shadow:\s*0 0 0 2px rgba\(251, 191, 36, 0\.22\)/],
  ]) {
    assert.match(css, re, `${label} must be re-pointed for the dark palette`)
  }
})

test('the chat typeface is self-hosted, never a locally installed font', () => {
  // The UI is reached over the LAN from machines that have neither face
  // plugin's own route. They cannot be inlined into `lib/client.js` (that would
  // add ~1.7 MB to every client bundle) and cannot go through `/plugins/` (that
  // route serves only whitelisted `client*.js` bundles).
  const css = compiledCss()
  for (const [family, file] of [
    ['Fira Code', 'FiraCode-VF.woff2'],
    ['LXGW WenKai Mono', 'LXGWWenKaiMono-GB.woff2'],
  ]) {
    const rule = new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*'${family}'[^}]*\\}`).exec(css)
    assert.ok(rule, `${family} must be declared with @font-face`)
    assert.ok(rule[0].includes(`/dsh-macos-theme/fonts/${file}`), `${family} must load from the plugin's own route`)
    assert.ok(rule[0].includes('font-display: swap'), `${family} must not block first paint`)
  }
  const stack = /--dsh-chat-font:\s*([^;]+);/.exec(css)
  assert.ok(stack, 'the chat font stack must be declared')
  assert.match(stack[1], /^'Fira Code',\s*'LXGW WenKai Mono'/, 'the bundled faces must lead the stack')
  // The served files must actually ship, or every request 404s.
  assert.ok(manifest.files.includes('assets'), 'the font assets must be published with the package')
})

test('every chat surface resolves to the bundled stack, not a local installation', () => {
  // The host's `--ds-font-family-code` leads with SF Mono / JetBrains Mono, which
  // exist only if the viewing machine has them — the exact local-installation
  // dependency the bundled font exists to remove. Tailwind's `font-mono` is the
  // same story (`ui-monospace, SFMono-Regular, Menlo, …`). So every monospaced
  // surface in the chat has to name the bundled stack explicitly; the only way to
  // get that wrong silently is to leave a `font-mono` on one of them.
  const css = compiledCss()
  for (const [label, selector] of [
    ['inline code in a reply', "body \\[data-chat-flow-kind='assistant-step'\\] code"],
    ['a fenced code block', 'body \\.md-code-block pre'],
    ['the model pill', "body \\[data-composer-card\\] \\[class\\*='_standardControls'\\] button\\[class\\*='_trigger'\\]"],
  ]) {
    const rule = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css)
    assert.ok(rule, `${label} must be styled`)
    assert.match(
      rule[1],
      /font-family:\s*var\(--dsh-chat-font,\s*inherit\)/,
      `${label} must use the bundled stack, with the opt-out fallback`,
    )
    assert.equal(
      /font-family:\s*(ui-monospace|"SF Mono"|SFMono)/.test(rule[1]),
      false,
      `${label} must not fall back to a locally installed face`,
    )
  }
})

test('the font route is served from the host half and fenced per request', () => {
  // A plugin route under `/api` would sort ahead of the trust fence, because the
  // webserver checks its exact table before its prefix table and the fence
  // registers `/api` as a prefix. The route must therefore live elsewhere, and
  // the fence must be consulted per request rather than captured — an optional
  // service read into `inject` would drop the whole plugin when absent.
  const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.ok(source.includes("'/dsh-macos-theme/fonts'"), 'the font prefix must not be under /api')
  assert.ok(source.includes('requestRejection'), 'the trust fence must be consulted')
  assert.ok(source.includes("ctx.inject(['webServer']"), 'webServer must be injected scoped, not declared')
  assert.equal(plugin.inject, undefined, 'a top-level inject would drop the plugin on a host without a webserver')
  for (const font of ['FiraCode-VF.woff2', 'LXGWWenKaiMono-GB.woff2']) {
    assert.ok(source.includes(font), `${font} must be listed as a served file`)
  }
})

test('the user bubble overrides the host inline style', () => {
  // The host sets the bubble's fill, radius and padding as an inline `style`
  // attribute, and an inline declaration outranks any stylesheet rule. Without
  // `!important` the bubble stayed on the host's pale wash instead of the
  // design's dark slate.
  const css = compiledCss()
  const rule = /body \.dsh-easyrewrite-bubble\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the user bubble must be styled')
  for (const prop of ['background-color', 'border-radius', 'padding']) {
    assert.match(rule[1], new RegExp(`${prop}:[^;]*!important`), `${prop} must be !important to beat the inline style`)
  }
})

test('the three chat text surfaces share one type size', () => {
  // The composer's editable, the user bubble and the assistant prose each carry
  // their own type scale: measured in the live UI the composer's editable was
  // 16px/26px (inherited from `_card`, which reads the host's
  // `--dsh-content-font-size` user setting), the easyrewrite bubble 13px/20.8px
  // and the assistant prose 13px/22.1px. The user asked for all three to match
  // the assistant message, so the size and line-height live in one token pair
  // and every surface reads it — changing one number must move all three.
  const css = compiledCss()
  const token = /body\s*\{([^}]*)\}/.exec(css)
  assert.ok(token, 'the tokens must be declared on the body')
  assert.match(token[1], /--dsh-chat-font-size:\s*13px/, 'the chat size token must be 13px')
  assert.match(token[1], /--dsh-chat-line-height:\s*1\.7/, 'the line-height must stay unitless so 13px renders 22.1px')

  // Read the rules as (selector list, body) pairs: some of these selectors share
  // a rule with another surface, and the typeface rule already targets the same
  // selectors, so only the last rule declaring the pair is the effective one.
  // `@media` blocks nest rules, so a rule's selector can be preceded by `{` as
  // well as `}`; capturing the run between braces covers both.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()),
    body: m[2],
  }))

  for (const [selector, what] of [
    ["body [data-chat-flow-kind='assistant-step'] [class*='_markdown']", 'the assistant prose'],
    ["body [data-composer-card] [class*='_input']", 'the composer editable'],
    ["body [data-composer-card] [class*='_placeholder']", 'the composer placeholder'],
    ['body .dsh-easyrewrite-bubble', 'the durable user bubble'],
    ["body [class*='_bubble']", 'the host-rendered user bubble'],
  ]) {
    const matching = rules.filter((rule) => rule.selectors.includes(selector))
    assert.ok(matching.length > 0, `${what} must be styled`)
    const body = matching.at(-1).body
    assert.match(body, /font-size:\s*var\(--dsh-chat-font-size\)/, `${what} must read the shared size`)
    assert.match(body, /line-height:\s*var\(--dsh-chat-line-height\)/, `${what} must read the shared line-height`)
  }
})

test('the merged process cards read at the transcript\'s own type size', () => {
  // The design draws the card one step below the chat (12px label, 11px detail),
  // but on screen that made the card a third text size between the user's message
  // and the assistant's — reported as "思考卡片详情的字体大小改为和其他消息字体大小一致
  // (12px->13px)". The card therefore follows the transcript's 13px, and keeps its
  // hierarchy through weight and colour instead of size.
  //
  // These four families are the ones that *declare* a size; the bare `_text` leaves
  // inherit from them, which is why the rules must not name `_text`: the same class
  // paints the terminal command and code lines inside the card, and those stay on
  // the code scale.
  const css = compiledCss()
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()),
    body: m[2],
  }))

  const matching = (selector) => {
    const found = rules.filter((rule) => rule.selectors.includes(selector))
    assert.ok(found.length > 0, `${selector} must be styled`)
    return found.at(-1).body
  }

  const title = matching("body [data-step-process]:not([hidden]) [class*='_title']")
  assert.match(title, /font-size:\s*13px/, "the row label matches the transcript's own size")
  assert.match(title, /font-weight:\s*500/, 'the row label keeps its medium weight')

  // The compaction row is a row like any other: same 13px scale on both of its
  // halves, and the same `truncate` on the detail. Its title is a fixed phrase
  // (上下文已压缩), so it takes the size and weight without the ellipsis.
  const compTitle = matching(
    "body [data-step-process]:not([hidden]) [data-step-process-content] [class*='compactionTitle']",
  )
  assert.match(compTitle, /font-size:\s*13px/, 'the compaction row title matches the transcript')
  assert.match(compTitle, /font-weight:\s*500/, 'the compaction row title is a row label')

  for (const [selector, what] of [
    ["body [data-step-process]:not([hidden]) [class*='_summary']", 'the reasoning and tool summaries'],
    ["body [data-step-process]:not([hidden]) [class*='_fileLink']", 'the tool file link'],
    [
      "body [data-step-process]:not([hidden]) [data-step-process-content] [class*='compactionSummary']",
      'the compaction row detail inside a card',
    ],
  ]) {
    const body = matching(selector)
    assert.match(body, /font-size:\s*13px/, `${what} matches the transcript's own size`)
    // The design's detail is `truncate`; the host only sets `nowrap`, so a long
    // command used to run past the card's edge (measured: 665px body, overflowing).
    assert.match(body, /text-overflow:\s*ellipsis/, `${what} must end in an ellipsis`)
    assert.match(body, /overflow:\s*hidden/, `${what} must not overflow the card`)
  }

  // The card's code surfaces (`_terminal`, `_ioCard`, `pre`, inline `code`) keep
  // the code scale; reaching them would have to go through `_text`, which is the
  // class they share with the card's own copy.
  const cardRule = rules.filter((rule) =>
    rule.selectors.some((s) => s.startsWith('body [data-step-process]:not([hidden]) ')),
  )
  for (const rule of cardRule) {
    if (!/font-size:\s*13px/.test(rule.body)) continue
    assert.deepEqual(
      rule.selectors.filter((s) => /_text|terminal|_ioCard|code/.test(s)),
      [],
      'the card type rule must not repaint the code surfaces',
    )
  }
})

test('a row is the design 14px glyph, an 8px gap, label and detail', () => {
  // The host draws the row's glyph at `calc(14px + font-delta)` = 16px in an 18px
  // slot, and puts a 2px dot with 8px margins between the kind label and its
  // detail. The design has a 14px glyph (`w-3.5`) and an 8px gap (`gap-2`) with no
  // dot, so the slot and the glyph are shrunk and the dot is removed. Measured, the
  // row stays 26px tall, which is what the card's caps are built on.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const lead = /body \[data-step-process\]:not\(\[hidden\]\) \[data-step-process-content\] \[class\*='_leading'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(lead, 'the row slot must be sized')
  assert.match(lead[1], /width:\s*14px/, 'the design glyph is 14px wide')
  assert.match(lead[1], /height:\s*14px/, 'the design glyph is 14px tall')
  assert.match(lead[1], /margin-right:\s*8px/, "the design's gap-2 after the glyph")

  const glyph = /body \[data-step-process\]:not\(\[hidden\]\) \[data-step-process-content\] \[class\*='_leading'\] svg\s*\{([^}]*)\}/.exec(css)
  assert.ok(glyph, 'the glyph itself must be sized, not just its slot')
  assert.match(glyph[1], /width:\s*14px/, "the host's font-delta size must be overridden")
  assert.match(glyph[1], /height:\s*14px/, "the host's font-delta size must be overridden")

  const dot = /body \[data-step-process\]:not\(\[hidden\]\) \[data-step-process-content\] \[class\*='_sep'\],\s*body \[data-step-process\]:not\(\[hidden\]\) \[data-step-process-content\] \[class\*='_separator'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(dot, 'both separator spellings must be covered')
  assert.match(dot[1], /display:\s*none/, 'the design has no dot between label and detail')
})

test('the assistant prose is anchored on the markdown container', () => {
  // `_body_*` also matches 141 elements under assistant steps but is a different
  // component; the prose container is `_markdown_*`. Anchoring on `_body_`
  // restyled the wrong element and left the prose at 14px.
  const css = compiledCss()
  assert.ok(css.includes("[class*='_markdown']"), 'the prose must anchor on the markdown container')
})

test('markdown headings take the transcript face on a stepped ladder', () => {
  // The host drew h2 at 22px/31px/700 in `-apple-system` — a third of the way to a
  // page title, in a face nothing else in the transcript uses. Reported as
  // "标题类字体…还没有和其他消息样式统一". The face and the colour now follow the
  // transcript; the sizes stay a ladder above the 13px prose, because a heading
  // the same size as its paragraph stops reading as a heading.
  //
  // `:not([data-markdown-variant='compact'])` keeps the thinking block out: the
  // host already sets its headings to `inherit` on an 8px/4px margin, and a
  // document-sized heading there would push the block apart.
  const prose =
    "body [data-chat-flow-kind='assistant-step'] [class*='_markdown']:not([data-markdown-variant='compact'])"
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const body = lastRule(`${prose} ${tag}`)
    assert.ok(body, `${tag} must be styled`)
    assert.match(body, /font-family:\s*var\(--dsh-chat-font, inherit\)/, `${tag} takes the chat face`)
    assert.match(body, /color:\s*var\(--dsw-alias-label-primary\)/, `${tag} is a label, not the host's heading ink`)
    // The prose's 1.7 leading is sized for long CJK paragraphs; at 22px it would
    // open a gap wider than the break the margins already give.
    assert.match(body, /line-height:\s*1\.35/, `${tag} uses a heading leading, not the prose's`)
    assert.doesNotMatch(body, /font-size:\s*var\(--dsh-chat-font-size\)/, `${tag} must not collapse onto the prose size`)
  }

  // Each rank is its own size, and every one is above the 13px body.
  const ladder = { h1: 22, h2: 18, h3: 15, h4: 14, h5: 14, h6: 14 }
  for (const [tag, size] of Object.entries(ladder)) {
    assert.match(lastRule(`${prose} ${tag}`), new RegExp(`font-size:\\s*${size}px`), `${tag} sits at ${size}px`)
  }

  // The host's `margin: 32px 0 16px` is a document's break, not a transcript's;
  // the break is kept, stepped with the size.
  assert.match(lastRule(`${prose} h1`), /margin:\s*24px 0 10px/, 'h1 keeps the largest break')
  assert.match(lastRule(`${prose} h2`), /margin:\s*20px 0 8px/, 'h2 keeps a paragraph-sized break')
  assert.match(lastRule(`${prose} h3`), /margin:\s*14px 0 6px/, 'h3 keeps a smaller break')

  // Weight still carries the rank inside a group.
  assert.match(lastRule(`${prose} h1`), /font-weight:\s*600/, 'h1 is the top rank')
  assert.match(lastRule(`${prose} h2`), /font-weight:\s*600/, 'h2 is the second rank')
  assert.match(lastRule(`${prose} h3`), /font-weight:\s*500/, 'h3 drops to medium')
  assert.match(lastRule(`${prose} h4`), /font-weight:\s*400/, 'h4 and below are plain')
})

test('markdown tables stay on the transcript type scale', () => {
  // The host's table cells are 15px/24px `-apple-system` with `padding: 10px 16px`
  // and first/last-child padding resets; the design language has no 15px step, so
  // a table read as a foreign block inside the prose.
  const prose =
    "body [data-chat-flow-kind='assistant-step'] [class*='_markdown']:not([data-markdown-variant='compact'])"
  for (const selector of [`${prose} th`, `${prose} td`]) {
    const body = lastRule(selector)
    assert.ok(body, `${selector} must be styled`)
    assert.match(body, /font-family:\s*var\(--dsh-chat-font, inherit\)/, `${selector} takes the chat face`)
    assert.match(body, /font-size:\s*var\(--dsh-chat-font-size\)/, `${selector} takes the chat size`)
    assert.match(body, /line-height:\s*var\(--dsh-chat-line-height\)/, `${selector} takes the chat line-height`)
    // Symmetric padding cancels the host's `:first-child`/`:last-child` resets,
    // which would otherwise pull the outer cells flush to the rule.
    assert.match(body, /padding:\s*6px 12px/, `${selector} gets a symmetric, transcript-sized pad`)
  }
})

test('the turn-trigger card reads as one of the transcript cards', () => {
  // 「继续执行目标」/「自动化任务」 renders a `section[data-turn-trigger]` at
  // radius 20px, a 17px/400 Fira Code title and a 40px left inset — a third card
  // shape next to the 12px/1px process card and the 8px process pill.
  const root = lastRule('body [data-turn-trigger]')
  assert.ok(root, 'the trigger card must be styled')
  assert.match(root, /border-radius:\s*12px/, 'the card shares the process card radius')
  assert.match(root, /border-width:\s*1px/, 'the card shares the process card hairline')
  assert.match(root, /border-color:\s*var\(--dsw-alias-border-l3\)/, 'and the same border token')
  assert.match(root, /background-color:\s*var\(--dsw-alias-turn-trigger-bg\)/, 'and the host trigger surface')

  for (const [selector, what] of [
    ["body [data-turn-trigger] [class*='_title']", 'the card title'],
    ["body [data-turn-trigger] [class*='_time']", 'the card timestamp'],
    ["body [data-turn-trigger] [class*='_explanation']", 'the card explanation'],
    ["body [data-turn-trigger] [class*='_content']", 'the expanded body'],
  ]) {
    const body = lastRule(selector)
    assert.ok(body, `${what} must be styled`)
    assert.match(body, /font-family:\s*var\(--dsh-chat-font, inherit\)/, `${what} takes the chat face`)
    assert.match(body, /font-size:\s*var\(--dsh-chat-font-size\)/, `${what} takes the chat size`)
    assert.match(body, /line-height:\s*var\(--dsh-chat-line-height\)/, `${what} takes the chat line-height`)
  }
})

test('the expanded card body keeps the transcript type scale', () => {
  // Inside an expanded process card the leaves that declare their own size are
  // already 13px, but the feature cards are not: `data-search` measured 16px, and
  // `data-read`/`data-diff` 14px/22px in SF Mono, dragging every child that
  // inherits (file paths, line numbers, line bodies, expand buttons) with them.
  const card = "body [data-step-process]:not([hidden]) [data-step-process-content]"
  for (const kind of ['search', 'read', 'diff']) {
    const body = lastRule(`${card} [data-${kind}]`)
    assert.ok(body, `the ${kind} body must be styled`)
    assert.match(body, /font-family:\s*var\(--dsh-chat-font, inherit\)/, `the ${kind} body takes the chat face`)
    assert.match(body, /font-size:\s*var\(--dsh-chat-font-size\)/, `the ${kind} body takes the chat size`)
    assert.match(body, /line-height:\s*var\(--dsh-chat-line-height\)/, `the ${kind} body takes the chat line-height`)

    // The root rule alone is not enough: each card's own `_body` restates
    // `font: var(--dsw-font-markdown-code-block)`, which resets the size to 14px.
    // They are code viewers, so they keep the code step — the same 12px the
    // markdown code block uses — not the prose size.
    const code = lastRule(`${card} [data-${kind}] [class*='_body']`)
    assert.ok(code, `the ${kind} code body must be styled`)
    assert.match(code, /font-family:\s*var\(--dsh-chat-font, inherit\)/, `the ${kind} code body takes the chat face`)
    assert.match(code, /font-size:\s*12px/, `the ${kind} code body keeps the code step`)
  }

  // The search card's header is chrome: its match summary and copy button were
  // `--dsw-font-xs-13` in the system face.
  for (const leaf of ['_summary', '_copyButton']) {
    const body = lastRule(`${card} [data-search] [class*='${leaf}']`)
    assert.ok(body, `the search ${leaf} must be styled`)
    assert.match(body, /font-family:\s*var\(--dsh-chat-font, inherit\)/, `the search ${leaf} takes the chat face`)
    assert.match(body, /font-size:\s*var\(--dsh-chat-font-size\)/, `the search ${leaf} takes the chat size`)
  }

  // The code-block banner is a chrome strip belonging to the code block, which the
  // theme keeps on its own 11px/18px step (it carries 11px icons and a language
  // tag). Only the face is repainted, so the strip reads in the theme's typeface
  // without resizing the code it labels.
  const banner = lastRule(`${card} [data-code-block-banner]`)
  assert.ok(banner, 'the code-block banner must be styled')
  assert.match(banner, /font-family:\s*var\(--dsh-chat-font, inherit\)/, 'the banner takes the chat face')
  assert.doesNotMatch(banner, /font-size:/, "the banner keeps the code block's own step")

  // Two leaves inside the card name `--ds-font-family-code` themselves and so are
  // not reached by any ancestor rule: the banner's language tag and the diff stat.
  // Only their face moves; their sizes are deliberate (11px chrome, and a count
  // derived one step below the row).
  const language = lastRule(`${card} [data-code-block-banner] [class*='_language']`)
  assert.ok(language, 'the language tag must be styled')
  assert.match(language, /font-family:\s*var\(--dsh-chat-font, inherit\)/, 'the language tag takes the chat face')
  assert.doesNotMatch(language, /font-size:/, 'the language tag keeps the banner step')

  const diffStat = lastRule(`${card} [class*='diffStat']`)
  assert.ok(diffStat, 'the diff stat must be styled')
  assert.match(diffStat, /font-family:\s*var\(--dsh-chat-font, inherit\)/, 'the diff stat takes the chat face')
  assert.doesNotMatch(diffStat, /font-size:/, 'the diff stat keeps its derived count size')

  // The inspect card states `--dsw-font-xs-13` in the system face on its root, so
  // everything that inherits is the right size in the wrong face; its caption,
  // badge, subtitle and description state 12px themselves. Addressed by the
  // stable `_localName` suffix, which is unique to that card inside a process
  // card (checked against the live tree). Its `_code` declares its own size, so
  // the code keeps the code scale.
  const inspect = lastRule(`${card} [data-inspect]`)
  assert.ok(inspect, 'the inspect card must be styled')
  assert.match(inspect, /font-family:\s*var\(--dsh-chat-font, inherit\)/, 'the inspect card takes the chat face')

  for (const [selector, what] of [
    [`${card} [class*='_caption']`, 'the inspect caption'],
    [`${card} [class*='_badge']`, 'the inspect badge'],
    [`${card} [class*='_subtitle']`, 'the inspect subtitle'],
    [`${card} [class*='_description']`, 'the inspect description'],
  ]) {
    const body = lastRule(selector)
    assert.ok(body, `${what} must be styled`)
    assert.match(body, /font-family:\s*var\(--dsh-chat-font, inherit\)/, `${what} takes the chat face`)
    assert.match(body, /font-size:\s*var\(--dsh-chat-font-size\)/, `${what} takes the chat size`)
    assert.match(body, /line-height:\s*var\(--dsh-chat-line-height\)/, `${what} takes the chat line-height`)
  }
})

test('inline code follows the prose instead of the host 0.875em step', () => {
  // The host sets `code { font-size: .875em !important }`, so 13px prose renders
  // its inline code at 11.375px — a third size between prose and the 12px block
  // scale. Only `!important` outranks the host's own `!important`.
  const body = lastRule(
    "body [data-chat-flow-kind='assistant-step'] [class*='_markdown'] :not(pre) > code",
  )
  assert.ok(body, 'inline code must be styled')
  assert.match(body, /font-size:\s*var\(--dsh-chat-font-size\)\s*!important/, 'the host em-based size must be beaten')

  // Inside a heading the chip stays `1em`: pinning it to 13px would put a small
  // chip in the middle of an 18–22px line. The descendant form is deliberate — a
  // chip sits directly in the heading, so `h2 :not(pre) > code` (an element inside
  // a non-`pre` element inside the heading) never matches it.
  const inHeading = lastRule(
    "body [data-chat-flow-kind='assistant-step'] [class*='_markdown'] h2 code",
  )
  assert.ok(inHeading, 'heading inline code must be styled')
  assert.match(inHeading, /font-size:\s*1em\s*!important/, 'a heading chip follows its heading')
})

test('a failed turn speaks in the transcript type scale', () => {
  // 「任务已停止」 renders `div.Sixlwa_turnErrorRow` at 15px/22px from the host's
  // `--dsh-content-font-size-secondary` + delta tokens: one size up from every
  // other row in the transcript, on the same surface.
  const kinds = ['turn-error', 'turn-max-tokens']
  for (const kind of kinds) {
    const row = lastRule(`body [data-chat-flow-kind='${kind}'] [class*='turnErrorRow']`)
    assert.ok(row, `the ${kind} row must be styled`)
    assert.match(row, /font-size:\s*var\(--dsh-chat-font-size\)/, `the ${kind} row takes the chat size`)
    assert.match(row, /line-height:\s*var\(--dsh-chat-line-height\)/, `the ${kind} row takes the chat line-height`)
  }
  for (const [kind, leaf] of [
    ['turn-error', 'turnErrorTitle'],
    ['turn-error', 'turnErrorMessage'],
    ['turn-max-tokens', 'turnErrorMessage'],
    ['turn-max-tokens', 'maxTokensTitle'],
  ]) {
    const body = lastRule(`body [data-chat-flow-kind='${kind}'] [class*='${leaf}']`)
    assert.ok(body, `the failure leaf ${leaf} must be styled`)
    assert.match(body, /font-family:\s*var\(--dsh-chat-font, inherit\)/, `${leaf} takes the chat face`)
    assert.match(body, /font-size:\s*var\(--dsh-chat-font-size\)/, `${leaf} takes the chat size`)
  }

  // A warning surface reads as a warning through the theme's own amber, not the
  // host's `state-warn-primary`; the token carries the light/dark pair.
  const warn = lastRule("body [data-chat-flow-kind='turn-max-tokens'] [class*='maxTokensTitle']")
  assert.ok(warn, 'the token-cap notice must be styled')
  assert.match(warn, /color:\s*var\(--dsh-theme-warn\)/, 'the warning ink comes from the theme token')
})

test('rules competing with a base class carry a scope prefix', () => {
  // A bare `[data-x]` attribute selector has the same specificity as the base
  // theme's single class (0,1,0), and the base sheet is injected later, so the
  // base declaration silently wins. Each of these was measured losing in the
  // live UI before it was prefixed with `body` (0,1,1).
  const css = compiledCss()
  const scoped = [
    'body header[data-window-drag]',
    'body [data-composer-card]',
    'body [data-conversation-tabs]',
    'body [data-row-key^=\'session:\']',
  ]
  for (const selector of scoped) {
    assert.ok(css.includes(selector), `rule must carry the body scope prefix: ${selector}`)
  }
  // `min-height` is what beats the base `_panelRow` 36px, not `height`.
  const navRule = /body \[class\*='_panelRow'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(navRule, 'the sidebar nav row must be styled')
  assert.match(navRule[1], /min-height:\s*32px/, 'the nav row must set min-height')
})

test('the code block resets the pre margin the UA sheet supplies', () => {
  // The design's `<pre class="m-0 ...">` is load-bearing. With only font and
  // colour applied, the UA sheet's `1em 0` margin survived: measured 12px of
  // extra space above and below the code, on top of the block's own 14px
  // padding (`p-3.5`).
  const css = compiledCss()
  const rule = /body \.md-code-block pre\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the code block pre must be styled')
  assert.match(rule[1], /margin:\s*0/, 'the pre margin must be reset')
})

test('the stylesheet source uses @apply rather than runtime utilities', () => {
  // The design's own utility strings are the source, resolved at build time.
  // Shipping them as runtime classes does not work: measured, a plain utility
  // loses to the host's own single-class rules, and React overwrites
  // `className` wholesale on re-render.
  assert.ok(stylesheetSource.includes('@tailwind utilities'), 'the source must opt into Tailwind utilities')
  assert.ok(/@apply\s/.test(stylesheetSource), 'the source must resolve utilities with @apply')
})

test('the CJK face registers a real bold instead of a synthesised one', () => {
  // LXGW WenKai Mono ships Regular (400) and Medium (500) and no Bold. With only
  // the 400 face declared, the host's `strong { font-weight: 600 }` had no
  // matching face, so the browser smeared the 400 outline. Measured on the live
  // host at 56px, `加粗文字测试` gained +15.25% ink from 400→600 and exactly
  // 0% from 600→700 — synthetic weight saturates. Latin was unaffected (Fira
  // Code is variable to 700), so CJK prose is where bold read as weak.
  const css = compiledCss()
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1])
  const cjk = faces.filter((f) => /font-family:\s*'LXGW WenKai Mono'/.test(f))
  assert.equal(cjk.length, 2, 'the CJK family must declare both cuts')
  const weights = cjk.map((f) => /font-weight:\s*([^;]+);/.exec(f)[1].trim())
  assert.ok(weights.includes('400'), 'the Regular cut must stay registered')
  const heavy = weights.find((w) => w !== '400')
  assert.ok(heavy, 'a heavier cut must be registered')
  // The range must start at 500, not 600: a 500 request would otherwise still be
  // synthesised from the 400 face.
  assert.match(heavy, /^500\s+700$/, 'the Medium cut must cover 500 through 700')
  const medium = cjk.find((f) => /font-weight:\s*500\s+700/.test(f))
  assert.ok(
    medium.includes('/dsh-macos-theme/fonts/LXGWWenKaiMono-Medium-GB.woff2'),
    'the Medium cut must load from the plugin route',
  )
  assert.ok(medium.includes('font-display: swap'), 'the Medium cut must not block first paint')
  // It has to ship, or the request 404s and the browser falls back to smearing.
  const files = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.ok(
    files.includes("'LXGWWenKaiMono-Medium-GB.woff2'"),
    'the host half must whitelist the Medium file, or its route answers 404',
  )
})

test('the chat typeface can be switched off from the plugin settings', () => {
  // The opt-out has to reach every font rule at once. It is expressed as a
  // single gated custom property rather than a rule per surface, so the number
  // of `inherit` fallbacks must equal the number of `font-family` reads — a new
  // font rule that forgot the fallback would otherwise stay themed with the
  // toggle off.
  const css = compiledCss()
  const gate = /body:not\(\[data-dsh-native-chat-font\]\)\s*\{[^}]*--dsh-chat-font:\s*'Fira Code'/.exec(css)
  assert.ok(gate, 'the stack must be defined only while the replacement is on')
  const reads = [...css.matchAll(/font-family:\s*var\(--dsh-chat-font([^)]*)\)/g)]
  assert.ok(reads.length > 0, 'the stylesheet must read the chat font variable')
  for (const [, fallback] of reads) {
    assert.match(fallback, /^\s*,\s*inherit$/, 'every read must fall back to the inherited stack')
  }
  // The browser half owns the attribute, driven by the plugin's own config.
  assert.ok(
    clientSource.includes("hasAttribute(NATIVE_FONT_ATTR)"),
    'the browser half must drive the attribute from the stored config',
  )
  // The card renders the schema through the shared layer rather than writing the
  // key itself: the schema is then the only place the field is declared, so a
  // renamed or added key cannot drift from a hand-written control.
  assert.ok(
    /UI\.ConfigForm/.test(clientSource),
    'the settings card must render the schema through the shared ConfigForm',
  )
  assert.ok(
    !clientSource.includes("scope.set('replaceChatFont'"),
    'the card must not hand-write the write path the shared form owns',
  )
  // The two halves must agree on the key and the entry id, or the card renders
  // against a namespace that has no such field.
  const host = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.ok(host.includes('replaceChatFont'), 'the host schema must declare the key the card writes')
  assert.ok(/export const Config = Schema\.object\(/.test(host), 'the schema must be exported from the package entry')
  assert.ok(host.includes('Schema.boolean()'), 'the field must be a boolean')
  assert.ok(host.includes('.volatile()'), 'the field must be volatile, or it cannot be edited live')
  // The schema is the page: the label the user reads has to live beside the key,
  // or the shared projection falls back to the bare key name.
  assert.ok(
    /replaceChatFont[\s\S]{0,120}\.comment\('/.test(host),
    'the field must carry a comment, which is the label the page renders',
  )
  assert.ok(clientSource.includes("var NS = 'macos-theme'"), 'the card must address the host entry id')
})

test('popups and hover feedback are themed, not left at the host defaults', () => {
  // Menus, dialogs and tooltips are portalled to `body`, so they inherit none of
  // the column surfaces — they are painted entirely from tokens. These are the
  // ones the host consumes but the theme did not override, which is why the
  // dropdowns kept the host's neutral grey (dark `--dsw-menu-surface-fill`
  // resolves to `rgba(67,69,74,0.45)`).
  const block = clientSource.slice(clientSource.indexOf('var TOKENS = {'))
  const body = block.slice(0, block.indexOf('\n    }'))
  for (const name of [
    '--dsw-menu-surface-fill',
    '--dsw-menu-backdrop-filter',
    '--dsw-alias-button-tool-bar-hover',
    '--dsw-alias-tooltip-key-bg',
    '--dsw-mask-blur',
    '--dsw-radius-panel',
    '--dsw-radius-md',
    '--dsw-radius-lg',
    '--dsw-radius-sm',
  ]) {
    assert.ok(body.includes(`'${name}'`), `${name} must be themed, or its popup keeps the host default`)
  }
  // The menu material is a translucent fill behind a blur; overriding only the
  // fill would leave the host's 40px blur, which is what made the surface read
  // as a foreign grey.
  assert.ok(
    body.includes("'--dsw-menu-backdrop-filter': { light: 'blur(24px)"),
    'the menu backdrop blur must be themed alongside its fill',
  )
})

test('the elevation shadows reach the portalled popups', () => {
  // These four cannot go through `overrideTokens`. The host's own theme plugin
  // declares them on a universal selector:
  //
  //   body, body * { --dsw-elevation-stroke: …; --dsw-elevation-panel: …;
  //                  --dsw-elevation-prominent: …; --dsw-elevation-soft: … }
  //
  // A token override is written as an inline style on `body`, which loses to
  // `body *` on every descendant — and every popup is a direct child of `body`.
  // Measured on the live host: a fresh body child resolved the host's
  // `0 0 0 .5px rgba(15,23,42,.04), …` while `body` resolved the plugin's value,
  // so no menu ever saw the theme's shadow. The fix is to re-declare them in CSS
  // on the same universal selector, where injection order breaks the tie.
  // Comments are stripped first: the source explains the selector in prose, and
  // a naive match would find that text instead of the rule.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  // The leading `html` is load-bearing. At equal specificity (`body, body *`)
  // the host's own rule still won the tie and the popup kept the host shadow, so
  // the extra type selector is what actually makes the override stick.
  const rule = /html body,\s*html body \*\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the elevation shadows must be re-declared above the host specificity')
  for (const name of [
    '--dsw-elevation-stroke',
    '--dsw-elevation-panel',
    '--dsw-elevation-prominent',
    '--dsw-elevation-soft',
  ]) {
    assert.ok(rule[1].includes(name), `${name} must be re-declared, or every popup keeps the host shadow`)
  }
  // `elevation-stroke` composes from the colour, so the colour has to stay a
  // token: it is the one part the host does not re-declare per element.
  assert.ok(
    rule[1].includes('var(--dsw-elevation-stroke-color)'),
    'the stroke must stay composed from the colour token',
  )
  const block = clientSource.slice(clientSource.indexOf('var TOKENS = {'))
  assert.ok(
    block.slice(0, block.indexOf('\n    }')).includes("'--dsw-elevation-stroke-color'"),
    'the stroke colour must be themed',
  )
  // Dark mode needs its own shadows: the light ones are tuned for a white page
  // and read as a grey halo on the dark palette.
  const dark = /html body\[data-ds-dark-theme\],\s*html body\[data-ds-dark-theme\] \*\s*\{([^}]*)\}/.exec(css)
  assert.ok(dark, 'the dark palette must re-point the shadows')
  assert.ok(dark[1].includes('rgba(0, 0, 0, 0.55)'), 'the dark shadows must be dark, not the light values')
  // The shadows must NOT also sit in the token layer: that layer cannot reach a
  // descendant, so a copy there would be dead code that reads as if it worked.
  for (const name of ['--dsw-elevation-panel', '--dsw-elevation-prominent']) {
    assert.equal(
      clientSource.includes(`'${name}':`),
      false,
      `${name} must not be in TOKENS — the host re-declares it per element, so it would be inert`,
    )
  }
})

test('the app-root height chain does not stretch the portalled popups', () => {
  // The window fills the padded desktop through a percentage height chain, and
  // the app root is an anonymous `body > div`. Writing that as a bare
  // `body > div { height: 100% }` also matched every popup, because the host
  // portals its menus, dropdowns and hover cards straight into `body`. Measured
  // on the live host: the sidebar menu came back 905px tall (its own
  // `max-height: calc(100vh - 24px)` resolving against a full-viewport box),
  // and the same rule pinned the hover card to the window height. Scoping the
  // rule to the root keeps the window filled and lets the popups size to content.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(
    /(^|})\s*body > div\s*[,{]/.test(css),
    false,
    'a bare `body > div` height rule also stretches every portalled popup',
  )
  assert.ok(
    /body > div:has\(> \[data-slot='root'\]\)/.test(css),
    'the height must be scoped to the app root so the window still fills the desktop',
  )
  assert.ok(
    /body \[data-slot='root'\]\s*\{[^}]*height: 100%/.test(css),
    'the root itself must still carry the height',
  )
})

test('the completed pill is padded like the design, not like a separator row', () => {
  // The host renders this row as a bottom-bordered separator (`padding: 0 0 8px`).
  // Restyled into the design's filled pill that 8px stops being a separator gap
  // and becomes visible off-centre whitespace: measured live, the label sat 1px
  // from the top and 9px from the bottom of a 33px pill. The design's own markup
  // is `h-[33px] px-3 … flex items-center`, so the padding must be symmetric.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /body \[data-turn-process\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the completed pill must have its own rule')
  assert.ok(/padding: 0 12px/.test(rule[1]), 'the pill must use the design’s symmetric px-3 padding')
  assert.equal(
    /padding-bottom: 8px|padding: 0 0 8px/.test(rule[1]),
    false,
    'the host’s separator padding must not survive — it makes the label sit off-centre',
  )
})

test('the gradient ring narrows with the viewport instead of staying at the desktop value', () => {
  // The host ships no layout breakpoints at all — the only `@media` rules in its
  // client bundles are `prefers-reduced-motion` and `hover` — so the ring is the
  // theme's own responsibility. Measured before this layer existed: a 390px phone
  // still paid the full 24px ring, leaving a 342px window, i.e. 12% of the screen
  // spent on the desktop backdrop.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const base = /\nbody\s*\{([^}]*)\}/.exec(css)
  assert.ok(base, 'the desktop ring must stay on `body`')
  assert.match(base[1], /padding:\s*16px/, 'the desktop ring is 16px')

  const tablet = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(tablet, 'tablets need their own ring step')
  assert.match(tablet[1], /padding:\s*12px/, 'the tablet ring is 12px')

  const phone = /@media \(max-width: 600px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(phone, 'phones need their own ring step')
  assert.match(phone[1], /padding:\s*8px/, 'the phone ring is 8px')

  // Landscape phones are wider than 600px but have almost no vertical room, so
  // they need a height-based step as well.
  const short = /@media \(max-height: 480px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(short, 'landscape phones must tighten the ring on height')
  assert.match(short[1], /padding:\s*8px/, 'a short viewport gets the phone ring')
})

test('the header status cluster is dropped at phone width only', () => {
  // The host renders the title plus three status chips (subagent count / mode /
  // background task) into a two-column grid whose second column is `auto`.
  // Measured, that cluster is 310px wide; on a phone the whole centre column is
  // only ~294px, so the grid squeezed the title to 12px and the chips overflowed
  // the frame. At tablet width and above it fits with room for the title, so the
  // rule must NOT be in the 900px block.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const phone = /@media \(max-width: 600px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(phone, 'the phone block must exist')
  assert.match(
    phone[1],
    /\[data-slot='conversation\.session\.header\.actions'\]\s*>\s*\*\s*\{[^}]*display:\s*none/,
    'the status cluster must be hidden at phone width, anchored on its data-slot',
  )

  const tablet = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.equal(
    /header\.actions/.test(tablet[1]),
    false,
    'tablets have room for the cluster — it must not be hidden there',
  )

  // The sidebar toggle lives in the header corner, not in the actions slot, so
  // hiding the cluster must not take it with it.
  assert.equal(
    /header\.corner[^}]*display:\s*none/.test(css),
    false,
    'the sidebar toggle must survive — it is the only header control left on a phone',
  )
})

test('the responsive layer anchors on data attributes, never on hashed class names', () => {
  // Class-name hashes differ between the local build and CI (`X_2TxG_*` locally
  // vs another prefix in CI), so any selector built from one is broken in one of
  // the two. The breakpoints must use the host's published data attributes.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const mediaBlocks = [...css.matchAll(/@media[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1])
  assert.ok(mediaBlocks.length >= 3, 'the responsive layer must ship its breakpoints')
  for (const block of mediaBlocks) {
    const hashed = /\[class\*=["'][A-Za-z0-9_-]{6,}_/.exec(block)
    assert.equal(hashed, null, `a breakpoint anchored on a hashed class name: ${hashed?.[0]}`)
  }
})

test('the header more-actions menu is dropped at every width', () => {
  // The menu (download session log / feedback) is rendered by
  // `dsh-session-log-export` into the `conversation.session.header.utilities`
  // slot as a bare `<span>` around one button, with no `data-*` of its own. Its
  // sibling in that slot is the Finder open-target group, which does publish
  // `data-open-target`, so the discriminator is that absence. Measured live, the
  // slot holds exactly two spans: one with two buttons (Finder + "more open
  // with") and one with a single button (this menu).
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /body \[data-slot='conversation\.session\.header\.utilities'\] > span:not\(:has\(\[data-open-target\]\)\)\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the menu must be addressed through its data-slot and the missing attribute')
  assert.match(rule[1], /display:\s*none/, 'the menu must be hidden')

  // It is hidden unconditionally, so it must sit outside every breakpoint.
  const mediaBlocks = [...css.matchAll(/@media[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1])
  for (const block of mediaBlocks) {
    assert.equal(
      /header\.utilities/.test(block),
      false,
      'the menu is hidden at every width — it must not be inside a breakpoint',
    )
  }
})

test('the phone drops the settings button and the Finder menu, and shrinks the chips', () => {
  // Both are addressed by a stable data attribute, and both hide the slot's CHILD
  // rather than the slot: measured, both slots carry an inline `display: contents`
  // written by the host on the slot element itself, which beats any `display` a
  // stylesheet can declare on that same element.
  //
  // The composer's permission chip is deliberately NOT in this list any more. It
  // used to be dropped here while 主检出 kept its full label, so the row's left
  // edge changed shape depending on which plugins were mounted; now every chip
  // steps down to a 28px icon square together (asserted below).
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const mobile = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(mobile, 'the mobile block must exist')
  for (const slot of ['settings.launcher']) {
    assert.ok(
      new RegExp(`\\[data-slot='${slot.replace('.', '\\.')}'\\]\\s*>\\s*\\*`).test(mobile[1]),
      `${slot} must hide its child, not the slot itself (the slot is display:contents)`,
    )
  }
  assert.match(mobile[1], /\[data-open-target='directory'\]/, 'the Finder menu must be hidden on mobile')
  assert.equal(
    /\[data-slot='conversation\.input\.permission'\]\s*>\s*\*/.test(mobile[1]),
    false,
    'the permission chip must not be dropped — it shrinks to an icon like its neighbours',
  )

  // Each must NOT be hidden unconditionally — a desktop still carries both.
  const outside = css.replace(mobile[0], '')
  for (const sel of ["[data-slot='settings.launcher']", "[data-open-target='directory']"]) {
    assert.equal(
      new RegExp(`${sel.replace(/[[\]]/g, '\\$&')}\\s*\\{[^}]*display:\\s*none`).test(outside),
      false,
      `${sel} must survive on the desktop`,
    )
  }
})

test('the composer chips step down to an icon square together on 移动端', () => {
  // The label of 主检出 is a BARE TEXT NODE inside the button
  // (`<span class=icon/><svg/></span>主检出`), so there is no element to hide —
  // `font-size: 0` on the button is what removes it, and the icon keeps its size
  // from the explicit `svg` rule in section 8 (a length, not an em).
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const mobile = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(mobile, 'the mobile block must exist')

  const square = /body \[data-composer-card\] \[data-slot='conversation\.input\.permission'\] button,\s*body \[data-composer-card\] \[data-slot='conversation\.input\.left'\] button\[class\*='_ghost'\],\s*body \[data-composer-card\] \[data-slot='conversation\.input\.model'\] button\[class\*='_trigger'\]\s*\{([^}]*)\}/.exec(mobile[1])
  assert.ok(square, 'all three chips must share one 移动端 rule')
  assert.match(square[1], /width:\s*1\.75rem/, 'the chip must become a 28px square')
  assert.match(square[1], /justify-content:\s*center/, 'the icon must be centred once the label is gone')
  assert.match(square[1], /font-size:\s*0/, "font-size:0 is the only way to drop 主检出's bare text node")
  assert.equal(/display:\s*none/.test(square[1]), false, 'the chip itself must stay — it is the only permission control left')

  // 完全权限's label IS a real span, so it is hidden by name as well rather than
  // relying on the inherited zero. It shares one declaration block with the
  // model seat's parts, so the selector list around it is what is read.
  assert.match(
    mobile[1],
    /[^{}]*\[data-slot='conversation\.input\.permission'\] button \[class\*='_triggerLabel'\][^{}]*\{[^}]*display:\s*none/,
    'the permission label must be hidden by name too',
  )

  // The model seat: label, 推理等级 and chevron are all real elements, and the
  // icon has to be forced on because the host's compact variables only apply
  // when the host itself decided to compact the pill.
  for (const [what, suffix] of [
    ['the model name', '_triggerLabel'],
    ['the reasoning effort', '_triggerEffort'],
    ['the chevron', 'chevron'],
  ]) {
    assert.match(
      mobile[1],
      new RegExp(`\\[data-slot='conversation\\.input\\.model'\\] button\\[class\\*='_trigger'\\] \\[class\\*='${suffix}'\\][^{]*\\{[^}]*display:\\s*none`),
      `${what} must be dropped from the mobile model square`,
    )
  }
  const modelIcon = /\[data-slot='conversation\.input\.model'\] button\[class\*='_trigger'\] svg\[class\*='_triggerIcon'\]\s*\{([^}]*)\}/.exec(mobile[1])
  assert.ok(modelIcon, 'the model square must keep its glyph')
  assert.match(modelIcon[1], /display:\s*block/, "the glyph must not depend on the host's compact variables")
  assert.match(modelIcon[1], /height:\s*0\.875rem/, 'the glyph matches the two chips beside it at 14px')
  assert.match(modelIcon[1], /width:\s*0\.875rem/, 'the glyph matches the two chips beside it at 14px')

  // The pill's `rounded-full` is section 8's shape for a text pill; at 28x28 it
  // would be the only circle among two rounded squares.
  assert.match(
    mobile[1],
    /\[data-slot='conversation\.input\.model'\] button\[class\*='_trigger'\]\s*\{[^}]*border-radius:\s*8px/,
    'the mobile model square must take the chip radius',
  )

  // Nothing of this may leak above the breakpoint.
  const outside = css.replace(mobile[0], '')
  assert.equal(/font-size:\s*0/.test(outside), false, 'the chips keep their labels on the desktop')
  for (const suffix of ['_triggerLabel', '_triggerEffort']) {
    assert.equal(
      new RegExp(`\\[data-slot='conversation\\.input\\.model'\\] button\\[class\\*='_trigger'\\] \\[class\\*='${suffix}'\\][^{]*\\{[^}]*display:\\s*none`).test(outside),
      false,
      `the desktop keeps the model ${suffix}`,
    )
  }
  assert.equal(
    /\[data-slot='conversation\.input\.permission'\] button \[class\*='_triggerLabel'\]\s*\{[^}]*display:\s*none/.test(outside),
    false,
    'the desktop keeps the permission label',
  )
})

test('the two host chips are normalised to one shape', () => {
  // They share the fill and height, but arrive from different components:
  // 完全权限 is the permission preset's `_trigger` (14px icon, label span,
  // chevron), 主检出 is the worktree picker's `_ghost_ _sm_` primitive (16px
  // icon, a bare text node, no chevron). Measured at 1600px before this rule:
  // 112x28 next to 83x28, with a 14px glyph beside a 16px one.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')

  const icon = /body \[data-composer-card\] \[data-slot='conversation\.input\.left'\] button\[class\*='_ghost'] svg,\s*body \[data-composer-card\] \[data-slot='conversation\.input\.permission'\] button svg\s*\{([^}]*)\}/.exec(css)
  assert.ok(icon, 'both chips must share one icon size')
  assert.match(icon[1], /height:\s*0\.875rem/, 'the design draws both icons at 14px (w-3.5)')
  assert.match(icon[1], /width:\s*0\.875rem/, 'the design draws both icons at 14px (w-3.5)')

  // The chevron is the host's own affordance and the design draws neither chip
  // with one, so it was the last structural difference between two controls the
  // design treats as identical.
  assert.match(
    css,
    /\[data-slot='conversation\.input\.permission'\] button \[class\*='chevron'\]\s*\{[^}]*display:\s*none/,
    'the permission chevron must be dropped — the design draws neither chip with one',
  )

  // 主检出 is anchored through `_ghost`, not the whole slot: the slot also
  // carries other plugins' buttons (the workbench entry is one).
  assert.ok(
    css.includes("[data-slot='conversation.input.left'] button[class*='_ghost']"),
    '主检出 must be anchored through its own class, not the whole slot',
  )

  // The two labels sat in different line boxes — 完全权限 at 20px, 主检出 at 18px,
  // each inherited from its own host component. Both centred on the same axis
  // (measured cy=835.86), so this is about the box, not the baseline.
  const lh = /body \[data-composer-card\] \[data-slot='conversation\.input\.left'\] button\[class\*='_ghost'\],\s*body \[data-composer-card\] \[data-slot='conversation\.input\.permission'\] button\s*\{([^}]*)\}/.exec(css)
  assert.ok(lh, 'both chips must share one line box')
  assert.match(lh[1], /line-height:\s*18px/, 'the two labels must sit in the same 18px line box')
})

test('the model seat wears a chip glyph, not the host database glyph', () => {
  // The host renders `IconDataOutlineRegular` — a database — on the model seat,
  // which says "storage", not "model". The artwork cannot be replaced in the
  // DOM, so it is replaced as a MASK: the host's own two paths are hidden and
  // the svg paints `currentColor` through the glyph supplied here. Leaving the
  // colour on the host's `color` is what lets one rule serve both palettes.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /body \[data-composer-card\] \[data-slot='conversation\.input\.model'\] button\[class\*='_trigger'\] svg\[class\*='_triggerIcon'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the model seat glyph must be redrawn')
  assert.match(rule[1], /background-color:\s*currentColor/, "the glyph must take the pill's own colour, in both palettes")
  assert.match(rule[1], /mask-image:\s*url\(/, 'the replacement glyph is a mask')
  assert.match(rule[1], /-webkit-mask-image:\s*url\(/, 'the mask needs its -webkit- form too')
  assert.match(rule[1], /mask-size:\s*100% 100%/, 'the glyph must fill the 14px box')
  assert.equal(/mask-image[^;]*#/.test(rule[1]), false, 'the mask is a shape, so it must not carry a palette colour')

  // The host's two database paths have to go, or they paint over the mask.
  assert.match(
    css,
    /\[data-slot='conversation\.input\.model'\] button\[class\*='_trigger'\] svg\[class\*='_triggerIcon'\]\s*>\s*\*\s*\{[^}]*display:\s*none/,
    "the host's own paths must be hidden",
  )

  // Scoped to the model slot: `_triggerIcon` is a substring anchor, and the
  // permission chip's shield must keep its own artwork.
  const iconSelectors = [...css.matchAll(/(^|\})\s*([^{}]*\[class\*='_triggerIcon'\][^{}]*)\{/g)].map((m) => m[2].trim())
  assert.ok(iconSelectors.length > 0, 'the glyph rules must be found')
  for (const selector of iconSelectors) {
    assert.ok(
      selector.includes("[data-slot='conversation.input.model']"),
      `the glyph rule must be scoped to the model slot: ${selector}`,
    )
  }
})

/**
 * The composer keymap the theme installs. `nextListPrefix` is the only pure
 * decision in it, so the shipped bytes are extracted and exercised directly
 * instead of being restated as a regex — a table over the real function is what
 * makes "the list continues" verifiable at all.
 */
function composerPrefix() {
  // The patterns are module-level constants, so the slice has to start at them
  // rather than at the function that reads them.
  const match = /var LIST_PREFIX = [\s\S]*?function nextListPrefix\(line\) \{[\s\S]*?\n    \}/.exec(clientSource)
  assert.ok(match, 'the built client half must carry the list-prefix decision')
  return new Function(`${match[0]}\nreturn nextListPrefix`)()
}

test('the composer continues a list on the next line', () => {
  const next = composerPrefix()
  const table = [
    ['- 项目', '- '],
    ['* 项目', '* '],
    ['+ 项目', '+ '],
    ['1. 项目', '2. '],
    ['9. 项目', '10. '],
    ['1) 项目', '2) '],
    ['  - 项目', '  - '],
    ['- [ ] 项目', '- [ ] '],
    ['- [x] 项目', '- [ ] '],
  ]
  for (const [line, expected] of table) {
    assert.equal(next(line), expected, `${JSON.stringify(line)} must continue as ${JSON.stringify(expected)}`)
  }

  // An empty item ends the list rather than adding another empty bullet; that is
  // signalled by `''`, which is distinct from "not a list" (`null`).
  for (const line of ['- ', '1. ', '  * ', '- [ ] ']) {
    assert.equal(next(line), '', `${JSON.stringify(line)} must end the list`)
  }

  // A bare marker is not a list item, and neither is ordinary prose.
  for (const line of ['-', '普通文字', '', 'a - b', '# 标题']) {
    assert.equal(next(line), null, `${JSON.stringify(line)} must not be treated as a list item`)
  }

  // The decision must read the WHOLE line, not just the part before the caret.
  // Measured on the live composer: with the caret inside `- abc` (offset 2) a
  // before-the-caret reading sees `- `, concludes "empty item", and deletes the
  // marker of a list item that is not empty. So the caller must hand over the
  // caret's line reassembled, and must refuse to call this at all when the
  // selection is not collapsed.
  assert.match(
    clientSource,
    /caret\.collapsed \? nextListPrefix\(at\.before \+ at\.after\) : null/,
    'an empty item must be judged from the whole line, and never while text is selected',
  )
  assert.match(
    clientSource,
    /return \{ block: block, before: before\.toString\(\), after: after\.toString\(\) \}/,
    'the caret line must be split at the caret so both halves are available',
  )
})

test('ending a list replays the host backspace rather than editing the DOM', () => {
  // `document.execCommand('delete')` over the marker reports success and changes
  // nothing on the live Lexical editor, so the host's own backspace is replayed
  // instead — the same delegation the submit path uses.
  assert.match(
    clientSource,
    /pressBackspace\(root, at\.before\.length\)/,
    'the marker must be removed by as many backspaces as it is long',
  )
  const backspace = /function pressBackspace\(root, times\) \{[\s\S]*?\n      \}/.exec(clientSource)
  assert.ok(backspace, 'the backspace replay must exist')
  assert.match(backspace[0], /key: 'Backspace'/, 'it must replay the real key the host handles')
  assert.equal(
    /execCommand\('delete'\)/.test(clientSource),
    false,
    'the destructive DOM delete must not come back',
  )
})

test('the composer keymap breaks the line on Enter and submits on Ctrl/Cmd+Enter', () => {
  // Capture phase is load-bearing: the host registers its own Enter handler on
  // the editor, so ours must run first to be able to decide at all.
  assert.match(
    clientSource,
    /document\.addEventListener\('keydown',\s*onKeyDown,\s*true\)/,
    'the keymap must listen in the capture phase',
  )
  assert.match(
    clientSource,
    /document\.removeEventListener\('keydown',\s*onKeyDown,\s*true\)/,
    'the listener must be removable, or a hot reload stacks copies',
  )

  // Submit is delegated, not reimplemented: the host's handler is the only thing
  // that knows how to submit, and it reads a plain `shiftKey`.
  const replay = /function replay\(root, shiftKey\) \{[\s\S]*?\n      \}/.exec(clientSource)
  assert.ok(replay, 'the keymap must delegate by replaying the event')
  assert.match(replay[0], /shiftKey:\s*shiftKey/, 'the replay must carry the flag it is given')

  // Ctrl/Cmd+Enter is the ONLY submit. The replay passes `false`, which is the
  // host's "submit" reading of the flag.
  assert.match(
    clientSource,
    /if \(event\.ctrlKey \|\| event\.metaKey\) \{\s*\n\s*replay\(root, false\)/,
    'Ctrl/Cmd+Enter must submit',
  )
  // Alt+Enter stays with the host (it is not a line break the design asks for).
  assert.match(clientSource, /if \(event\.altKey\) return/, 'Alt+Enter must be left to the host')

  // Plain Enter and Shift+Enter both fall through to the line break, so neither
  // may appear in a submit branch, and the line break must not be gated on the
  // viewport any more — the two keys now behave the same everywhere.
  const submitBranch = /if \(event\.ctrlKey \|\| event\.metaKey\) \{[\s\S]*?\n        \}/.exec(clientSource)
  assert.ok(submitBranch, 'the submit branch must exist')
  assert.equal(
    /shiftKey/.test(submitBranch[0].replace(/replay\(root, false\)/, '')),
    false,
    'Shift+Enter must not submit any more',
  )
  // A viewport gate is a `matchMedia` on a WIDTH query. A colour-scheme query is
  // not one, and the device-theme override legitimately asks the system whether
  // it prefers dark, so the assertion names the width form rather than the API.
  assert.equal(
    /matchMedia\(\s*['"`]\([^'"`]*width/.test(clientSource),
    false,
    'the line break is no longer viewport-dependent, so no viewport gate may remain',
  )

  // An open suggestion popup owns Enter (it accepts the highlighted row), so the
  // keymap must stand down while one is showing.
  assert.match(
    clientSource,
    /querySelector\('\[role="listbox"\]'\)[\s\S]{0,120}getClientRects\(\)\.length > 0\)\s*return/,
    'the keymap must leave Enter to an open suggestion popup',
  )

  // Both halves of the remap must consume the event, or the host's own Enter
  // handler would also act on it and the draft would both break and submit.
  assert.match(clientSource, /event\.preventDefault\(\)/, 'the keymap must cancel the host default')
  assert.match(clientSource, /event\.stopPropagation\(\)/, 'the keymap must stop the event reaching the host')
})

test('移动端 drops the sidebar panel entries and reclaims the collapsed rail', () => {
  // Both halves of the request live in the 900px block, the same 移动端 line as
  // the rest of the responsive layer.
  const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '')
  const mobile = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(mobile, 'the mobile block must exist')
  const block = mobile[1]

  // 1. The two panel rows. The slot is what identifies them: measured live, each
  //    row is a `<button>` wrapping a `[data-slot='sidebar.panellist']` glyph, so
  //    this selector is about those two rows and not about "any sidebar button".
  assert.match(
    block,
    /button:has\(\[data-slot='sidebar\.panellist'\]\)\s*\{[^}]*display:\s*none/,
    'the panel entries must be hidden on 移动端',
  )

  // 2. The collapsed rail's track. The host writes the track list as an INLINE
  //    style on the frame, so without `!important` the rule loses to it and the
  //    56px rail stays exactly where it was — the change would be a no-op.
  const track = /\[data-slot='root'\]\s*>\s*div\[data-sidebar-collapsed='true'\]\s*\{([^}]*)\}/.exec(block)
  assert.ok(track, 'the collapsed frame must be addressed by its published state attribute')
  assert.match(track[1], /grid-template-columns:[^;]*0px[^;]*!important/, 'the first track must be zeroed, and !important is what outranks the inline style')

  // Only the collapsed state: expanded, the sidebar is a real drawer and the
  // host's own track list is already correct.
  assert.equal(
    /grid-template-columns[^}]*!important/.test(block.replace(track[0], '')),
    false,
    'the expanded frame must keep the host track list',
  )

  // 3. A zero-width track does not remove its contents — measured, the rail's
  //    buttons keep their boxes, stay focusable and still report
  //    `visibility: visible`, so hiding them is a separate necessary step.
  assert.match(
    block,
    /\[data-sidebar-collapsed='true'\]\s*\[data-slot='sidebar'\]\s*>\s*\*\s*\{[^}]*visibility:\s*hidden/,
    'the rail contents must be hidden, not merely squeezed to 0px',
  )

  // 4. The toggle is moved into the header, so it must escape the zeroed track:
  //    absolute positioning against the frame, and re-shown (the rule above hid
  //    it along with the rest of the rail).
  const toggle = /\[data-sidebar-collapsed='true'\]\s*button:has\(\[data-slot='sidebar\.toggle\.badge'\]\)\s*\{([^}]*)\}/.exec(block)
  assert.ok(toggle, 'the toggle must be addressed through its published slot')
  assert.match(toggle[1], /position:\s*absolute/, 'the toggle must leave the rail flow')
  assert.match(toggle[1], /visibility:\s*visible/, 'the toggle must be re-shown after the rail was hidden')

  // 5. The header inset that keeps the title clear of the relocated button.
  assert.match(
    block,
    /\[data-sidebar-collapsed='true'\]\s*header\[data-window-drag\]\s*\{[^}]*padding-left/,
    'the collapsed header must reserve room for the relocated toggle',
  )

  // None of it may leak to the desktop: a 1440px window keeps the rail, the
  // panel entries and the toggle's original placement.
  const outside = css.replace(mobile[0], '')
  for (const [re, what] of [
    [/button:has\(\[data-slot='sidebar\.panellist'\]\)\s*\{[^}]*display:\s*none/, 'the panel entries'],
    [/grid-template-columns[^}]*!important/, 'the track override'],
    [/\[data-sidebar-collapsed='true'\]\s*\[data-slot='sidebar'\]\s*>\s*\*\s*\{[^}]*visibility:\s*hidden/, 'the rail hiding'],
  ]) {
    assert.equal(re.test(outside), false, `${what} must survive above 900px`)
  }
})

test('a device can go dark while the Host preference stays light', () => {
  // The Host stores ONE `ui-theme.preference` for the whole installation and
  // writes the active palette INLINE on `body`, so `data-ds-dark-theme` alone
  // changes nothing: measured on the live host, adding that attribute left
  // `--dsw-alias-bg-base` at `#FFFFFF`. The device override therefore has to be
  // an `!important` block keyed on its own attribute.
  const css = compiledCss()
  const block = /body\[data-dsh-device-theme='dark'\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(block, 'the per-device dark block must exist and be anchored on its own attribute')

  // `!important` is load-bearing, not defensive: without it the Host's inline
  // declaration wins and the device stays light.
  const declarations = block[1].match(/--dsw-[a-z0-9-]+:[^;]+;/g) ?? []
  assert.ok(declarations.length > 50, 'the block must re-point the whole palette, not a sample')
  for (const declaration of declarations) {
    assert.match(declaration, /!important/, `${declaration} must beat the Host's inline value`)
  }

  // It must agree with the TOKENS layer's own `dark` column, or a device in dark
  // would differ from a Host in dark.
  const tokens = /var TOKENS = (\{[\s\S]*?\n    \})/.exec(clientSource)
  assert.ok(tokens, 'the TOKENS layer must stay in the client half')
  const layer = (0, eval)(`(${tokens[1]})`)
  for (const [name, value] of Object.entries(layer)) {
    if (value.light === value.dark) continue
    assert.ok(
      block[1].includes(`${name}: ${value.dark} !important`),
      `${name} must carry the same dark value the TOKENS layer declares`,
    )
  }

  // The structural rules key on the Host's attribute, so the device switch has
  // to drive that one too — dark tokens over light geometry reads as broken.
  assert.match(clientSource, /HOST_DARK_ATTR\s*=\s*'data-ds-dark-theme'/)
  assert.match(clientSource, /toggleAttribute\(HOST_DARK_ATTR/)
})

test('the session list drops the projections a list row never reads', () => {
  // Measured on the live host: `session/list` is 3.1 MB for 1875 Sessions, of
  // which `turnOutline` is 1.0 MB, `imageLimits` 233 KB and `modelSelection`
  // 197 KB. Trimming the recognised keys took the same response to 883 KB with
  // the sidebar, the composer chips and the context meter all unchanged.
  const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const keep = /const SESSION_LIST_KEEP = \[([^\]]*)\]/.exec(source)
  assert.ok(keep, 'the kept-key list must stay declared as data, not inlined in the script')

  // The keys a list row or the rail reads. `title` is the row label; the rest
  // are the badges. Anything absent here is dropped from the list response and
  // arrives again from the open Session's own projection stream.
  for (const key of ['title', 'sessionListMetadata', 'workingDirectory']) {
    assert.match(keep[1], new RegExp(`'${key}'`), `${key} must survive the trim`)
  }
  for (const dropped of ['turnOutline', 'imageLimits', 'modelSelection', 'tokenUsage']) {
    assert.equal(
      keep[1].includes(`'${dropped}'`),
      false,
      `${dropped} is not read by a list row and must stay out of the kept set`,
    )
  }

  // It must be injected into `<head>`, ahead of every application script: the
  // RPC transport binds `globalThis.fetch` at module initialisation, so a patch
  // installed later from the browser half never sees the call (measured: 4 calls
  // seen, all an unrelated plugin's polling).
  assert.match(source, /kind: 'script', placement: 'head'/, 'the trim must render into head')
  assert.match(source, /webserver\/index-inject/, 'it rides the webserver injection hook')

  // And it must be inert on anything it does not recognise: a throw here would
  // cost the whole session list, which is worse than 2 MB.
  assert.match(source, /if \(!Array\.isArray\(items\)\) return response/)
  assert.match(source, /catch \{\s*\n\s*return response/, 'a failed parse must return the response untouched')
  assert.match(source, /if \(!response\.ok\) return response/)
})

test('history pages ask for a budget a turn-aligned page can actually respect', () => {
  // Measured against the live host on a 28 MB Session, same `beforeSeq`: the
  // default 500-message budget returns 3993 KB / 1675 records, while 120/50
  // returns 1415 KB / 766 records — 65% less for one "load older", with
  // `hasMore` still true so paging simply continues.
  //
  // The budget is a REQUEST parameter (`maxMessages` + `turnWindow`), so the
  // Host validates it rather than us: `paginate` rejects a window whose
  // `minMessages` exceeds `maxMessages` ("must be a positive safe integer no
  // greater than maxMessages"), which is why the two values move together.
  const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const declaration = /const HISTORY_PAGE_BUDGET = (\{[^\n]*\}) as const/.exec(source)
  assert.ok(declaration, 'the page budget must stay declared as data, not inlined in the script')
  const budget = (0, eval)(`(${declaration[1]})`)
  const max = budget.maxMessages
  const min = budget.turnWindow.minMessages
  assert.ok(Number.isSafeInteger(max) && max > 0, 'maxMessages must be a positive integer')
  assert.ok(Number.isSafeInteger(min) && min > 0, 'minMessages must be a positive integer')
  assert.ok(min <= max, 'the Host rejects a window whose minMessages exceeds maxMessages')
  assert.ok(max < 500, 'the default budget is what this replaces; it must be smaller')

  // Two Turn starts are what keeps a page aligned to whole turns rather than
  // cutting mid-turn, so the rewrite must not drop that half of the window.
  assert.equal(budget.turnWindow.minTurns, 2, 'pages must still stop on a Turn boundary')

  // Rewriting a POST body means re-sending it; a request that is not the one
  // shape we recognise must go through byte-identical, or paging breaks.
  assert.match(source, /'\/api\/session\/page'/, 'it targets the history page endpoint')
  const rewrite = /function historyPageBudgetScript\(\)[\s\S]*?\n\}/.exec(source)
  assert.ok(rewrite, 'the rewrite must stay a separate head script')
  const forward = rewrite[0].match(/return native\.apply\(this, arguments\)/g) ?? []
  assert.ok(forward.length >= 3, 'every unrecognised shape must be forwarded untouched')
  assert.match(rewrite[0], /catch \{\s*\n\s*return native\.apply\(this, arguments\)/, 'an unreadable body must leave the request alone')
})
