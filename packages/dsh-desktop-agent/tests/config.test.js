/**
 * Tests for the vision route resolution seam.
 *
 * The route has three sources in priority order: the explicit settings pair, the
 * session's own routed request, then the agent's configured options. Only the
 * first is user-visible in the card; the other two are the "empty means use
 * whatever this session is already running on" default, and that default is the
 * whole reason no model is hard-coded into the settings schema.
 *
 * The second and third sources hang off the calling AGENT, and the only thing the
 * tool body has in hand is the tool execution context. A mismatch between those
 * two shapes does not throw: every optional chain short-circuits and the
 * resolution silently reports "unconfigured", which surfaces much later as a run
 * that fails with "no model route is available" on a session that plainly has one.
 * That is the failure this file pins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveVisionRoute } from '../src/config.js';

/** An unconfigured settings section: both explicit fields empty. */
const EMPTY = { visionProvider: '', visionModel: '', visionReasoningEffort: '' };

/**
 * A tool execution context, shaped like the one the tool body receives: the
 * agent is a property, not the context itself.
 *
 * @param agent - the calling agent, or undefined when there is none.
 * @returns the execution context.
 */
function execFor(agent) {
  return { callId: 'call-1', name: 'desktop_agent', arguments: {}, signal: undefined, agent };
}

/** An agent whose session is routed through provider/model. */
const ROUTED = {
  session: { requestHeader: () => ({ config: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash' } }) },
  options: {},
};

test('an explicitly configured pair wins over the session route', () => {
  const config = { visionProvider: 'p', visionModel: 'm', visionReasoningEffort: 'high' };
  assert.deepEqual(resolveVisionRoute(config, execFor(ROUTED)), { provider: 'p', model: 'm', reasoningEffort: 'high' });
});

test('falls back to the session route read through the execution context', () => {
  assert.deepEqual(resolveVisionRoute(EMPTY, execFor(ROUTED)), {
    provider: 'workbuddy-ai',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: '',
  });
});

test("falls back to the agent's own options when the session is unrouted", () => {
  const agent = { session: { requestHeader: () => ({ config: {} }) }, options: { provider: 'p', model: 'm' } };
  assert.deepEqual(resolveVisionRoute(EMPTY, execFor(agent)), { provider: 'p', model: 'm', reasoningEffort: '' });
});

test('a half-configured pair is ignored rather than half-applied', () => {
  const config = { visionProvider: 'p', visionModel: '', visionReasoningEffort: '' };
  assert.deepEqual(resolveVisionRoute(config, execFor(ROUTED)), {
    provider: 'workbuddy-ai',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: '',
  });
});

test('no route at all resolves to an explicit empty, never a guess', () => {
  assert.deepEqual(resolveVisionRoute(EMPTY, execFor(undefined)), { provider: '', model: '', reasoningEffort: '' });
  assert.deepEqual(resolveVisionRoute(EMPTY, undefined), { provider: '', model: '', reasoningEffort: '' });
});
