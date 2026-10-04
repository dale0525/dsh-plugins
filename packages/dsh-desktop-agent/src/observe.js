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
 * Cap on the element anchors handed to a model, per capture.
 *
 * Measured on the heaviest tree available here (a browser window): a 300-element
 * cap returns ~200 nodes in 0.5-3.7 s, of which ~174 carry both a token and a
 * label -- ~18 KB of anchors. The same walk uncapped returned 1130 nodes and
 * 68 KB of anchors, which buys nothing: an element with no label cannot be named
 * in a decision, and the screenshot already shows it.
 */
const MAX_AX_ELEMENTS = 300;

/**
 * Reduce the driver's element table to the anchors a decision can actually use.
 *
 * An entry survives only when it carries BOTH an `element_token` and a non-empty
 * label. The token is what makes it addressable without a coordinate, and the
 * label is what lets a model recognise it; either one alone is not an anchor.
 * `frame` rides along so a model that would rather click the pixel can read the
 * element's own rectangle instead of estimating one from the picture.
 *
 * @param elements - the driver's `structuredContent.elements`, if any.
 * @returns the anchors, in the driver's own order.
 */
function anchors(elements) {
  return (elements ?? [])
    .filter((element) => typeof element.element_token === 'string' && element.element_token !== '')
    .filter((element) => typeof element.label === 'string' && element.label.trim() !== '')
    .map((element) => ({
      token: element.element_token,
      role: element.role,
      label: element.label,
      frame: element.frame,
    }));
}

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
 * One call returns the screenshot AND the element anchors, which is the point:
 * a screenshot alone forces the model to estimate a coordinate from the picture,
 * and that estimate is the plugin's known failure mode. The anchors give the same
 * model an addressable handle ("click token s00000001:2") that needs no estimate
 * at all, so the two senses correct each other inside one decision.
 *
 * The walk is not free -- measured 0.5-3.7 s and ~18 KB of anchors at the cap --
 * which is why it is bounded by {@link MAX_AX_ELEMENTS} rather than left open.
 *
 * @param input - the dispatch seam, the target, the screenshot size cap, and the
 *   anchor cap.
 * @returns the observation, with the PNG bytes, the frame they occupy, and the
 *   element anchors.
 */
export async function captureVision(input) {
  const { dispatch, target, maxImageDimension, signal, maxElements = MAX_AX_ELEMENTS } = input;
  const value = await dispatch(
    'cua_driver_native__get_window_state',
    {
      pid: target.pid,
      window_id: target.windowId,
      include_accessibility_tree: true,
      max_dimension: maxImageDimension,
      max_elements: maxElements,
    },
    signal,
  );
  const payload = structured(value, 'get_window_state');
  const image = imageBlock(value);
  const elements = anchors(payload.elements);

  return {
    channel: 'vision',
    app: payload.app_name ?? '',
    title: payload.window_title ?? '',
    image,
    // The frame the model reasons in: the PNG's own pixel space.
    frame: { width: payload.screenshot_width, height: payload.screenshot_height },
    elements,
    // The walk stopped at the cap, or found nothing actionable. Both are worth
    // saying out loud: the first means the control may be missing from the list,
    // the second is the signature of a window whose renderer is suspended.
    elementsTruncated: elements.length >= maxElements,
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
      frame: element.frame,
    })),
    markdown: markdown.slice(0, maxChars),
    // The walk stopped early, or this plugin clipped it. Either way the model is
    // looking at part of the tree and has to be told so.
    truncated: clipped || markdown.includes(TRUNCATION_MARKER),
  };
}
