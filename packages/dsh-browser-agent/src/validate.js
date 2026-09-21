/**
 * TypeSafe response validation — the contract that gates every browser action.
 *
 * The decision protocol hands back a `choice` plus the full probability
 * distribution it was drawn from. A response whose `choice` disagrees with its
 * own argmax is a response the model did not actually make, and executing it
 * would drive a real browser action on a fabricated decision. So every
 * assertion here is a refusal to act, not a repair: nothing downstream runs
 * when this throws.
 *
 * This is deliberately the one place in the plugin that validates rather than
 * trusts. TypeSafe is an external hosted API, which the repository's
 * anti-defensive-programming gate lists as a genuine untrusted boundary, and
 * these five assertions correspond item for item to the upstream
 * `validate_choice` in `jev_ultrafast/model.py`.
 *
 * @module @logictan/dsh-browser-agent/validate
 */

/** Tolerance on `sum(probabilities)`, matching the upstream contract. */
const SUM_TOLERANCE = 0.02;

/** Tolerance on the `choice == argmax` comparison, matching upstream. */
const ARGMAX_TOLERANCE = 1e-6;

/** The one message every rejection carries. */
export const INVALID_RESPONSE = 'Invalid TypeSafe response; no action executed.';

/** Whether a value is a finite number inside `[0, 1]`. */
function isUnitInterval(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validate one Choice answer against the option ids that were offered.
 *
 * Every check must pass; a malformed answer is rejected rather than thrown
 * through as a raw `TypeError`, so the caller has one failure mode to report.
 *
 * @param answer - the raw answer object, however malformed.
 * @param ids - the option ids offered in the matching question's `criteria`.
 * @returns the same answer object when it is valid.
 * @throws {Error} {@link INVALID_RESPONSE} when any assertion fails.
 */
export function validateChoice(answer, ids) {
  try {
    if (typeof answer !== 'object' || answer === null) throw new Error('not an object');
    const { probabilities, confidence, choice } = answer;
    if (typeof probabilities !== 'object' || probabilities === null || Array.isArray(probabilities)) {
      throw new Error('probabilities is not a plain object');
    }

    const keys = Object.keys(probabilities);
    const offered = new Set(ids);
    const values = Object.values(probabilities);

    const valid =
      typeof choice === 'string' &&
      offered.has(choice) &&
      keys.length === offered.size &&
      keys.every((key) => offered.has(key)) &&
      values.every(isUnitInterval) &&
      isUnitInterval(confidence) &&
      Math.abs(values.reduce((total, value) => total + value, 0) - 1) < SUM_TOLERANCE &&
      probabilities[choice] >= Math.max(...values) - ARGMAX_TOLERANCE;

    if (!valid) throw new Error('assertion failed');
  } catch {
    throw new Error(INVALID_RESPONSE);
  }
  return answer;
}
