/**
 * Wiring tests for the fake-ip fetch provider plugin half.
 *
 * No network: the provider is constructed and inspected, `apply` is driven with
 * a hand-written fake `ctx`, and nothing here calls `fetch()`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Config as UpstreamConfig, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http';

import { Config, FakeIpFetchProvider, apply, inject, name } from '../src/index.js';

/** Upstream's resolved transport limits, used as the provider's first argument. */
const LIMITS = UpstreamConfig({});

/** The plugin row id, which the loader entry in `cordis.patch.yml` must match. */
const ROW_ID = 'fakeip-fetch';

/**
 * The web-seam provider id. Deliberately upstream's own `http` rather than the
 * row id: reusing it keeps `dsh-base`'s `web` row (`fetchProvider: http`)
 * untouched, so this package never restates — and never drifts from — that
 * row's other keys. The upstream `web-fetch-http` row is disabled in this
 * package's `cordis.patch.yml` so the id is registered exactly once.
 */
const PROVIDER_ID = LOCAL_FETCH_PROVIDER_ID;

test('plugin metadata matches the frozen interface', () => {
	assert.equal(name, ROW_ID);
	assert.deepEqual(inject, ['web']);
});

test('FakeIpFetchProvider reuses upstream provider id and is always available', () => {
	const provider = new FakeIpFetchProvider(LIMITS, ['198.18.0.0/15']);

	assert.equal(provider.id, PROVIDER_ID);
	assert.equal(provider.id, 'http');
	assert.equal(provider.available(), true);
});

test('FakeIpFetchProvider validates the allowlist in its constructor', () => {
	assert.throws(
		() => new FakeIpFetchProvider(LIMITS, ['8.8.8.0/24']),
		(error) => error instanceof Error && error.message.startsWith('fakeip-fetch: '),
	);
});

test('Config({}) carries upstream limits plus the default allowlist', () => {
	const resolved = Config({});

	assert.equal(resolved.maxResponseBytes, UpstreamConfig({}).maxResponseBytes);
	assert.equal(resolved.maxBodyChars, UpstreamConfig({}).maxBodyChars);
	assert.equal(resolved.timeoutMs, UpstreamConfig({}).timeoutMs);
	assert.equal(resolved.maxRedirects, UpstreamConfig({}).maxRedirects);
	assert.equal(resolved.userAgent, UpstreamConfig({}).userAgent);

	assert.deepEqual(resolved.allowedCidrs, ['198.18.0.0/15']);
});

test('Config accepts a non-reserved allowlist at resolve time; the provider rejects it', () => {
	// Observed schemastery behaviour: `allowedCidrs` is only `z.array(z.string())`,
	// so `Config({ allowedCidrs: ['10.0.0.0/8'] })` RESOLVES SUCCESSFULLY and the
	// range check happens later, in the provider constructor via parseAllowedCidrs.
	const resolved = Config({ allowedCidrs: ['10.0.0.0/8'] });
	assert.deepEqual(resolved.allowedCidrs, ['10.0.0.0/8']);

	assert.throws(
		() => new FakeIpFetchProvider(resolved, resolved.allowedCidrs),
		(error) => error instanceof Error && error.message.startsWith('fakeip-fetch: '),
	);
});

test('apply registers exactly one provider with the web seam', () => {
	const captured = [];
	const ctx = {
		web: {
			registerFetchProvider(provider) {
				captured.push(provider);
			},
		},
	};

	apply(ctx, Config({}));

	assert.equal(captured.length, 1);
	assert.equal(captured[0].id, PROVIDER_ID);
});

// This package's patch disables the upstream `web-fetch-http` row, so upstream's
// own `apply` never runs and would no longer validate the transport limits.
// `apply` therefore delegates to it. Without that delegation an oversized
// `timeoutMs` is accepted silently, and Node coerces a timer delay above 2^31-1
// ms to 1 ms — every fetch would time out immediately.
test('apply keeps upstream transport-limit validation', () => {
	const ctx = { web: { registerFetchProvider() {} } };

	assert.throws(
		() => apply(ctx, Config({ timeoutMs: 1e12 })),
		(error) => /timeoutMs/.test(error.message),
	);
	assert.throws(
		() => apply(ctx, Config({ maxResponseBytes: -1 })),
		(error) => /maxResponseBytes/.test(error.message),
	);
	assert.throws(
		() => apply(ctx, Config({ maxRedirects: 1.5 })),
		(error) => /maxRedirects/.test(error.message),
	);
});
