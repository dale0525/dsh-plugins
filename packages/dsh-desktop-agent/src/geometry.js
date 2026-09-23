/**
 * The coordinate contract between a screenshot and the driver's action tools.
 *
 * The driver's action tools accept the point in the PIXEL SPACE OF THE PNG THE
 * CALLER LAST SAW, and its own field documentation says so outright: "The driver
 * reverses Retina backing scale and any window-image downscale." Two facts pin
 * this down, and both were measured against a live window rather than inferred:
 *
 *  1. `screenshot_scale` is NOT a multiplier. On a window reporting
 *     `screenshot_scale: 2`, clicking the screenshot pixel of a button hit that
 *     button; the same point doubled landed outside the window and the driver
 *     refused it as `lies outside window ...'s frame`.
 *  2. `max_dimension` downscales the PNG and its reported dimensions together,
 *     and the action tools follow the downscale: a point computed from the
 *     returned `screenshot_width`/`screenshot_height` is the point that lands.
 *
 * There is therefore NO conversion to perform, and this module deliberately
 * offers none. The model is shown the frame the driver will read, so the
 * identity is the whole mapping; a scaling helper would be an invitation to
 * reintroduce the `screenshot_scale` multiplication the driver rejects.
 *
 * @module @logictan/dsh-desktop-agent/geometry
 */

/**
 * Whether one value is a usable coordinate frame.
 *
 * @param frame - the candidate.
 * @returns whether it carries two positive dimensions.
 */
export function isFrame(frame) {
  return (
    frame !== null &&
    typeof frame === 'object' &&
    Number.isFinite(frame.width) &&
    Number.isFinite(frame.height) &&
    frame.width > 0 &&
    frame.height > 0
  );
}

/**
 * Whether a point lies inside a frame.
 *
 * The driver refuses an out-of-frame point outright rather than clamping it, so a
 * decision that reads a coordinate off the screenshot but lands outside the
 * window is caught here, where the failure names the decision, instead of at the
 * driver, where it only names the number.
 *
 * @param point - the point in the frame's pixels.
 * @param frame - the frame it should lie in.
 * @returns whether the point is inside.
 */
export function within(point, frame) {
  return isFrame(frame) && point.x >= 0 && point.y >= 0 && point.x < frame.width && point.y < frame.height;
}
