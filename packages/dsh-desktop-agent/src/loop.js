/**
 * The decision loop: observe, decide, act, confirm.
 *
 * Every iteration re-observes rather than reusing the previous capture. That is
 * not just freshness: the driver's action tools resolve a coordinate against the
 * last capture the caller saw, and a new snapshot of a window invalidates the
 * element tokens of the old one. Reusing a stale observation would therefore mean
 * acting in a frame that no longer exists.
 *
 * The loop's contract, in order of what it must never do:
 *
 *  - It must not claim success the model did not observe. `done` is the model's
 *    own claim about the screenshot it was shown, and the trace reports it as
 *    such; this plugin has no independent way to verify a goal.
 *  - It must not silently end on a mismatch. A decision that failed to execute,
 *    or an action whose result does not match what was asked, is recorded and
 *    re-decided — that is the whole reason the vision channel works at all, since
 *    a vision model's coordinates are known to drift.
 *  - It must not run without bound. Both caps still return a trace: a run that
 *    hits one has not failed, it has run out of budget, and the caller needs the
 *    trace to see where it got to.
 *
 * @module @logictan/dsh-desktop-agent/loop
 */
import { ask } from './ask.js';
import { plan } from './actions.js';
import { captureAx, captureVision } from './observe.js';
import { parseDecision } from './request.js';
import { supportsImages } from './route.js';

/** Driver actions allowed per run. */
export const DEFAULT_MAX_STEPS = 40;

/** How long a `wait` decision actually sleeps, capped. */
const MAX_WAIT_MS = 10000;

/** Consecutive failed actions tolerated before the run is declared stuck. */
const REPEAT_LIMIT = 3;

/**
 * Run one task to completion.
 *
 * @param input - the dispatch seam, the target window, the goal, the settings,
 *   the `ctx.llm` service, the attachment store, and an abort signal.
 * @returns a structured trace: the channel used, the steps taken, how the run
 *   ended, and the decision count.
 */
export async function run(input) {
  const { dispatch, target, goal, config, llm, attachments, signal } = input;

  const route = config.route;
  const channel = (await supportsImages(llm, route)) ? 'vision' : 'ax';
  const history = [];
  const steps = [];
  let decisions = 0;
  let status = 'max-steps';
  let repeats = 0;

  for (let step = 1; step <= config.maxSteps; step += 1) {
    if (signal?.aborted) {
      status = 'cancelled';
      break;
    }

    let observation;
    try {
      observation = channel === 'vision'
        ? await prepareVision({ dispatch, target, attachments, config, signal })
        : await captureAx({ dispatch, target, signal });
    } catch (cause) {
      status = 'blocked';
      steps.push({ step, operation: 'observe', result: `failed: ${messageOf(cause)}` });
      break;
    }

    decisions += 1;

    let decision;
    try {
      decision = parseDecision(await ask({ llm, route, goal, observation, history, signal }));
    } catch (cause) {
      // A malformed decision is a normal turn, not a fault: record it and let the
      // next turn answer against a fresh capture.
      steps.push({ step, operation: 'decide', result: `failed: ${messageOf(cause)}` });
      history.push({ step, action: 'decide', result: 'invalid decision' });
      continue;
    }

    let planned;
    try {
      planned = plan(decision, {
        target,
        frame: observation.channel === 'vision' ? observation.frame : null,
        deliveryMode: config.deliveryMode,
      });
    } catch (cause) {
      steps.push({ step, operation: decision.kind, result: `rejected: ${messageOf(cause)}` });
      history.push({ step, action: decision.kind, result: `rejected: ${messageOf(cause)}` });
      continue;
    }

    if (planned.terminal !== undefined) {
      status = planned.terminal;
      steps.push({ step, operation: decision.kind, result: decision.summary ?? decision.reason ?? decision.kind });
      break;
    }

    if (planned.wait !== undefined) {
      await sleep(Math.min(planned.wait, MAX_WAIT_MS), signal);
      steps.push({ step, operation: 'wait', result: `waited ${Math.min(planned.wait, MAX_WAIT_MS)}ms` });
      history.push({ step, action: 'wait', result: 'ok' });
      continue;
    }

    const result = await execute({ dispatch, planned, signal });
    steps.push({ step, operation: decision.kind, target: describeTarget(decision), result });
    history.push({ step, action: describeAction(decision), result });

    repeats = result.startsWith('ok') ? 0 : repeats + 1;
    if (repeats >= REPEAT_LIMIT) {
      status = 'stuck';
      break;
    }
  }

  return { status, goal, channel, window: target, steps, decisions };
}

/**
 * Capture a window for the vision channel and commit the image.
 *
 * The bytes are committed to the attachment store before the decision call, so
 * the message the model receives cites a durable reference rather than raw bytes.
 * The committed reference is dropped from the observation's serializable form —
 * it is not data the model needs, and the store's own identity is not stable
 * across runs.
 *
 * @param input - the dispatch seam, target, attachment store, and size cap.
 * @returns the observation, with its attachment reference attached.
 */
async function prepareVision(input) {
  const { dispatch, target, attachments, config, signal } = input;
  const observation = await captureVision({
    dispatch,
    target,
    maxImageDimension: config.maxImageDimension,
    signal,
  });
  const [attachment] = await attachments.saveImages([
    { data: Buffer.from(observation.image.data, 'base64'), mediaType: observation.image.mediaType, name: `${target.app || 'window'}.png` },
  ]);
  return { ...observation, attachment };
}

/**
 * Dispatch one planned action and normalize its outcome to a short result line.
 *
 * A driver refusal is an outcome, not a fault: `background_unavailable` in
 * particular is the documented signal that a surface filters per-pid-routed
 * events and needs the `foreground` rung. It is reported verbatim so the next
 * decision sees it and the operator can tell the two apart.
 *
 * @param input - the dispatch seam, the planned action, and the signal.
 * @returns a one-line result.
 */
async function execute(input) {
  const { dispatch, planned, signal } = input;
  try {
    const value = await dispatch(planned.tool, planned.args, signal);
    const payload = value?.structuredContent;
    const delivery = payload?.delivery;
    const effect = payload?.effect;
    const parts = ['ok'];
    if (delivery?.mode !== undefined) parts.push(`delivery=${delivery.mode}`);
    if (effect !== undefined) parts.push(`effect=${effect}`);
    return parts.join(' ');
  } catch (cause) {
    return `failed: ${messageOf(cause)}`;
  }
}

/** A short, model-facing description of what an action targets. */
function describeTarget(decision) {
  if (Number.isFinite(decision.x) && Number.isFinite(decision.y)) return `(${Math.round(decision.x)}, ${Math.round(decision.y)})`;
  if (typeof decision.token === 'string') return decision.token;
  if (typeof decision.key === 'string') return decision.key;
  if (Array.isArray(decision.keys)) return decision.keys.join('+');
  if (typeof decision.text === 'string') return decision.text.slice(0, 40);
  if (typeof decision.direction === 'string') return decision.direction;
  return '';
}

/** The history line for one action. */
function describeAction(decision) {
  const target = describeTarget(decision);
  return target === '' ? decision.kind : `${decision.kind} ${target}`;
}

/** One message from an unknown throwable. */
function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Sleep, waking early on cancellation.
 *
 * @param ms - the delay.
 * @param signal - the caller's cancellation.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
