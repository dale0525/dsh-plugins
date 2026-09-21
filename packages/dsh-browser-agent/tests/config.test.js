/**
 * Tests for the TYPE_TEXT route resolution seam.
 *
 * The route is what a fill step calls to decide its wording, and it has three
 * sources in priority order: the explicit settings pair, the session's own
 * routed request, then the agent's configured options. Only the first is
 * user-visible in the card; the other two are the "empty means use whatever
 * this session is already running on" default, and that default is the whole
 * reason no model is hard-coded into the settings schema.
 *
 * The second and third sources hang off the calling AGENT, and the only thing
 * the tool body has in hand is the tool execution context. A mismatch between
 * those two shapes does not throw: every optional chain short-circuits and the
 * resolution silently reports "unconfigured", which surfaces much later as a
 * TYPE_TEXT step that fails with "no provider/model is configured" on a
 * session that plainly has one. That is the failure this file pins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTextRoute } from '../src/config.js';

/** An unconfigured settings section: both explicit fields empty. */
const EMPTY = { textProvider: '', textModel: '', textReasoningEffort: '' };

/**
 * A tool execution context, shaped like the one the tool body receives: the
 * agent is a property, not the context itself.
 *
 * @param {object} agent - the calling agent, or undefined when there is none.
 * @returns {object} the execution context.
 */
function execFor(agent) {
  return { callId: 'call-1', name: 'browser_agent', arguments: {}, signal: undefined, agent };
}

/** An agent whose session is routed through provider/model. */
const ROUTED = {
  session: { requestHeader: () => ({ config: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash' } }) },
  options: {},
};

test('an explicitly configured pair wins over the session route', () => {
  const config = { textProvider: 'p', textModel: 'm', textReasoningEffort: 'high' };
  assert.deepEqual(resolveTextRoute(config, execFor(ROUTED)), {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  });
});

test('falls back to the session route read through the execution context', () => {
  assert.deepEqual(resolveTextRoute(EMPTY, execFor(ROUTED)), {
    provider: 'workbuddy-ai',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: '',
  });
});

test("falls back to the agent's own options when the session is unrouted", () => {
  const agent = { session: { requestHeader: () => undefined }, options: { provider: 'op', model: 'om' } };
  assert.deepEqual(resolveTextRoute(EMPTY, execFor(agent)), {
    provider: 'op',
    model: 'om',
    reasoningEffort: '',
  });
});

test('reports unconfigured when neither a pair, a route, nor options exist', () => {
  const agent = { session: { requestHeader: () => undefined }, options: {} };
  assert.deepEqual(resolveTextRoute(EMPTY, execFor(agent)), {
    provider: '',
    model: '',
    reasoningEffort: '',
  });
});

test('reports unconfigured when the call has no agent at all', () => {
  assert.deepEqual(resolveTextRoute(EMPTY, execFor(undefined)), {
    provider: '',
    model: '',
    reasoningEffort: '',
  });
});
