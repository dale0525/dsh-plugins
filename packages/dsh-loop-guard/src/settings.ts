/**
 * Configuration surface of the guard, as a settings section.
 *
 * The row's own config (`cordis.patch.yml`) is the composition layer. This
 * module adds a settings namespace on top of it so the same knobs are editable
 * from the Plugins page instead of only by hand-editing the profile patch.
 *
 * Two properties drive the shape here:
 *
 * 1. **Every key is declared WITHOUT a default.** The resolved section layers
 *    schema defaults, then the composition `base`, then the user layer — a
 *    default here would make the resolved value always carry the key and so
 *    hide the composition's own value. Absent means "not stated at this layer",
 *    which is also what marks a field as user-overridden in the card.
 *
 * 2. **The key set mirrors {@link Config} exactly.** The composition layer is
 *    the fully-defaulted row config, so the merge in `resolveConfig` always has
 *    every key present; a key missing from this schema could never be edited,
 *    and one present here but not in `Config` would be silently dropped.
 */
import z from '@deepseek-ai/schemastery'

/**
 * Settings namespace the guard registers for the Web GUI.
 *
 * The Plugins page renders a configuration card for the namespace under the row
 * that registers it.
 */
export const SETTINGS_NAMESPACE = 'loop-guard'

/** The languages a string-valued choice may take, as schemastery unions. */
const ESCALATIONS = ['warn', 'steer', 'cancel'] as const

/**
 * Schema of the {@link SETTINGS_NAMESPACE} section.
 *
 * Bounds are the same ones {@link Config} enforces, so a value the card accepts
 * is always a value the engine accepts.
 */
export const SettingsSection = z.object({
  maxThinkingSteps: z.number().min(2),
  minReasoningChars: z.number().min(256),
  similarityThreshold: z.number().min(0).max(1),
  escalate: z.union(ESCALATIONS.map((value) => z.const(value))),
  maxFires: z.number().min(1),
  cancelCause: z.string(),
  maxRepeatedText: z.number().step(1).min(0),
  maxRepeatedCycleChars: z.number().step(1).min(0),
  minRepeatedCycleChars: z.number().step(1).min(2),
  maxRepeatedReasoningCycleChars: z.number().step(1).min(0),
  minRepeatedReasoningCycleChars: z.number().step(1).min(2),
  maxRepeatedReasoningLineChars: z.number().step(1).min(0),
  minRepeatedReasoningLineCoverage: z.number().min(0).max(1),
  breakCode: z.string(),
  breakCorrection: z.boolean(),
  resumeAfterBreak: z.boolean(),
})
