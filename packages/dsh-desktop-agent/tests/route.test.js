/**
 * Tests for channel routing.
 *
 * `inputModalities` is three-valued, and the third value is the one that matters:
 * ABSENT MEANS UNKNOWN. The host's own contract says so. This plugin treats
 * unknown as "cannot see", because the alternative is not a degraded run — the
 * host rewrites an image sent to a text-only route into placeholder text, after
 * which the model is describing a picture it never received and answers
 * confidently about it.
 *
 * The catalog builder is the other half. It must report a provider whose model
 * list failed as a failure rather than dropping it, so the settings card can say
 * the list is incomplete instead of implying those models do not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { supportsImages, visionCatalog } from '../src/route.js';

/** A stub llm whose resolved model info is keyed by model id. */
function llmWith(infoByModel, providers = [{ id: 'p', name: 'P' }]) {
  return {
    listProviders: () => providers,
    listModels: async (provider) => {
      const entry = infoByModel[provider];
      if (entry instanceof Error) throw entry;
      return entry.map((model) => ({ provider, id: model.id, name: model.name ?? model.id }));
    },
    resolveModelInfo: async (_provider, model) => {
      const declared = Object.values(infoByModel).flat().find((entry) => entry.id === model);
      return { inputModalities: declared?.inputModalities };
    },
  };
}

test('a route declaring image input supports images', async () => {
  const llm = llmWith({ p: [{ id: 'seer', inputModalities: ['text', 'image'] }] });
  assert.equal(await supportsImages(llm, { provider: 'p', model: 'seer' }), true);
});

test('a route declaring only text does not support images', async () => {
  const llm = llmWith({ p: [{ id: 'plain', inputModalities: ['text'] }] });
  assert.equal(await supportsImages(llm, { provider: 'p', model: 'plain' }), false);
});

test('an absent modality list means unknown and routes to the AX channel', async () => {
  const llm = llmWith({ p: [{ id: 'mystery' }] });
  assert.equal(await supportsImages(llm, { provider: 'p', model: 'mystery' }), false);
});

test('an unconfigured route is refused rather than silently defaulted', async () => {
  const llm = llmWith({});
  await assert.rejects(() => supportsImages(llm, { provider: '', model: '' }), /no model route is available/);
});

test('the catalog lists only vision-capable models', async () => {
  const llm = llmWith({
    p: [
      { id: 'seer', name: 'Seer', inputModalities: ['text', 'image'] },
      { id: 'plain', name: 'Plain', inputModalities: ['text'] },
      { id: 'mystery', name: 'Mystery' },
    ],
  });
  const catalog = await visionCatalog(llm);
  assert.deepEqual(catalog.groups, [{ id: 'p', name: 'P', models: [{ id: 'seer', name: 'Seer' }] }]);
  assert.deepEqual(catalog.failures, []);
});

test('a provider that fails to load is reported, not dropped', async () => {
  const llm = {
    listProviders: () => [{ id: 'ok', name: 'OK' }, { id: 'broken', name: 'Broken' }],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('unreachable');
      return [{ provider, id: 'seer', name: 'Seer' }];
    },
    resolveModelInfo: async () => ({ inputModalities: ['image'] }),
  };
  const catalog = await visionCatalog(llm);
  assert.deepEqual(catalog.groups.map((group) => group.id), ['ok']);
  assert.equal(catalog.failures.length, 1);
  assert.equal(catalog.failures[0].id, 'broken');
  assert.match(catalog.failures[0].message, /unreachable/);
});
