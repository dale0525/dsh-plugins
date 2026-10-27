/**
 * Tests for the decision loop's two reporting seams.
 *
 * Both faults are silent. `page_changed` used to be the literal `true`, so the
 * model was told every action changed the page even when it had clicked a
 * disabled-looking control and nothing moved — the one signal that would tell
 * it it was going in circles. And a missing text model surfaced as
 * `failed: <message>` in one step of a 60-step trace, so a configuration error
 * looked like a flaky page and the run ground on to `max-steps`.
 *
 * The loop is driven through a fake page and a stubbed `fetch`, which is the
 * only way to pin what it reports without a browser or a network call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../src/loop.js';

/** One observation with a single clickable button. */
function observation(url, label) {
  return {
    url,
    title: 'Page',
    text: '',
    actions: [{ node: 1, kind: 'click', role: 'button', label, value: '' }],
    controls: ['WAIT'],
    omitted: 0,
  };
}

/** A Choice answer that selects one option out of `ids`. */
function answer(ids, selected) {
  // One option is both the argmax and the whole distribution.
  if (ids.length === 1) return { type: 'choice', choice: selected, confidence: 1, probabilities: { [selected]: 1 } };
  const rest = (1 - 0.9) / (ids.length - 1);
  return {
    type: 'choice',
    choice: selected,
    confidence: 0.9,
    probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 0.9 : rest])),
  };
}

/**
 * Run the loop against scripted observations and scripted decisions.
 *
 * @param input - the observations to serve in order, the operation answers to
 *   serve in order, and any config overrides.
 * @returns the trace, the request bodies sent, and the fake page.
 */
async function drive(input) {
  const observations = [...input.observations];
  const operations = [...input.operations];
  const bodies = [];
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async evaluate(fn, arg) {
      // The loop evaluates `snapshot`; the executor's page-side functions are
      // never reached by these scripted decisions.
      if (fn.name === 'snapshot') return observations.shift() ?? observations.at(-1);
      return undefined;
    },
    keyboard: { async press() {}, async insertText() {} },
    url: () => observations[0]?.url ?? 'https://shop.test/',
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const operation = operations.shift();
    const ids = Object.keys(body.questions.operation.criteria);
    const answers = { operation: answer(ids, operation) };
    const head = body.questions[`${operation.toLowerCase()}_target`];
    if (head !== undefined) answers[`${operation.toLowerCase()}_target`] = answer(Object.keys(head.criteria), Object.keys(head.criteria)[0]);
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };

  try {
    const trace = await run({
      url: 'https://shop.test/',
      goal: 'do the thing',
      page,
      llm: {},
      config: {
        apiKey: 'test-key',
        endpoint: 'https://typesafe.test/v1/systemone',
        model: 'jev-latest',
        maxSteps: 6,
        textRoute: input.textRoute ?? { provider: 'deepseek', model: 'chat', reasoningEffort: '' },
      },
      signal: undefined,
    });
    return { trace, bodies, page };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('reports a page that did not change between observations', async () => {
  const { bodies } = await drive({
    observations: [observation('https://shop.test/', 'Go'), observation('https://shop.test/', 'Go'), observation('https://shop.test/', 'Go')],
    operations: ['WAIT', 'WAIT', 'DONE'],
  });

  // The entry for the first WAIT is only known once the second observation
  // arrives, and it reports the page as unchanged.
  assert.equal(bodies[1].state.recent_actions[0].action, 'WAIT');
  assert.equal(bodies[1].state.recent_actions[0].page_changed, false);
  assert.equal(bodies[2].state.recent_actions[1].page_changed, false);
});

test('reports a page that changed between observations', async () => {
  const { bodies } = await drive({
    observations: [
      observation('https://shop.test/', 'Go'),
      observation('https://shop.test/results', 'Go'),
      observation('https://shop.test/results', 'Go'),
    ],
    operations: ['WAIT', 'WAIT', 'DONE'],
  });

  assert.equal(bodies[1].state.recent_actions[0].page_changed, true);
});

test('reports a change that only altered the controls on the same url', async () => {
  const { bodies } = await drive({
    observations: [
      observation('https://shop.test/', 'Go'),
      observation('https://shop.test/', 'Next'),
      observation('https://shop.test/', 'Next'),
    ],
    operations: ['WAIT', 'WAIT', 'DONE'],
  });

  assert.equal(bodies[1].state.recent_actions[0].page_changed, true);
});

test('surfaces a missing text model instead of recording a failed step', async () => {
  const fillable = {
    ...observation('https://shop.test/', 'Search'),
    actions: [{ node: 1, kind: 'fill', role: 'textbox', label: 'Search', value: '' }],
    controls: [],
  };

  await assert.rejects(
    drive({
      observations: [fillable],
      operations: ['TYPE_TEXT'],
      textRoute: { provider: '', model: '', reasoningEffort: '' },
    }),
    /no provider\/model is configured/,
  );
});
