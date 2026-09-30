/**
 * Wiring tests for the fake-ip fetch provider plugin half.
 *
 * No network: the provider is constructed and inspected, `apply` is driven with
 * a hand-written fake `ctx`, and the fallback tests drive `fetch()` against a
 * stubbed upstream transport so no socket is opened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebError } from '@deepseek-ai/dsh-web';
import {
	Config as UpstreamConfig,
	HttpFetchProvider,
	LOCAL_FETCH_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-fetch-http';

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

/**
 * Drive `fetch()` with no network.
 *
 * Both halves of the provider are real upstream instances and their backing
 * fields are private, so the only seam is upstream's own `fetch` on the
 * prototype. The contract under test is ordered — strict first, relaxed second —
 * which is the order `plan` is consumed in. Restored even when an assertion
 * throws, so one failure cannot leak a stub into the next test.
 */
function withStubbedTransport(plan, run) {
	const original = HttpFetchProvider.prototype.fetch;
	const seen = [];

	HttpFetchProvider.prototype.fetch = async function (request) {
		seen.push(request.url);
		const step = plan.shift();
		if (step === undefined) throw new Error('stubbed transport called more times than planned');
		if (step instanceof Error) throw step;
		return step;
	};

	return Promise.resolve()
		.then(() => run(seen))
		.finally(() => {
			HttpFetchProvider.prototype.fetch = original;
		});
}

/** The guard's own refusal, the only code that may trigger the fallback. */
function blockedError(hostname) {
	return new WebError(
		`URL hostname "${hostname}" resolves to a non-public IP address`,
		'WEB_BLOCKED_URL',
	);
}

test('fetch returns the strict result without consulting the fallback', async () => {
	const result = { status: 200, url: 'https://example.com/' };

	await withStubbedTransport([result], async (seen) => {
		const provider = new FakeIpFetchProvider(LIMITS, ['198.18.0.0/15']);

		assert.equal(await provider.fetch({ url: 'https://example.com/' }, undefined), result);
		assert.deepEqual(seen, ['https://example.com/']);
	});
});

test('fetch retries through the relaxed resolver when the guard blocks the URL', async () => {
	const result = { status: 200, url: 'https://example.com/' };

	await withStubbedTransport([blockedError('example.com'), result], async (seen) => {
		const provider = new FakeIpFetchProvider(LIMITS, ['198.18.0.0/15']);

		assert.equal(await provider.fetch({ url: 'https://example.com/' }, undefined), result);
		assert.equal(seen.length, 2);
	});
});

test('fetch reports the fallback failure when both paths fail', async () => {
	// Defect: rethrowing the strict `WEB_BLOCKED_URL` here blamed DNS for
	// requests whose real failure happened downstream of the exemption — a
	// cross-origin redirect, a response over the size limit, a refused
	// connection. The operator was sent to debug a resolver that was working.
	const fallbackError = new WebError(
		'cross-origin redirect to https://other.example is not followed automatically; retry against that URL directly',
		'WEB_REDIRECT_BLOCKED',
	);

	await withStubbedTransport([blockedError('example.com'), fallbackError], async (seen) => {
		const provider = new FakeIpFetchProvider(LIMITS, ['198.18.0.0/15']);

		await assert.rejects(
			() => provider.fetch({ url: 'https://example.com/' }, undefined),
			(error) => error.code === 'WEB_REDIRECT_BLOCKED',
		);
		assert.equal(seen.length, 2);
	});
});

test('fetch keeps the guard diagnosis when the fallback refuses the address too', async () => {
	// Both paths rejected the same destination, so the exemption is not the
	// subject and the guard's own wording stays the answer. This is the case the
	// package documents: a rethrow that preserves the guard's diagnosis.
	const guardError = blockedError('example.com');
	const fallbackError = new WebError(
		'fakeip-fetch: URL hostname "example.com" resolves to a non-public IP address',
		'WEB_BLOCKED_URL',
	);

	await withStubbedTransport([guardError, fallbackError], async (seen) => {
		const provider = new FakeIpFetchProvider(LIMITS, ['198.18.0.0/15']);

		await assert.rejects(
			() => provider.fetch({ url: 'https://example.com/' }, undefined),
			(error) => error === guardError,
		);
		assert.equal(seen.length, 2);
	});
});

test('fetch does not retry when the guard refuses for a non-policy reason', async () => {
	const unsupported = new WebError('unsupported content type "unknown"', 'WEB_UNSUPPORTED_CONTENT_TYPE');

	await withStubbedTransport([unsupported], async (seen) => {
		const provider = new FakeIpFetchProvider(LIMITS, ['198.18.0.0/15']);

		await assert.rejects(
			() => provider.fetch({ url: 'https://example.com/' }, undefined),
			(error) => error.code === 'WEB_UNSUPPORTED_CONTENT_TYPE',
		);
		assert.equal(seen.length, 1);
	});
});
