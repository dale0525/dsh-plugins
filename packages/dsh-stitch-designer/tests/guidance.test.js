/**
 * Tests for the announced design conventions.
 *
 * The conventions are prose, so the only properties worth pinning are the ones
 * a refactor could silently break: that the three rules are actually in the
 * text, that the announcement is registered as a system-prompt section, and
 * that a missing `systemPrompt` service costs the announcement rather than the
 * whole plugin.
 *
 * That last one is the load-bearing case. Reading the service through
 * `ctx.get` (not `inject`) is what keeps "host has no system prompt" from
 * escalating into "no Stitch tools at all" — the failure mode this repository
 * has hit before, where a service in `inject` that never appears means
 * `apply` is never called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { SECTION_NAME, STITCH_GUIDANCE } = await import('../src/guidance.js');
const { apply } = await import('../src/index.js');

test('the announcement states all three conventions', () => {
  // Each assertion is one convention, checked by the words that carry it
  // rather than by the whole string — the text should stay editable.
  assert.match(STITCH_GUIDANCE, /一个代码项目只对应一个 Stitch 项目/);
  assert.match(STITCH_GUIDANCE, /TailwindCSS/);
  assert.match(STITCH_GUIDANCE, /像素级还原/);
  assert.match(STITCH_GUIDANCE, /先问用户/);
  // The export location is a promise the reader will act on, so it is named.
  assert.match(STITCH_GUIDANCE, /docs\/design/);
});

test('the announcement carries the design brief, not only the implementation rules', () => {
  // A Stitch screen is only useful if the brief let the model design rather
  // than transcribe. These are the constraints the user set for how a screen
  // is commissioned, and each one changes what gets generated.
  assert.match(STITCH_GUIDANCE, /视觉效果/, 'the brief states what to show, not how to build it');
  assert.match(STITCH_GUIDANCE, /自我发挥/, 'the model must be left room to design');
  assert.match(STITCH_GUIDANCE, /无法实现/, 'the screen must not contain what the implementation cannot express');
  assert.match(STITCH_GUIDANCE, /暗色/, 'every screen ships a dark variant');
});

test('the announcement names the design-language source and the reuse rule', () => {
  // Screens in this repository follow an existing design language and reuse
  // the host components; a screen that invents its own language cannot be
  // implemented without either a rewrite or a second visual system.
  assert.match(STITCH_GUIDANCE, /设计语言/, 'the brief names the language the screen must follow');
  assert.match(STITCH_GUIDANCE, /复用/, 'existing components are reused rather than redrawn');
});

test('apply registers the announcement as one system-prompt section', () => {
  const sections = [];
  const ctx = {
    get: (name) => (name === 'systemPrompt' ? { section: (section) => (sections.push(section), () => {}) } : undefined),
    inject: () => {},
    effect: (factory) => factory(),
    logger: { info() {}, warn() {} },
  };

  apply(ctx);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, SECTION_NAME);
  assert.equal(sections[0].text, STITCH_GUIDANCE);
});

test('a missing systemPrompt service does not take the plugin down with it', () => {
  const registered = [];
  const ctx = {
    get: () => undefined,
    effect: (factory) => factory(),
    // The tools half runs even though there is no system prompt: a plugin that
    // skipped registration here would lose its tools over a missing banner.
    // `effect`/`logger`/`on` sit on the INJECTED context, not on the service
    // `get` returns — the distinction the real cordis makes.
    inject: (names, run) => {
      registered.push(names);
      run({
        get: () => ({ register: () => () => {} }),
        effect: (factory) => factory(),
        logger: { info() {}, warn() {} },
        on: () => () => {},
      });
    },
    logger: { info() {}, warn() {} },
  };

  assert.doesNotThrow(() => apply(ctx));
  // Only the tools half: the plugin no longer serves any HTTP route, so a host
  // without `webServer` costs it nothing.
  assert.deepEqual(registered, [['tools', 'credentials']]);
});
