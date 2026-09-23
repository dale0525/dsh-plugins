/**
 * Desktop observation: the two sensing channels of this plugin.
 *
 * The vision channel is the primary one. It asks the driver for a window
 * screenshot and hands back the bytes the model will actually look at, together
 * with the exact pixel frame they live in. The AX channel is the fallback, used
 * when the resolved route cannot accept images: it returns the driver's element
 * table and the lossless markdown tree.
 *
 * Both channels are one driver call each, and both must run against the driver's
 * own coordinate contract, which is narrower than it looks:
 *
 *  - The action tools take coordinates in the PIXEL SPACE OF THE PNG THE CALLER
 *    LAST SAW, and they resolve it against that capture. The driver validates the
 *    point against the window frame in that space and refuses a point outside it.
 *  - `screenshot_scale` is NOT a multiplier for those coordinates. It reports
 *    the window's backing scale, and the driver already reverses it. Measured on
 *    a 2x window: a click at the screenshot pixel of a button hit that button,
 *    while the same point scaled by 2 landed off the window entirely.
 *  - `max_dimension` downscales the PNG and the reported width/height with it,
 *    and the action tools follow: a point computed from the downscaled PNG's
 *    dimensions is the point that lands.
 *
 * So the frame a decision is made in is {@link Observation.frame}, and it is
 * echoed back on every action rather than recomputed.
 *
 * @module @logictan/dsh-desktop-agent/observe
 */

/** Cap on the AX markdown handed to a text model, in characters. */
const MAX_AX_CHARS = 24000;

/**
 * Marker the driver emits when its AX walk stopped before the tree ended.
 *
 * It is a warning, not a failure: the driver's own text says "Element indices
 * above are still valid. Use pixel clicks for elements not visible in this
 * partial tree." A truncated tree is therefore still actionable, and it is the
 * normal state on the large Electron applications this channel exists to serve —
 * refusing it would break the fallback exactly where it is needed.
 *
 * The payload cannot be used to detect it instead: `total_element_count` reports
 * the RETURNED count, not the app's true total, and `elements_complete` is
 * `false` even for a complete walk.
 */
const TRUNCATION_MARKER = '⚠️';

/**
 * Read the driver's structured payload out of one tool result.
 *
 * The Cua Driver tools are MCP-shaped: the canonical value carries `content`
 * (the model-facing blocks) and, when the tool declares one, `structuredContent`.
 * Every driver tool this plugin calls declares one, so a payload without it means
 * the call did not reach the driver at all and is reported as such rather than
 * silently read as an empty window.
 *
 * @param value - the canonical tool value.
 * @param tool - the tool name, for the failure message.
 * @returns the structured payload.
 * @throws {Error} when the result carries no structured payload.
 */
export function structured(value, tool) {
  const payload = value?.structuredContent;
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`desktop_agent: ${tool} returned no structured payload.`);
  }
  return payload;
}

/**
 * Pull the PNG out of one driver result's content blocks.
 *
 * @param value - the canonical tool value.
 * @returns the base64 data and media type.
 * @throws {Error} when the result carries no image block.
 */
function imageBlock(value) {
  const blocks = Array.isArray(value?.content) ? value.content : [];
  const found = blocks.find((block) => block?.type === 'image');
  if (found === undefined) throw new Error('desktop_agent: the driver returned no screenshot.');
  return { data: found.data, mediaType: found.mimeType };
}

/**
 * Capture one window for the vision channel.
 *
 * `include_accessibility_tree: false` selects the driver's capture-only path: the
 * AX walk is the expensive half of the call (up to 20 s on a large Electron tree)
 * and a vision decision reads none of it.
 *
 * @param input - the dispatch seam, the target, and the screenshot size cap.
 * @returns the observation, with the PNG bytes and the frame they occupy.
 */
export async function captureVision(input) {
  const { dispatch, target, maxImageDimension, signal } = input;
  const value = await dispatch(
    'cua_driver_native__get_window_state',
    {
      pid: target.pid,
      window_id: target.windowId,
      include_accessibility_tree: false,
      max_dimension: maxImageDimension,
    },
    signal,
  );
  const payload = structured(value, 'get_window_state');
  const image = imageBlock(value);

  return {
    channel: 'vision',
    app: payload.app_name ?? '',
    title: payload.window_title ?? '',
    image,
    // The frame the model reasons in: the PNG's own pixel space.
    frame: { width: payload.screenshot_width, height: payload.screenshot_height },
  };
}

/**
 * Capture one window for the AX channel.
 *
 * The element table alone is not enough to act on: `elements[]` only lists nodes
 * that expose an AX action, so a read-only display value — a game's score, a
 * calculator's readout — appears ONLY in `tree_markdown`. The markdown is
 * therefore carried alongside the table.
 *
 * A truncated walk is kept and flagged rather than refused; see
 * {@link TRUNCATION_MARKER}.
 *
 * @param input - the dispatch seam, the target, and the character cap.
 * @returns the observation, with the element table and the markdown tree.
 */
export async function captureAx(input) {
  const { dispatch, target, signal, maxChars = MAX_AX_CHARS } = input;
  const value = await dispatch(
    'cua_driver_native__get_window_state',
    { pid: target.pid, window_id: target.windowId, include_screenshot: false },
    signal,
  );
  const payload = structured(value, 'get_window_state');
  const markdown = payload.tree_markdown ?? '';
  const clipped = markdown.length > maxChars;

  return {
    channel: 'ax',
    app: payload.app_name ?? '',
    title: payload.window_title ?? '',
    elements: (payload.elements ?? []).map((element) => ({
      index: element.element_index,
      token: element.element_token,
      role: element.role,
      label: element.label ?? '',
      value: element.value,
    })),
    markdown: markdown.slice(0, maxChars),
    // The walk stopped early, or this plugin clipped it. Either way the model is
    // looking at part of the tree and has to be told so.
    truncated: clipped || markdown.includes(TRUNCATION_MARKER),
  };
}
