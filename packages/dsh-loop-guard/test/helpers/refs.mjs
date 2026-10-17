/**
 * Test helper providing mock config references for legacy test callers.
 *
 * @param config - the plain config overrides.
 * @returns the references plus a writer for the live-edit cases.
 */
const DEFAULTS = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 99,
  cancelCause: 'thinking-loop',
  maxRepeatedText: 60,
  maxRepeatedCycleChars: 512,
  minRepeatedCycleChars: 256,
  maxRepeatedReasoningCycleChars: 512,
  minRepeatedReasoningCycleChars: 384,
  maxRepeatedReasoningLineChars: 2048,
  minRepeatedReasoningLineCoverage: 0.6,
  breakCode: 'REPETITIVE_OUTPUT',
  breakCorrection: true,
  resumeAfterBreak: true,
  retryRequestFailures: true,
  maxRequestRetries: 2,
}

export function refs(config = {}) {
  const cells = { ...DEFAULTS, ...config }
  const out = {}
  for (const key of Object.keys(cells)) {
    out[key] = { get: () => cells[key] }
  }
  return { refs: out, set: (key, value) => { cells[key] = value } }
}

/** The references alone, for the common case that never edits after mount. */
export function configRefs(config = {}) {
  return refs(config).refs
}
