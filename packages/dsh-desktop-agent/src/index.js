/**
 * dsh-desktop-agent — host half.
 *
 * Registers one model-facing tool, `desktop_agent`, that runs a native-vision
 * decision loop against the host desktop, plus the loopback route the settings
 * card reads its model list from.
 *
 * The plugin owns no execution engine of its own. Every action is dispatched to
 * the `cua_driver_native__*` tools the profile already mounts, through the tool
 * registry's own `execute` pipeline — so a call this plugin makes is subject to
 * the same guards, timeouts, and cancellation as one the model made directly, and
 * the driver's own coordinate and delivery contracts are the only ones in play.
 *
 * Configuration arrives as `apply`'s second argument. As of the 0.1.7-alpha.1
 * settings redesign the plugin's own `Config` schema is the only config surface —
 * `dsh-settings` derives the Plugins-page form from `entry.fiber.runtime.Config`,
 * keyed by the entry id — and every field of it is `volatile()`, so the Loader
 * hands `apply` one live `{ get() }` reference per field rather than a value.
 * The former `settings.register(ns, schema)` and `settings.get(ns)` seams were
 * removed in that generation.
 *
 * `Config` is therefore re-exported from the package entry: that is the exact
 * object `dsh-settings` looks for, and a schema exported only from `./config.js`
 * would leave the entry with no form at all.
 *
 * `llm`, `attachments`, and `tools` are resolved through `ctx.get` rather than
 * declared in `inject`. Cordis requires a declared `inject` before a service
 * property may be read, and waiting on a service a profile does not provide is
 * exactly what leaves an entry `pending` — which the Web UI's boot audit turns
 * into a hard failure for the whole page, not just this plugin. Each service is
 * checked at the point of use instead, and its absence is reported as an
 * actionable error from the tool body.
 *
 * `webServer` is the one exception, and it is mounted through a nested
 * `ctx.inject` rather than a `ctx.get` guard: it is an optional surface that can
 * arrive after this plugin activates, and a one-shot `ctx.get` would read it as
 * absent and never retry. See the route block in {@link apply}.
 *
 * @module @logictan/dsh-desktop-agent
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';

import { ENTRY_ID, resolveVisionRoute } from './config.js';
import { run } from './loop.js';
import { structured } from './observe.js';
import { makeRoutes } from './routes.js';

export { Config } from './config.js';

/**
 * Plugin row id; must equal the row id in `cordis.patch.yml`.
 *
 * Taken from {@link ENTRY_ID} rather than written out again: the row id, the
 * host half's `name`, and the id the browser half hands to `configForms.get`
 * are one string, and a second literal is a second thing to forget.
 */
export const name = ENTRY_ID;

/** Services resolved at the point of use; see the module note above. */
export const inject = [];

/**
 * Register the `desktop_agent` tool and the vision-catalog route.
 *
 * @param ctx - the plugin context.
 * @param config - one live reference per {@link Config} field.
 */
export function apply(ctx, config) {
  const tools = ctx.get('tools');
  if (tools === null || tools === undefined || typeof tools !== 'object') {
    ctx.logger?.warn?.('desktop_agent: the tools service is unavailable; the tool was not registered.');
    return;
  }

  const llm = ctx.get('llm');
  if (llm === null || llm === undefined) {
    ctx.logger?.warn?.('desktop_agent: the llm service is unavailable; the tool was not registered.');
    return;
  }

  /**
   * The configuration in effect right now, as plain values.
   *
   * Resolved at each use rather than captured at activation: the Loader commits a
   * Plugins-page edit into these very references instead of remounting the
   * plugin, so a snapshot taken here would pin the values the profile started
   * with and the card's save button would appear to do nothing.
   *
   * @returns the resolved configuration.
   */
  function currentConfig() {
    return {
      visionProvider: config.visionProvider.get(),
      visionModel: config.visionModel.get(),
      visionReasoningEffort: config.visionReasoningEffort.get(),
      maxSteps: config.maxSteps.get(),
      maxImageDimension: config.maxImageDimension.get(),
      deliveryMode: config.deliveryMode.get(),
    };
  }

  /**
   * Dispatch one driver tool through the registry's own pipeline.
   *
   * Going through `tools.execute` rather than calling the driver directly is what
   * makes these calls first-class: they traverse pre-execute policy and guards,
   * honour the caller's cancellation, and — because the execution carries this
   * call's own `token` as `parent` — are treated as nested sub-dispatches. That
   * last part matters under a `ptc` deployment, where a model-direct call may
   * only name `run_code`; without the parent token every action here would be
   * denied as `UNKNOWN_TOOL`.
   *
   * The sub-call id follows the registry's own `<parent>:ptc:<n>` convention. The
   * counter is passed in rather than held here: it belongs to one run, and a
   * counter shared across runs would number two concurrent `desktop_agent` calls
   * into each other's identities.
   *
   * @param toolName - the driver tool to call.
   * @param args - its arguments.
   * @param signal - the caller's cancellation.
   * @param exec - the `desktop_agent` execution this call belongs to.
   * @param subCalls - this run's running sub-dispatch count.
   * @returns the canonical tool value.
   * @throws {Error} with the driver's own message when the call failed.
   */
  async function dispatch(toolName, args, signal, exec, subCalls) {
    const callId = String(exec.callId) + ':ptc:' + subCalls;
    const outcome = await tools.execute({
      callId: ToolCallId(callId),
      rootCallId: exec.rootCallId,
      name: toolName,
      arguments: args,
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      parent: exec.token,
      signal,
    });
    if (outcome.isError) throw new Error(outcome.error.message);
    return outcome.value;
  }

  const definition = defineTool({
    name: 'desktop_agent',
    description:
      'Drive one desktop window to accomplish a goal, using screenshots as the primary sense. ' +
      'Resolves the target application, then runs an observation/decision loop: each step captures the window, ' +
      'asks the configured model what to do, and performs the click, key, or text entry it chose. ' +
      'Works on ordinary applications and on games that expose no usable accessibility tree, because it reads the ' +
      'picture rather than the element table. Requires the computer-use Cua Driver tools to be mounted. ' +
      'Note that a covered window cannot be driven, and a game that filters injected input needs foreground ' +
      'delivery — the plugin settings control that. This tool waits for the run to finish and returns a structured ' +
      'trace of every step.',
    parameters: {
      app: { type: 'string', description: 'Application to drive: an app name or a window title. Omit to use the frontmost window.' },
      goal: { type: 'string', description: 'What must be true when the task is finished.', required: true },
      windowId: { type: 'integer', description: 'Exact window id from a prior listing. Omit to resolve the window from the app argument.' },
    },
    output: {
      schema: { type: 'json', description: 'Structured trace: status, channel, window, steps, and the decision count.' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const current = currentConfig();
      const attachments = ctx.get('attachments');
      if (attachments === null || attachments === undefined) {
        throw new Error('desktop_agent: no attachment store is mounted, so screenshots cannot be sent to the model.');
      }

      // One counter per run, so every sub-dispatch in this run has a distinct id
      // even though the same driver tool is called repeatedly.
      let subCalls = 0;
      const call = (toolName, toolArgs, signal) => {
        subCalls += 1;
        return dispatch(toolName, toolArgs, signal, exec, subCalls);
      };

      const target = await resolveTarget({ dispatch: call, args, signal: exec.signal });
      return await run({
        dispatch: call,
        target,
        goal: args.goal,
        llm,
        attachments,
        config: { ...current, route: resolveVisionRoute(current, exec) },
        signal: exec.signal,
      });
    },
  });

  ctx.effect(() => tools.register(definition), 'desktop-agent: desktop_agent tool');

  // The route mounts through a nested `inject`, NOT a `ctx.get` guard.
  //
  // `webServer` is provided by its own loader entry and is not necessarily up
  // when this plugin activates. A `ctx.get('webServer')` read at that moment
  // returns `undefined` and is never retried, so the settings card would
  // silently lose its model list for the whole session -- measured, not
  // theoretical: with the guard in place the route answered 401 from the
  // generic `/api` prefix handler while a sibling plugin's own route answered
  // 405 from its registered handler.
  //
  // A nested inject defers the callback until the service exists and re-runs it
  // if the service is replaced. Its fiber is a child of this plugin rather than
  // a loader entry, so a profile with no web server (a TUI, say) leaves nothing
  // pending in the boot audit -- which is why this is also the right shape for
  // an optional surface.
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => {
        const disposers = makeRoutes({ llm }).map((route) => scoped.webServer.register(route));
        return () => {
          for (const dispose of disposers) dispose();
        };
      },
      'desktop-agent: vision-model catalog route',
    );
  });
}

/**
 * Resolve the one window a run will drive.
 *
 * Resolution is by explicit window id first, then by matching the app argument
 * against the live window list. Only on-screen windows are eligible: the driver's
 * own guidance is that a covered window cannot be captured or acted on, and
 * failing here names the window instead of producing a screenshot of whatever
 * happened to be in front.
 *
 * @param input - the dispatch seam, the tool arguments, and the signal.
 * @returns the resolved target.
 * @throws {Error} when no window matched.
 */
async function resolveTarget(input) {
  const { dispatch, args, signal } = input;

  const value = await dispatch('cua_driver_native__list_windows', {}, signal);
  const payload = structured(value, 'list_windows');
  const windows = Array.isArray(payload.windows) ? payload.windows : [];
  if (windows.length === 0) throw new Error('desktop_agent: the driver listed no windows.');

  if (args.windowId !== undefined) {
    const exact = windows.find((window) => window.window_id === args.windowId);
    if (exact === undefined) throw new Error('desktop_agent: no window has id ' + args.windowId + '.');
    if (exact.is_on_screen !== true) {
      throw new Error(
        'desktop_agent: window ' + args.windowId + ' (' + (exact.app_name ?? 'unknown') +
          ') is not on screen, so it cannot be captured or acted on.',
      );
    }
    return targetOf(exact);
  }

  const onScreen = windows.filter((window) => window.is_on_screen === true);
  if (args.app === undefined || args.app === '') {
    // No app argument means "the frontmost window" literally, so this path ranks
    // by z_index alone. The title rule below is deliberately NOT applied here:
    // its candidates span every app, so passing over a title-less frontmost
    // window could hand back a different application's window.
    const frontmost = topmost(onScreen);
    if (frontmost === undefined) throw new Error('desktop_agent: no window is currently on screen to drive.');
    return targetOf(frontmost);
  }

  const needle = args.app.toLowerCase();
  const matches = onScreen.filter(
    (window) =>
      String(window.app_name ?? '').toLowerCase().includes(needle) ||
      String(window.title ?? '').toLowerCase().includes(needle),
  );
  if (matches.length === 0) {
    const names = [...new Set(onScreen.map((window) => window.app_name).filter(Boolean))];
    throw new Error(
      'desktop_agent: no on-screen window matches "' + args.app + '". Open windows: ' + (names.join(', ') || '(none)') + '.',
    );
  }
  return targetOf(bestMatch(matches));
}

/**
 * Choose the window to drive from the candidates an app argument matched.
 *
 * Ranking is by z_index, EXCEPT that a title-less window loses to a titled one.
 * A popover or tooltip is a separate on-screen window owned by the same app and
 * stacked above the window it belongs to, so z_index alone picks the overlay —
 * measured on the Calculator, where the 模式 popover (328x101, title "") beat the
 * real window (230x408, title "计算器") and the run then captured a menu it could
 * not act on. The driver's own AX root for a real window is `AXWindow "<title>"`;
 * the overlay has no title at all.
 *
 * The needle matches app_name OR title, so these candidates are not guaranteed
 * to share one app. Preferring a titled window is still right — a title-less
 * window is an overlay whoever owns it — and a title-less window is only ever
 * passed over for a titled sibling. When all candidates are title-less — a
 * fullscreen game, say — the z_index order is unchanged, so this narrows the
 * choice rather than replacing it.
 *
 * @param candidates - the on-screen windows an app argument matched; never empty,
 *   so the choice is always defined.
 * @returns the chosen window.
 */
function bestMatch(candidates) {
  const titled = candidates.filter((window) => String(window.title ?? '') !== '');
  return topmost(titled.length > 0 ? titled : candidates);
}

/**
 * The frontmost of a set of windows.
 *
 * @param windows - the windows to rank.
 * @returns the highest z_index window, or undefined when there is none.
 */
function topmost(windows) {
  return [...windows].sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))[0];
}

/** Narrow one listed window to the target shape the loop uses. */
function targetOf(window) {
  return {
    pid: window.pid,
    windowId: window.window_id,
    app: window.app_name ?? '',
    title: window.title ?? '',
  };
}
