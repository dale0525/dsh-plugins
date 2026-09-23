/**
 * Integration tests for the host entry.
 *
 * Every other test file exercises one module in isolation, which leaves the
 * wiring itself untested — and the wiring is where this plugin's two most
 * expensive failure modes live:
 *
 *  - A dispatch that does not carry the enclosing execution's `token` as its
 *    `parent` is a MODEL-DIRECT call to the registry. Under a `ptc` deployment
 *    only `run_code` may be named that way, so every driver action would be
 *    denied as UNKNOWN_TOOL and the tool would be useless on exactly the
 *    deployment this repo ships.
 *  - A tool registered while a required service is missing throws during
 *    activation, which the Web UI's boot audit turns into a hard failure for the
 *    whole page rather than just this plugin.
 *
 * These drive `apply` with a stand-in context, so they assert the real
 * registration path and the real `execute` body.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, name } from '../src/index.js';

/** A live configuration reference per field, as the Loader hands them over. */
function configRefs(overrides = {}) {
  const values = {
    visionProvider: '',
    visionModel: '',
    visionReasoningEffort: '',
    maxSteps: 4,
    maxImageDimension: 1568,
    deliveryMode: 'background',
    ...overrides,
  };
  const refs = {};
  for (const [key, value] of Object.entries(values)) refs[key] = { get: () => value };
  return refs;
}

/** A window capture result with an image, as the driver returns it. */
function capture() {
  return {
    content: [{ type: 'image', data: Buffer.from('fake').toString('base64'), mimeType: 'image/png' }, { type: 'text', text: '{}' }],
    structuredContent: {
      app_name: 'Calculator',
      window_title: 'Calculator',
      window_bounds: { x: 0, y: 0, width: 230, height: 408 },
      screenshot_width: 460,
      screenshot_height: 816,
      screenshot_scale: 2,
    },
  };
}

/**
 * A stand-in host context.
 *
 * @param options - the driver replies, by tool name, and which services exist.
 * @returns the context, the recorded dispatches, and the registered definitions.
 */
function host(options = {}) {
  const { replies = {}, services = ['tools', 'llm', 'attachments', 'webServer'] } = options;
  const dispatches = [];
  const registered = [];
  const routes = [];
  const effects = [];

  const tools = {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
    async execute(exec) {
      dispatches.push(exec);
      const reply = replies[exec.name];
      if (reply === undefined) return { isError: true, error: { message: 'UNKNOWN_TOOL' }, content: [] };
      if (reply instanceof Error) return { isError: true, error: { message: reply.message }, content: [] };
      return { isError: false, value: reply, content: [] };
    },
  };

  const llm = {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ provider: 'p', id: 'seer', name: 'Seer' }],
    stream: () => (async function* () {
      yield { type: 'text-delta', text: '{"kind":"done","summary":"ok"}' };
    })(),
  };

  const attachments = {
    saveImages: async (inputs) => inputs.map((_input, index) => ({ attachmentId: 'a' + index, mediaType: 'image/png', bytes: 1, width: 1, height: 1 })),
  };

  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };

  const available = { tools, llm, attachments, webServer };
  /** Nested-inject callbacks still waiting for their service. */
  const deferred = [];

  /** Run one nested-inject callback against a context scoped to its deps. */
  const runScoped = (deps, callback) => {
    const scoped = {
      get: (service) => (deps.includes(service) ? available[service] : undefined),
      effect(fn) {
        effects.push(fn());
        return () => {};
      },
    };
    for (const dep of deps) scoped[dep] = available[dep];
    callback(scoped);
  };

  const ctx = {
    get: (service) => (services.includes(service) ? available[service] : undefined),
    logger: { warn: () => {} },
    effect(fn) {
      effects.push(fn());
      return () => {};
    },
    // Cordis semantics: run now when every dep is already provided, otherwise
    // hold the callback until it is. Modelled deliberately -- the whole point of
    // the nested form is the deferred case, and a harness that always ran the
    // callback immediately could not tell the two apart.
    inject(deps, callback) {
      if (deps.every((dep) => services.includes(dep))) runScoped(deps, callback);
      else deferred.push({ deps, callback });
    },
  };

  /** Provide a service after activation and settle every waiting callback. */
  const provide = (service) => {
    if (!services.includes(service)) services.push(service);
    for (const waiting of deferred.splice(0)) {
      if (waiting.deps.every((dep) => services.includes(dep))) runScoped(waiting.deps, waiting.callback);
      else deferred.push(waiting);
    }
  };

  return { ctx, dispatches, registered, routes, effects, provide, deferred };
}

/** The window list the driver returns for target resolution. */
const WINDOWS = {
  structuredContent: {
    windows: [
      { pid: 42, window_id: 7, app_name: 'Calculator', title: 'Calculator', is_on_screen: true, z_index: 10 },
      { pid: 43, window_id: 8, app_name: 'Terminal', title: 'zsh', is_on_screen: false, z_index: 99 },
    ],
  },
  content: [{ type: 'text', text: '{}' }],
};

/**
 * The execution context a tool body receives.
 *
 * It carries an `agent` whose session is routed, because that is the shape a
 * real call has: the plugin resolves an unconfigured vision route from the
 * session's own model, and a harness without one would report "no model route"
 * on every case and prove nothing about the loop.
 */
function execFor(overrides = {}) {
  return {
    callId: 'call-1',
    rootCallId: 'root-1',
    name: 'desktop_agent',
    arguments: {},
    token: Symbol('token'),
    signal: new AbortController().signal,
    agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'seer' } }) }, options: {} },
    ...overrides,
  };
}

test('the entry exports the identity and an empty inject list', () => {
  assert.equal(name, 'desktop-agent');
  assert.deepEqual(inject, []);
});

test('activation registers the desktop_agent tool', () => {
  const { ctx, registered } = host();
  apply(ctx, configRefs());
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'desktop_agent');
  // defineTool compiles the author-facing spec, so the required marker is read
  // from the compiled schema rather than the object that was passed in.
  assert.deepEqual(registered[0].parameters.required, ['goal']);
  assert.ok(registered[0].parameters.properties.app);
  assert.ok(registered[0].parameters.properties.windowId);
});

test('activation registers the vision-catalog route', () => {
  const { ctx, routes } = host();
  apply(ctx, configRefs());
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/dsh-desktop-agent/vision-models');
  assert.equal(routes[0].kind, 'exact');
});

test('the route still registers when webServer arrives after activation', () => {
  // Measured against a real host: `webServer` is provided by its own loader
  // entry and is NOT up when this plugin activates. A `ctx.get('webServer')`
  // guard read `undefined` there and never retried, so the route answered 401
  // from the generic `/api` prefix handler for the whole session while the
  // settings card silently lost its model list.
  const { ctx, routes, deferred, provide } = host({ services: ['tools', 'llm', 'attachments'] });
  apply(ctx, configRefs());
  assert.equal(routes.length, 0, 'no web server yet, so nothing can be registered');
  assert.equal(deferred.length, 1, 'the route must be held, not dropped');

  provide('webServer');
  assert.equal(deferred.length, 0);
  assert.equal(routes.length, 1, 'the held callback must register once the service arrives');
  assert.equal(routes[0].path, '/api/dsh-desktop-agent/vision-models');
});

test('the tool registers even when webServer never arrives', () => {
  // A TUI profile has no web server; the tool is the whole point there, so it
  // must not be collateral damage of the optional surface.
  const { ctx, registered } = host({ services: ['tools', 'llm', 'attachments'] });
  apply(ctx, configRefs());
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'desktop_agent');
});

test('a host without the tools service is skipped, not thrown through', () => {
  // A throw here fails the Web UI's boot audit for the whole page, so a missing
  // optional service must only cost this plugin its tool.
  const { ctx, registered } = host({ services: ['llm', 'attachments', 'webServer'] });
  apply(ctx, configRefs());
  assert.equal(registered.length, 0);
});

test('a host without the llm service is skipped, not thrown through', () => {
  const { ctx, registered } = host({ services: ['tools', 'attachments', 'webServer'] });
  apply(ctx, configRefs());
  assert.equal(registered.length, 0);
});

test('every driver dispatch carries the parent token that makes it nested', async () => {
  const { ctx, registered, dispatches } = host({
    replies: { cua_driver_native__list_windows: WINDOWS, cua_driver_native__get_window_state: capture() },
  });
  apply(ctx, configRefs());
  const exec = execFor();

  const trace = await registered[0].execute({ app: 'Calculator', goal: 'compute' }, exec);

  assert.equal(trace.status, 'done');
  assert.ok(dispatches.length >= 2, 'expected a window listing and at least one capture');
  for (const dispatch of dispatches) {
    assert.equal(dispatch.parent, exec.token, 'a dispatch without the parent token is denied as UNKNOWN_TOOL under ptc');
    assert.equal(dispatch.rootCallId, 'root-1');
    // The caller's agent must ride along: it is the scope key the registry
    // filters listeners by, so dropping it would run the driver call outside
    // the session that asked for it.
    assert.equal(dispatch.agent, exec.agent);
  }
});

test('each sub-dispatch gets a distinct id, even for a repeated tool', async () => {
  const { ctx, registered, dispatches } = host({
    replies: { cua_driver_native__list_windows: WINDOWS, cua_driver_native__get_window_state: capture() },
  });
  apply(ctx, configRefs());
  await registered[0].execute({ app: 'Calculator', goal: 'compute' }, execFor());

  const ids = dispatches.map((dispatch) => String(dispatch.callId));
  assert.equal(new Set(ids).size, ids.length, 'duplicate sub-call ids collide in the durable log');
  assert.ok(ids.every((id) => id.startsWith('call-1:ptc:')));
});

test('a text-only route falls back to the accessibility channel', async () => {
  const ax = {
    content: [{ type: 'text', text: '{}' }],
    structuredContent: {
      app_name: 'Calculator',
      window_title: '',
      window_bounds: { x: 0, y: 0, width: 230, height: 408 },
      elements: [{ element_index: 1, element_token: 's1:1', role: 'AXButton', label: '5' }],
      tree_markdown: '- [0] AXWindow',
    },
  };
  const { ctx, registered, dispatches } = host({
    replies: { cua_driver_native__list_windows: WINDOWS, cua_driver_native__get_window_state: ax },
  });
  apply(ctx, configRefs());
  // The channel follows the ROUTE's declared modalities, not the payload shape:
  // a text-only session is what makes the AX channel reachable.
  ctx.get('llm').resolveModelInfo = async () => ({ inputModalities: ['text'] });

  const trace = await registered[0].execute({ app: 'Calculator', goal: 'compute' }, execFor());

  assert.equal(trace.channel, 'ax');
  const captureCall = dispatches.find((dispatch) => dispatch.name === 'cua_driver_native__get_window_state');
  assert.equal(captureCall.arguments.include_screenshot, false);
});

test('a driver failure surfaces as the driver message', async () => {
  const { ctx, registered } = host({
    replies: { cua_driver_native__list_windows: new Error('the computer-use provider is not mounted') },
  });
  apply(ctx, configRefs());
  await assert.rejects(
    () => registered[0].execute({ app: 'Calculator', goal: 'compute' }, execFor()),
    /the computer-use provider is not mounted/,
  );
});

test('an unmatched app names the windows that are open', async () => {
  const { ctx, registered } = host({ replies: { cua_driver_native__list_windows: WINDOWS } });
  apply(ctx, configRefs());
  await assert.rejects(
    () => registered[0].execute({ app: 'Nonexistent', goal: 'x' }, execFor()),
    /no on-screen window matches "Nonexistent".*Calculator/s,
  );
});

test('a title-less helper window does not shadow the window it floats over', async () => {
  // A popover or tooltip is its own on-screen window of the same app and sits
  // ABOVE the window it belongs to. Measured on the Calculator: the 模式 popover
  // (328x101, z 153, title "") ranked over the real window (230x408, z 152,
  // title "计算器"), so the run captured the overlay and could not act on the
  // app. A real window carries a title; the overlay does not.
  const withOverlay = {
    structuredContent: {
      windows: [
        { pid: 42, window_id: 7, app_name: 'Calculator', title: 'Calculator', is_on_screen: true, z_index: 10 },
        { pid: 42, window_id: 9, app_name: 'Calculator', title: '', is_on_screen: true, z_index: 11 },
      ],
    },
    content: [{ type: 'text', text: '{}' }],
  };
  const { ctx, registered, dispatches } = host({
    replies: { cua_driver_native__list_windows: withOverlay, cua_driver_native__get_window_state: capture() },
  });
  apply(ctx, configRefs());
  await registered[0].execute({ app: 'Calculator', goal: 'compute' }, execFor());

  const captureCall = dispatches.find((dispatch) => dispatch.name === 'cua_driver_native__get_window_state');
  assert.equal(captureCall.arguments.window_id, 7, 'the overlay is not the window to drive');
});

test('an app whose every window is title-less falls back to the frontmost one', async () => {
  // The title rule narrows the choice, it does not replace it: when nothing is
  // titled there is no overlay to avoid, so the z_index order must stand. Without
  // this fallback the candidate pool would be empty and the run would crash
  // instead of driving the only window the app has.
  const noTitles = {
    structuredContent: {
      windows: [
        { pid: 42, window_id: 7, app_name: 'Game', title: '', is_on_screen: true, z_index: 10 },
        { pid: 42, window_id: 9, app_name: 'Game', title: '', is_on_screen: true, z_index: 11 },
      ],
    },
    content: [{ type: 'text', text: '{}' }],
  };
  const { ctx, registered, dispatches } = host({
    replies: { cua_driver_native__list_windows: noTitles, cua_driver_native__get_window_state: capture() },
  });
  apply(ctx, configRefs());
  await registered[0].execute({ app: 'Game', goal: 'play' }, execFor());

  const captureCall = dispatches.find((dispatch) => dispatch.name === 'cua_driver_native__get_window_state');
  assert.equal(captureCall.arguments.window_id, 9, 'with no title to prefer, the frontmost window wins');
});

test('omitting the app argument takes the frontmost window even when it has no title', async () => {
  // "Omit to use the frontmost window" is literal. The title rule that fixes the
  // overlay case must not leak here: these candidates span every app, so passing
  // over a title-less frontmost window could return another app's window.
  const withOverlay = {
    structuredContent: {
      windows: [
        { pid: 42, window_id: 7, app_name: 'Calculator', title: 'Calculator', is_on_screen: true, z_index: 10 },
        { pid: 42, window_id: 9, app_name: 'Calculator', title: '', is_on_screen: true, z_index: 11 },
      ],
    },
    content: [{ type: 'text', text: '{}' }],
  };
  const { ctx, registered, dispatches } = host({
    replies: { cua_driver_native__list_windows: withOverlay, cua_driver_native__get_window_state: capture() },
  });
  apply(ctx, configRefs());
  await registered[0].execute({ goal: 'compute' }, execFor());

  const captureCall = dispatches.find((dispatch) => dispatch.name === 'cua_driver_native__get_window_state');
  assert.equal(captureCall.arguments.window_id, 9, 'the frontmost window is the frontmost window');
});

test('a covered window is not a resolution candidate', async () => {
  // Terminal is listed but off-screen; driving it would screenshot whatever is
  // actually in front.
  const { ctx, registered } = host({ replies: { cua_driver_native__list_windows: WINDOWS } });
  apply(ctx, configRefs());
  await assert.rejects(() => registered[0].execute({ app: 'Terminal', goal: 'x' }, execFor()), /no on-screen window matches/);
});

test('an explicit window id wins over the app argument', async () => {
  const { ctx, registered, dispatches } = host({
    replies: { cua_driver_native__list_windows: WINDOWS, cua_driver_native__get_window_state: capture() },
  });
  apply(ctx, configRefs());
  await registered[0].execute({ app: 'Calculator', goal: 'x', windowId: 7 }, execFor());
  const captureCall = dispatches.find((dispatch) => dispatch.name === 'cua_driver_native__get_window_state');
  assert.equal(captureCall.arguments.window_id, 7);
  assert.equal(captureCall.arguments.pid, 42);
});

test('an unknown window id is refused by number', async () => {
  const { ctx, registered } = host({ replies: { cua_driver_native__list_windows: WINDOWS } });
  apply(ctx, configRefs());
  await assert.rejects(() => registered[0].execute({ goal: 'x', windowId: 999 }, execFor()), /no window has id 999/);
});

test('an explicit off-screen window id is refused, not driven', async () => {
  // Regression: the app path filtered on is_on_screen but the windowId path did
  // not, so naming Terminal by id accepted a window the documented rule excludes
  // and the refusal only arrived from the driver, mid-run.
  const { ctx, registered } = host({ replies: { cua_driver_native__list_windows: WINDOWS } });
  apply(ctx, configRefs());
  await assert.rejects(
    () => registered[0].execute({ goal: 'x', windowId: 8 }, execFor()),
    /window 8 \(Terminal\) is not on screen/,
  );
});

test('a window list with no structured payload is a protocol failure, not an empty desktop', async () => {
  // Regression: a missing structuredContent was flattened to "[]" and reported
  // as "the driver listed no windows", which is the same sentence a genuinely
  // empty desktop produces -- so a broken driver looked like an idle machine.
  const { ctx, registered } = host({ replies: { cua_driver_native__list_windows: { content: [{ type: 'text', text: '{}' }] } } });
  apply(ctx, configRefs());
  await assert.rejects(
    () => registered[0].execute({ goal: 'x' }, execFor()),
    /list_windows returned no structured payload/,
  );
});

test('the settings values are read at use, not captured at activation', async () => {
  // The Loader commits a Plugins-page edit into these references without
  // remounting, so a snapshot taken in apply() would make the save button
  // appear to do nothing.
  const refs = configRefs({ maxSteps: 1 });
  const { ctx, registered } = host({
    replies: { cua_driver_native__list_windows: WINDOWS, cua_driver_native__get_window_state: capture() },
  });
  // A model that keeps clicking, so the cap is what ends each run.
  ctx.get('llm').stream = () => (async function* () {
    yield { type: 'text-delta', text: '{"kind":"click","x":10,"y":10}' };
  })();
  apply(ctx, refs);
  const first = await registered[0].execute({ app: 'Calculator', goal: 'x' }, execFor());
  assert.equal(first.status, 'max-steps');
  assert.equal(first.steps.length, 1);

  refs.maxSteps = { get: () => 2 };
  const second = await registered[0].execute({ app: 'Calculator', goal: 'x' }, execFor());
  assert.equal(second.steps.length, 2, 'a settings edit made after activation must take effect');
});
