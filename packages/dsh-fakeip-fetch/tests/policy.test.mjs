/**
 * Unit tests for the fake-ip address policy.
 *
 * Pure and network-free: every DNS answer is injected through a fake `lookupFn`.
 * Assertions go exclusively through the module's exported surface
 * (`parseAllowedCidrs`, `assertResolvableAddresses`) rather than through private
 * helpers or a direct `ipaddr.js` import, so a failure here always means the
 * policy is wrong — never that this file's own import specifier is unresolvable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_ALLOWED_CIDRS,
	PREFIX,
	assertResolvableAddresses,
	parseAllowedCidrs,
} from '../src/policy.js';
import { createResolver } from '../src/index.js';

/**
 * The literal every policy error must start with. Kept here as a literal rather
 * than reused from the module so that asserting on it is a real check.
 */
const PREFIX_LITERAL = 'fakeip-fetch: ';

/** Allowlist used wherever the default fake-ip pool is the subject. */
const DEFAULT_NETS = parseAllowedCidrs(DEFAULT_ALLOWED_CIDRS);

/** Match any error whose message starts with the plugin prefix. */
function isPrefixedError(error) {
	return error instanceof Error && error.message.startsWith(PREFIX_LITERAL);
}

/** Match a `WEB_BLOCKED_URL` rejection. */
function isBlockedError(error) {
	return error instanceof Error && error.code === 'WEB_BLOCKED_URL';
}

/** A `lookupFn` that records its calls and returns the given rows. */
function stubLookup(rows) {
	const calls = [];
	const lookupFn = async (hostname, options) => {
		calls.push({ hostname, options });
		return rows;
	};
	return { lookupFn, calls };
}

test('DEFAULT_ALLOWED_CIDRS is the Clash/sing-box fake-ip pool', () => {
	assert.deepEqual(DEFAULT_ALLOWED_CIDRS, ['198.18.0.0/15']);
});

test('PREFIX is the literal every policy error starts with', () => {
	assert.equal(PREFIX, PREFIX_LITERAL);
});

test('parseAllowedCidrs accepts reserved CIDRs whose block admits a member address', async (t) => {
	const accepted = [
		{ cidr: '198.18.0.0/15', inside: '198.19.255.254', family: 4 },
		{ cidr: '192.0.2.0/24', inside: '192.0.2.7', family: 4 },
		{ cidr: '240.0.0.0/4', inside: '250.1.2.3', family: 4 },
		{ cidr: '2001:db8::/32', inside: '2001:db8::1', family: 6 },
	];

	for (const { cidr, inside, family } of accepted) {
		await t.test(cidr, () => {
			const parsed = parseAllowedCidrs([cidr]);
			assert.equal(parsed.length, 1);
			// The parsed entry only means something if it actually admits an address
			// drawn from inside the written block.
			assert.equal(
				assertResolvableAddresses('example.com', [{ address: inside, family }], parsed),
				undefined,
			);
		});
	}
});

test('parseAllowedCidrs rejects non-arrays, empty arrays and non-reserved entries', async (t) => {
	const rejected = [
		{ label: 'empty array', input: [] },
		{ label: 'non-array: string', input: '198.18.0.0/15' },
		{ label: 'non-array: number', input: 42 },
		{ label: 'non-array: null', input: null },
		{ label: 'non-array: undefined', input: undefined },
		{ label: 'non-array: object', input: {} },
		{ label: 'empty string entry', input: [''] },
		{ label: 'unparseable entry', input: ['not-a-cidr'] },
		{ label: 'whole IPv4 space', input: ['0.0.0.0/0'] },
		{ label: 'whole IPv6 space', input: ['::/0'] },
		{ label: 'unspecified IPv4 block', input: ['0.0.0.0/8'] },
		{ label: 'public unicast IPv4 block', input: ['8.8.8.0/24'] },
		{ label: 'public unicast IPv6 block', input: ['2606:4700::/32'] },
		{ label: 'private IPv4 /8', input: ['10.0.0.0/8'] },
		{ label: 'private IPv4 /12', input: ['172.16.0.0/12'] },
		{ label: 'private IPv4 /16', input: ['192.168.0.0/16'] },
		{ label: 'carrier-grade NAT', input: ['100.64.0.0/10'] },
		{ label: 'loopback', input: ['127.0.0.0/8'] },
		{ label: 'link-local IPv4', input: ['169.254.0.0/16'] },
		{ label: 'unique-local IPv6', input: ['fc00::/7'] },
		{ label: 'link-local IPv6', input: ['fe80::/10'] },
	];

	for (const { label, input } of rejected) {
		await t.test(label, () => {
			assert.throws(() => parseAllowedCidrs(input), isPrefixedError);
		});
	}
});

test('assertResolvableAddresses unwraps an IPv4-mapped row before the allowlist match', () => {
	// A dual-stack lookup answers with the fake-ip address in mapped form; matching
	// it against an IPv4 allowlist entry requires unwrapping it first.
	assert.equal(
		assertResolvableAddresses(
			'example.com',
			[{ address: '::ffff:198.18.6.89', family: 6 }],
			DEFAULT_NETS,
		),
		undefined,
	);
});

test('assertResolvableAddresses never matches across address families', () => {
	const v6Nets = parseAllowedCidrs(['2001:db8::/32']);
	assert.throws(
		() => assertResolvableAddresses('example.com', [{ address: '1.1.1.1', family: 4 }], v6Nets),
		isBlockedError,
	);

	const v4Nets = parseAllowedCidrs(['198.18.0.0/15']);
	assert.throws(
		() => assertResolvableAddresses('example.com', [{ address: '2001:db8::1', family: 6 }], v4Nets),
		isBlockedError,
	);
});

test('assertResolvableAddresses matches inside the allowlist and rejects outside it', () => {
	assert.equal(
		assertResolvableAddresses('example.com', [{ address: '198.18.6.89', family: 4 }], DEFAULT_NETS),
		undefined,
	);

	// Both are `reserved`, but outside the configured range.
	assert.throws(
		() => assertResolvableAddresses('example.com', [{ address: '198.51.100.1', family: 4 }], DEFAULT_NETS),
		isBlockedError,
	);
	assert.throws(
		() => assertResolvableAddresses('example.com', [{ address: '8.8.8.8', family: 4 }], DEFAULT_NETS),
		isBlockedError,
	);
});

test('assertResolvableAddresses rejects any answer set that is not allowlisted', async (t) => {
	const rejected = [
		{ label: 'loopback', addresses: [{ address: '127.0.0.1', family: 4 }] },
		{ label: 'cloud metadata', addresses: [{ address: '169.254.169.254', family: 4 }] },
		{
			label: 'mixed fake-ip plus private',
			addresses: [
				{ address: '198.18.6.89', family: 4 },
				{ address: '10.0.0.1', family: 4 },
			],
		},
	];

	for (const { label, addresses } of rejected) {
		await t.test(label, () => {
			assert.throws(
				() => assertResolvableAddresses('example.com', addresses, DEFAULT_NETS),
				isBlockedError,
			);
		});
	}
});

// An empty answer set is not a policy decision, so it must NOT report
// WEB_BLOCKED_URL: the provider retries on that code, and retrying a resolution
// that returned nothing would only repeat the same empty lookup. Upstream's
// resolvePublicAddresses draws the same line (WEB_PROVIDER_ERROR here).
test('assertResolvableAddresses reports an empty answer set as a provider error', () => {
	assert.throws(
		() => assertResolvableAddresses('example.com', [], DEFAULT_NETS),
		(error) => {
			assert.match(error.message, /^fakeip-fetch: /);
			assert.equal(error.code, 'WEB_PROVIDER_ERROR');
			return true;
		},
	);
});

// There is deliberately no public-unicast bypass on this path: the relaxed
// resolver is reached only after the strict upstream guard already refused the
// request, so re-accepting a public address here could only widen the guard.
test('assertResolvableAddresses accepts the allowlist and rejects public addresses', () => {
	assert.equal(
		assertResolvableAddresses('example.com', [{ address: '198.18.6.89', family: 4 }], DEFAULT_NETS),
		undefined,
	);
	assert.throws(
		() => assertResolvableAddresses('example.com', [{ address: '1.1.1.1', family: 4 }], DEFAULT_NETS),
		isBlockedError,
	);
});

test('createResolver resolves a fake-ip answer set', async () => {
	const { lookupFn } = stubLookup([{ address: '198.18.6.89', family: 4 }]);
	const resolve = createResolver(DEFAULT_NETS, lookupFn);

	assert.deepEqual(await resolve('example.com', new AbortController().signal), [
		{ address: '198.18.6.89', family: 4 },
	]);
});

test('createResolver rejects a non-allowlisted answer set with WEB_BLOCKED_URL', async () => {
	const { lookupFn } = stubLookup([{ address: '10.0.0.1', family: 4 }]);
	const resolve = createResolver(DEFAULT_NETS, lookupFn);

	await assert.rejects(() => resolve('example.com', new AbortController().signal), isBlockedError);
});

test('createResolver normalizes an IPv4-mapped fake-ip row before matching', async () => {
	const { lookupFn } = stubLookup([{ address: '::ffff:198.18.6.89', family: 6 }]);
	const resolve = createResolver(DEFAULT_NETS, lookupFn);

	// The row is returned as resolved; the point is that it passed the policy,
	// which requires unwrapping the mapped form before the allowlist match.
	assert.deepEqual(await resolve('example.com', new AbortController().signal), [
		{ address: '::ffff:198.18.6.89', family: 6 },
	]);
});

test('createResolver judges an IP literal without calling lookupFn', async () => {
	const { lookupFn, calls } = stubLookup([{ address: '10.0.0.1', family: 4 }]);
	const resolve = createResolver(DEFAULT_NETS, lookupFn);

	assert.deepEqual(await resolve('198.18.6.89', new AbortController().signal), [
		{ address: '198.18.6.89', family: 4 },
	]);
	// A public literal is not allowlisted either, and still never reaches lookupFn.
	await assert.rejects(() => resolve('1.1.1.1', new AbortController().signal), isBlockedError);
	assert.equal(calls.length, 0);
});

test('createResolver strips brackets from an IPv6 literal without calling lookupFn', async () => {
	const { lookupFn, calls } = stubLookup([{ address: '10.0.0.1', family: 4 }]);
	const resolve = createResolver(parseAllowedCidrs(['2001:db8::/32']), lookupFn);

	assert.deepEqual(await resolve('[2001:db8::1]', new AbortController().signal), [
		{ address: '2001:db8::1', family: 6 },
	]);
	assert.equal(calls.length, 0);
});

test('createResolver passes the exact lookup options', async () => {
	const { lookupFn, calls } = stubLookup([{ address: '198.18.6.89', family: 4 }]);
	const resolve = createResolver(DEFAULT_NETS, lookupFn);

	await resolve('example.com', new AbortController().signal);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].hostname, 'example.com');
	assert.deepEqual(calls[0].options, { all: true, order: 'verbatim' });
});

test('createResolver throws when lookupFn returns no rows', async () => {
	const { lookupFn } = stubLookup([]);
	const resolve = createResolver(DEFAULT_NETS, lookupFn);

	await assert.rejects(() => resolve('example.com', new AbortController().signal), isPrefixedError);
});
