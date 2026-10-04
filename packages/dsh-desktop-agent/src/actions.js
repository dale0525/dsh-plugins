/**
 * The action vocabulary and its projection onto the Cua Driver tools.
 *
 * One decision from the model becomes exactly one driver call. The vocabulary is
 * deliberately the driver's own, minus everything this plugin cannot verify or
 * does not need: no `drag`, no clipboard, no recording, no browser family. Each
 * entry here maps to a tool the driver actually exposes, so a decision the model
 * can express is a decision that can be executed.
 *
 * `zoom` is excluded too, and the reason is measured rather than assumed: it was
 * the obvious candidate for a self-drawn surface with no element tokens, but it
 * returns a 1:1 crop, not a magnified one — a 100x100 region came back 140x140,
 * which is exactly the documented 20% padding per side and no enlargement, with
 * the output capped at 500px wide. It therefore cannot make a small target easier
 * to read, and `from_zoom` is accepted by `click` alone, so supporting it would
 * mean a second coordinate space in the loop for every other pointer action.
 *
 * Coordinates travel as screenshot pixels in the frame the last observation
 * carried — see `geometry.js` for why that frame, and only that frame, is
 * authoritative.
 *
 * A pointer action may ALSO be addressed by the `element_token` of an element the
 * last capture listed. That is the preferred form when a token is available: a
 * token names an element the driver itself identified, while a coordinate is the
 * model's estimate of where that element is, and the estimate is the documented
 * failure mode of the vision channel. A token that has been superseded by a newer
 * capture is refused by the driver with `stale_element_token`, which is why the
 * loop re-observes every step.

 * @module @logictan/dsh-desktop-agent/actions
 */
import { isFrame, within } from './geometry.js';

/** Every action kind the decision protocol accepts. */
export const ACTION_KINDS = [
  'click',
  'double_click',
  'right_click',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'set_value',
  'launch_app',
  'bring_to_front',
  'wait',
  'done',
  'blocked',
];

/** Mouse actions, each addressed by a screenshot pixel or an element token. */
const POINTER_KINDS = ['click', 'double_click', 'right_click'];

/** Actions that end the run rather than reaching the driver. */
const TERMINAL_KINDS = ['done', 'blocked'];

/** Driver tool name per action kind. */
const TOOL_BY_KIND = {
  click: 'cua_driver_native__click',
  double_click: 'cua_driver_native__double_click',
  right_click: 'cua_driver_native__right_click',
  type_text: 'cua_driver_native__type_text',
  press_key: 'cua_driver_native__press_key',
  hotkey: 'cua_driver_native__hotkey',
  scroll: 'cua_driver_native__scroll',
  set_value: 'cua_driver_native__set_value',
  launch_app: 'cua_driver_native__launch_app',
  bring_to_front: 'cua_driver_native__bring_to_front',
};

/**
 * Validate one decision and build the driver call it maps to.
 *
 * Validation is deliberately strict about the fields an action cannot run
 * without. A model that names `click` and forgets the point has not made an
 * ambiguous decision, it has made an incomplete one, and reporting that back is
 * what lets the next decision correct it — silently defaulting to the window
 * centre would perform an action nobody asked for.
 *
 * @param decision - the parsed decision.
 * @param context - the observation frame and the target the action applies to.
 * @returns the driver tool name and its arguments, or a terminal outcome.
 * @throws {Error} when the decision is missing a field its action requires.
 */
export function plan(decision, context) {
  const { kind } = decision;
  if (!ACTION_KINDS.includes(kind)) {
    throw new Error(`desktop_agent: "${kind}" is not an action. Choose one of: ${ACTION_KINDS.join(', ')}.`);
  }
  if (TERMINAL_KINDS.includes(kind)) return { terminal: kind };
  if (kind === 'wait') {
    const ms = decision.ms ?? 1000;
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error('desktop_agent: wait needs a non-negative number of milliseconds.');
    }
    return { wait: ms };
  }

  if (kind === 'launch_app') {
    const args = {};
    if (typeof decision.bundleId === 'string' && decision.bundleId !== '') args.bundle_id = decision.bundleId;
    if (typeof decision.name === 'string' && decision.name !== '') args.name = decision.name;
    if (args.bundle_id === undefined && args.name === undefined) {
      throw new Error('desktop_agent: launch_app needs either bundleId or name.');
    }
    return { tool: TOOL_BY_KIND.launch_app, args };
  }

  if (kind === 'bring_to_front') {
    // The one action that takes no coordinates at all: it addresses the window
    // the run already resolved.
    if (context.allowBringToFront !== true) {
      throw new Error(
        'desktop_agent: bring_to_front is disabled. It steals the foreground from whatever the user is doing, ' +
          'so it has to be enabled explicitly in this plugin\'s settings. ' +
          'Reach the window with a click or a key instead.',
      );
    }
    return { tool: TOOL_BY_KIND.bring_to_front, args: { pid: context.target.pid, window_id: context.target.windowId } };
  }

  const args = { pid: context.target.pid, window_id: context.target.windowId };
  if (context.deliveryMode === 'foreground') args.delivery_mode = 'foreground';

  if (POINTER_KINDS.includes(kind)) {
    const modifiers = Array.isArray(decision.modifiers) ? decision.modifiers : [];

    // An element token supersedes the coordinate: it addresses the element the
    // driver identified, with no estimate from the model.
    if (typeof decision.token === 'string' && decision.token !== '') {
      args.element_token = decision.token;
    } else {
      const point = requirePoint(decision, context);
      args.x = point.x;
      args.y = point.y;
    }

    // A MODIFIED double click is expressed as a two-count click: click is the
    // only pointer tool whose schema carries both `count` and `modifier`
    // (double_click carries modifier but no count), so one call can say "twice,
    // with this modifier" without splitting the gesture across two tools.
    if (kind === 'double_click' && modifiers.length > 0) {
      args.count = 2;
      args.modifier = modifiers;
      return { tool: TOOL_BY_KIND.click, args };
    }

    if (kind === 'click' && Number.isInteger(decision.count) && decision.count > 1) args.count = decision.count;
    if (kind !== 'double_click' && modifiers.length > 0) args.modifier = modifiers;
    return { tool: TOOL_BY_KIND[kind], args };
  }

  if (kind === 'scroll') {
    if (typeof decision.direction !== 'string') throw new Error('desktop_agent: scroll needs a direction.');
    args.direction = decision.direction;
    if (Number.isInteger(decision.amount)) args.amount = decision.amount;
    if (typeof decision.by === 'string' && decision.by !== '') args.by = decision.by;
    // A wheel event lands on whatever is under the cursor, which is the only way
    // to reach a nested scroller that never takes keyboard focus. When the
    // decision names a point, route through the pixel-wheel path.
    if (decision.x !== undefined && decision.y !== undefined) {
      const point = requirePoint(decision, context);
      args.x = point.x;
      args.y = point.y;
    }
    return { tool: TOOL_BY_KIND.scroll, args };
  }

  if (kind === 'type_text') {
    if (typeof decision.text !== 'string' || decision.text === '') {
      throw new Error('desktop_agent: type_text needs the text to type.');
    }
    args.text = decision.text;
    // A token focuses that exact field before typing. Without one the text lands
    // in whatever already holds focus, which is not necessarily the field the
    // model clicked a moment ago.
    if (typeof decision.token === 'string' && decision.token !== '') args.element_token = decision.token;
    return { tool: TOOL_BY_KIND.type_text, args };
  }

  if (kind === 'press_key') {
    if (typeof decision.key !== 'string' || decision.key === '') {
      throw new Error('desktop_agent: press_key needs a key.');
    }
    args.key = decision.key;
    if (Array.isArray(decision.modifiers) && decision.modifiers.length > 0) args.modifiers = decision.modifiers;
    return { tool: TOOL_BY_KIND.press_key, args };
  }

  if (kind === 'hotkey') {
    if (!Array.isArray(decision.keys) || decision.keys.length < 2) {
      throw new Error('desktop_agent: hotkey needs at least one modifier and one key, e.g. ["cmd", "s"].');
    }
    args.keys = decision.keys;
    return { tool: TOOL_BY_KIND.hotkey, args };
  }

  // set_value: addressed by the element token from the latest AX observation.
  if (typeof decision.token !== 'string' || decision.token === '') {
    throw new Error('desktop_agent: set_value needs the element token of the target.');
  }
  if (typeof decision.value !== 'string') throw new Error('desktop_agent: set_value needs a value.');
  args.element_token = decision.token;
  args.value = decision.value;
  return { tool: TOOL_BY_KIND.set_value, args };
}

/**
 * Read and bound-check a decision's point against the observation frame.
 *
 * @param decision - the decision carrying `x` and `y`.
 * @param context - the observation frame the point is read in.
 * @returns the integral point.
 * @throws {Error} when the point is missing, non-numeric, or outside the frame.
 */
function requirePoint(decision, context) {
  const { x, y } = decision;
  if (!isFrame(context.frame)) {
    throw new Error(
      'desktop_agent: no screenshot frame is available for this action, so a coordinate cannot be placed. ' +
        'This run is on the accessibility channel; address the element by its token instead.',
    );
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('desktop_agent: this action needs numeric x and y in the screenshot coordinate space.');
  }
  const point = { x: Math.round(x), y: Math.round(y) };
  if (!within(point, context.frame)) {
    throw new Error(
      `desktop_agent: the point (${point.x}, ${point.y}) lies outside the ${context.frame.width}×${context.frame.height} screenshot; ` +
        're-read the coordinates from the screenshot you were shown.',
    );
  }
  return point;
}
