/**
 * The decision loop.
 *
 * Observe, ask, validate, execute — repeated until the model answers `DONE` or
 * `BLOCKED`, or a cap is reached. Every iteration re-observes rather than
 * reusing the previous table, because the page is the only source of truth
 * about what is currently clickable and an identity from a stale observation
 * may no longer resolve.
 *
 * Both caps are hard stops that still return a trace: a run that hits one has
 * not failed, it has run out of budget, and the caller needs the trace to see
 * where it got to. `DONE` is the model's own claim and is reported as such —
 * this plugin has no independent way to verify the goal was met.
 *
 * @module @logictan/dsh-browser-agent/loop
 */
import { actionSpace } from './actions.js';
import { buildRequest, resolveDecision } from './request.js';
import { ask } from './typesafe.js';
import { execute } from './execute.js';
import { SNAPSHOT_LIMITS, snapshot } from './observe.js';
import { fieldValue } from './value.js';

/** Browser actions allowed per run. */
export const DEFAULT_MAX_STEPS = 60;

/** Decision requests allowed per run; two per step is the observed ratio. */
export const MAX_DECISIONS = 120;

/** How many times an observation is retried while a navigation is in flight. */
const OBSERVE_ATTEMPTS = 5;

/** How long to wait between those retries, in milliseconds. */
const OBSERVE_RETRY_MS = 120;

/**
 * Whether a failed evaluation was the old document being torn down.
 *
 * A click that navigates destroys the document the evaluation was bound to, so
 * the call is rejected rather than returning a value. Playwright reports that
 * as a context-destroyed error; any other rejection is a real fault.
 *
 * @param cause - the rejection from `page.evaluate`.
 * @returns whether the failure was a destroyed execution context.
 */
function isContextDestroyed(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes('Execution context was destroyed') || message.includes('Cannot find context with specified id');
}

/**
 * Observe the page, tolerating a navigation that is still in flight.
 *
 * A click may navigate, and the loop re-observes immediately afterwards. That
 * observation can land while the old document is gone and the new one is not
 * ready — the expected consequence of the action just taken, not a failure. It
 * is retried against the document that replaces it; a run that treated it as
 * fatal would end the moment the agent clicked its first link.
 *
 * Exported because the retry policy is a seam worth testing on its own: a
 * non-navigating rejection must propagate unchanged.
 *
 * @param page - the attached page.
 * @returns the page-side snapshot, or `null` when the document has no body.
 * @throws {Error} any rejection that is not a destroyed execution context, and
 *   a context-destroyed rejection that outlives {@link OBSERVE_ATTEMPTS}.
 */
export async function observe(page) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.evaluate(snapshot, SNAPSHOT_LIMITS);
    } catch (cause) {
      if (attempt >= OBSERVE_ATTEMPTS || !isContextDestroyed(cause)) throw cause;
      await page.waitForTimeout(OBSERVE_RETRY_MS);
    }
  }
}

/**
 * Run one task to completion.
 *
 * @param input - the page, the goal, the settings, the `ctx.llm` service, and
 *   an abort signal.
 * @returns a structured trace: the steps taken, how the run ended, and the
 *   decision count.
 */
export async function run(input) {
  const { page, goal, config, llm, signal } = input;

  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);

  const history = [];
  const steps = [];
  let decisions = 0;
  let status = 'max-steps';

  for (let step = 1; step <= config.maxSteps; step += 1) {
    if (signal?.aborted) {
      status = 'cancelled';
      break;
    }

    const observation = await observe(page);
    if (observation === null) {
      status = 'blocked';
      history.push({ action: 'the page has no body', kind: 'BLOCKED', text: '', page_changed: false });
      break;
    }

    const table = actionSpace(observation.actions, { controls: observation.controls });
    const body = buildRequest({
      goal,
      page: observation,
      elements: table.elements,
      targets: table.targets,
      controls: table.controls,
      history,
      model: config.model,
    });

    if (decisions >= MAX_DECISIONS) {
      status = 'max-decisions';
      break;
    }
    decisions += 1;

    const response = await ask({ body, endpoint: config.endpoint, apiKey: config.apiKey, signal });
    const decision = resolveDecision({ answers: response.answers, targets: table.targets, controls: table.controls });

    if (decision.kind === 'done' || decision.kind === 'blocked') {
      status = decision.kind;
      steps.push({
        step,
        operation: decision.operation,
        target: decision.target,
        label: decision.descriptor?.label ?? null,
        confidence: decision.confidence,
        result: decision.kind,
      });
      history.push({ action: decision.operation, kind: decision.operation, text: '', page_changed: false });
      break;
    }

    let result;
    try {
      result = await execute({
        page,
        decision,
        valueProvider: (descriptor) =>
          fieldValue({
            llm,
            route: config.textRoute,
            goal,
            descriptor,
            page: observation,
            history,
            signal,
          }),
      });
    } catch (cause) {
      // A target that vanished between observation and execution is a normal
      // race, not a fault: record it and let the next observation re-decide.
      result = `failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }

    steps.push({
      step,
      operation: decision.operation,
      target: decision.target,
      label: decision.descriptor?.label ?? null,
      confidence: decision.confidence,
      result,
    });
    history.push({
      action: `${decision.operation} ${decision.descriptor?.label ?? ''}`.trim(),
      kind: decision.operation,
      text: decision.kind === 'fill' ? result : '',
      page_changed: true,
    });
  }

  return {
    status,
    goal,
    url: page.url(),
    steps,
    decisions,
  };
}
