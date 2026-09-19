/**
 * Security-focused tests for the fake-ip address policy.
 *
 * One concern per test, each pinning a specific defect the policy exists to
 * prevent. Everything here goes through the exported surface: `parseAllowedCidrs`
 * (allowlist validation), `assertResolvableAddresses` (per-answer-set policy) and
 * `createResolver` (the resolver the provider actually installs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { WebError } from '@deepseek-ai/dsh-web';
import ipaddr from 'ipaddr.js';

import {
	DEFAULT_ALLOWED_CIDRS,
	assertResolvableAddresses,
	parseAllowedCidrs,
	stripBrackets,
} from '../src/policy.js';
import { createResolver, name as rowId } from '../src/index.js';

/** The literal every policy error must start with, kept as a literal on purpose. */
const PREFIX_LITERAL = 'fakeip-fetch: ';

/** Allowlist used wherever the default fake-ip pool is the subject. */
const DEFAULT_NETS = parseAllowedCidrs(DEFAULT_ALLOWED_CIDRS);

/**
 * The endpoints that must never be reachable through an exemption, as literals.
 *
 * Kept as a literal here on purpose: deriving them from the module under test
 * would make the assertions below agree with whatever the module happens to
 * contain, which is exactly the property they exist to check.
 */
const SENSITIVE_ENDPOINTS = [
	'192.0.0.192',
	'192.0.0.170',
	'192.0.0.171',
	'169.254.169.254',
	'169.254.0.23',
	'100.100.100.200',
];

/** Assert a call throws a `WebError` with the given code and a prefixed message. */
function throwsCoded(fn, code) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof WebError, `expected a WebError, got ${error?.constructor?.name}`);
		assert.equal(error.name, 'WebError');
		assert.equal(error.code, code);
		assert.ok(
			error.message.startsWith(PREFIX_LITERAL),
			`message must start with "${PREFIX_LITERAL}", got "${error.message}"`,
		);
		return true;
	});
}

test('parseAllowedCidrs rejects an allowlist entry whose MASKED block leaves reserved space', async (t) => {
	// Defect: `ipaddr.parseCIDR` does not mask its input, so `198.18.0.0/5` keeps
	// the reserved base `198.18.0.0` while the entry actually covers
	// `192.0.0.0/5` — which spans the private `192.168.0.0/16`. Validating the
	// written base instead of the masked block lets one character (`.0/5` for
	// `.0/15`) silently open the LAN. Every entry below has a reserved-looking
	// base but a masked block that escapes reserved space.
	const rejected = [
		'198.18.0.0/5',
		'192.0.2.7/1',
		'192.0.0.0/1',
		'240.0.0.0/1',
		'2001:db8::/1',
		'3fff::/1',
		'0.0.0.0/0',
		'::/0',
		'0.0.0.0/8',
		'10.0.0.0/8',
		'127.0.0.0/8',
		'169.254.0.0/16',
		'8.8.8.0/24',
	];

	for (const cidr of rejected) {
		await t.test(cidr, () => {
			assert.throws(
				() => parseAllowedCidrs([cidr]),
				(error) => {
					assert.ok(error instanceof Error);
					assert.ok(error.message.startsWith(PREFIX_LITERAL), error.message);
					return true;
				},
			);
		});
	}
});

test('parseAllowedCidrs accepts reserved blocks and the entries really admit their members', async (t) => {
	// The counterpart to the masking test: these must NOT be over-rejected. Each
	// acceptance is confirmed by driving a member address through the policy, so
	// the parsed entry cannot be an empty stub that merely "parsed".
	const accepted = [
		{ cidr: '198.18.0.0/15', member: '198.19.255.254', family: 4 },
		{ cidr: '192.0.2.0/24', member: '192.0.2.7', family: 4 },
		{ cidr: '198.51.100.0/24', member: '198.51.100.9', family: 4 },
		{ cidr: '203.0.113.0/24', member: '203.0.113.9', family: 4 },
		{ cidr: '192.88.99.0/24', member: '192.88.99.1', family: 4 },
		{ cidr: '240.0.0.0/4', member: '250.1.2.3', family: 4 },
		{ cidr: '2001:db8::/32', member: '2001:db8::1', family: 6 },
		{ cidr: '3fff::/20', member: '3fff::1', family: 6 },
	];

	for (const { cidr, member, family } of accepted) {
		await t.test(cidr, () => {
			const nets = parseAllowedCidrs([cidr]);
			assert.equal(nets.length, 1);
			assert.equal(
				assertResolvableAddresses('example.com', [{ address: member, family }], nets),
				undefined,
			);
		});
	}
});

test('parseAllowedCidrs rejects an entry that covers a sensitive endpoint', async (t) => {
	// Defect: `reserved` is not "safe to exempt". `192.0.0.0/24` is a reserved
	// block, so a containment-only check accepts it — but it holds `192.0.0.192`
	// (Oracle Cloud instance metadata) and `192.0.0.170` / `.171` (NAT64/DNS64
	// discovery). An operator who wrote that entry would hand every hostname a
	// route to cloud metadata. Each entry below is reserved yet covers at least
	// one of those endpoints, so it must be refused outright.
	const rejected = ['192.0.0.0/24', '192.0.0.128/25', '192.0.0.192/32'];

	for (const cidr of rejected) {
		await t.test(cidr, () => {
			assert.throws(
				() => parseAllowedCidrs([cidr]),
				(error) => {
					assert.ok(error instanceof Error);
					assert.ok(
						error.message.startsWith(PREFIX_LITERAL),
						`message must start with "${PREFIX_LITERAL}", got "${error.message}"`,
					);
					const named = SENSITIVE_ENDPOINTS.filter((address) => error.message.includes(address));
					assert.ok(
						named.length > 0,
						`message must name the offending endpoint, got "${error.message}"`,
					);
					return true;
				},
			);
		});
	}
});

test('the sensitive-endpoint rejection judges the MASKED block, not the written base', () => {
	// Defect: the boundary must sit at the block the entry actually covers.
	// `192.0.0.0/25` covers `192.0.0.0`-`192.0.0.127` and therefore excludes
	// `192.0.0.192`, so it must still be accepted; `192.0.0.128/25` covers
	// `192.0.0.128`-`192.0.0.255` and includes it, so it must be rejected. Both
	// halves are asserted so a fix that simply bans the whole `192.0.0.0/24`
	// neighbourhood (over-rejection) fails just as loudly as one that misses it.
	const acceptedNets = parseAllowedCidrs(['192.0.0.0/25']);
	assert.equal(acceptedNets.length, 1);
	assert.equal(
		assertResolvableAddresses('example.com', [{ address: '192.0.0.127', family: 4 }], acceptedNets),
		undefined,
	);

	assert.throws(
		() => parseAllowedCidrs(['192.0.0.128/25']),
		(error) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.startsWith(PREFIX_LITERAL), error.message);
			assert.ok(
				error.message.includes('192.0.0.192'),
				`message must name the covered endpoint, got "${error.message}"`,
			);
			return true;
		},
	);
});

test('no allowlistable reserved block admits a sensitive endpoint', () => {
	// The general invariant, derived from the library rather than a fixed list: of
	// every `reserved` block `ipaddr.js` knows, any block this policy ACCEPTS must
	// still refuse all six sensitive endpoints through `assertResolvableAddresses`.
	// Pinning one entry (the test above) would miss the next reserved block that
	// happens to carry a metadata endpoint; this one cannot.
	const blocks = ['IPv4', 'IPv6'].flatMap((kind) =>
		(ipaddr[kind].prototype.SpecialRanges.reserved ?? []).map(([net, prefixLen]) => ({
			cidr: `${net.toString()}/${prefixLen}`,
		})),
	);
	assert.ok(blocks.length > 0, 'ipaddr.js exposed no reserved blocks to check');

	let acceptedBlocks = 0;
	for (const { cidr } of blocks) {
		let nets;
		try {
			nets = parseAllowedCidrs([cidr]);
		} catch {
			// Not allowlistable at all (either outside reserved space after
			// masking, or covering a sensitive endpoint) — nothing to check.
			continue;
		}
		acceptedBlocks += 1;
		for (const address of SENSITIVE_ENDPOINTS) {
			assert.throws(
				() => assertResolvableAddresses('attacker.test', [{ address, family: 4 }], nets),
				(error) => {
					assert.ok(
						error instanceof WebError,
						`expected a WebError, got ${error?.constructor?.name}`,
					);
					assert.equal(error.code, 'WEB_BLOCKED_URL');
					return true;
				},
				`${cidr} is allowlistable but admits ${address}`,
			);
		}
	}
	assert.ok(acceptedBlocks > 0, 'no reserved block was accepted, so the invariant was vacuous');
});

test('the shipped default allowlist still parses, admits its own range and refuses metadata', () => {
	// Defect: the new sensitive-endpoint rejection must not narrow the shipped
	// default. `198.18.0.0/15` is the Clash / sing-box fake-ip pool and holds no
	// sensitive endpoint, so it must keep parsing and keep admitting its members,
	// while `192.0.0.192` stays blocked with the retryable `WEB_BLOCKED_URL` code.
	const nets = parseAllowedCidrs(DEFAULT_ALLOWED_CIDRS);
	assert.equal(nets.length, DEFAULT_ALLOWED_CIDRS.length);
	assert.equal(
		assertResolvableAddresses('example.com', [{ address: '198.18.6.89', family: 4 }], nets),
		undefined,
	);
	throwsCoded(
		() => assertResolvableAddresses('attacker.test', [{ address: '192.0.0.192', family: 4 }], nets),
		'WEB_BLOCKED_URL',
	);
});

test('assertResolvableAddresses rejects a NAT64-embedded address that is not allowlisted', () => {
	// Defect: `2001:4860:64::a9fe:a9fe` is the NAT64 form of `169.254.169.254`
	// (the cloud metadata endpoint). It is a public unicast IPv6 address, so a
	// "public unicast is fine" bypass would wave it through; only an
	// allowlist-only rule refuses it.
	throwsCoded(
		() =>
			assertResolvableAddresses(
				'attacker.test',
				[{ address: '2001:4860:64::a9fe:a9fe', family: 6 }],
				DEFAULT_NETS,
			),
		'WEB_BLOCKED_URL',
	);
});

test('assertResolvableAddresses rejects the whole answer set when any row is not allowlisted', () => {
	// Defect: an all-or-nothing check. A record set that pairs one allowlisted
	// fake-ip row with one non-allowlisted row must be refused outright, or an
	// attacker-controlled set could smuggle a LAN destination past the exemption.
	throwsCoded(
		() =>
			assertResolvableAddresses(
				'attacker.test',
				[
					{ address: '198.18.6.89', family: 4 },
					{ address: '2001:4860:64::a9fe:a9fe', family: 6 },
				],
				DEFAULT_NETS,
			),
		'WEB_BLOCKED_URL',
	);

	// The allowlisted row first must not short-circuit the loop either.
	throwsCoded(
		() =>
			assertResolvableAddresses(
				'attacker.test',
				[
					{ address: '10.0.0.1', family: 4 },
					{ address: '198.18.6.89', family: 4 },
				],
				DEFAULT_NETS,
			),
		'WEB_BLOCKED_URL',
	);
});

test('assertResolvableAddresses accepts an allowlisted row', () => {
	// The genuine acceptance case: a row inside the default fake-ip pool is the
	// one thing this relaxed path exists to let through.
	assert.equal(
		assertResolvableAddresses('example.com', [{ address: '198.18.6.89', family: 4 }], DEFAULT_NETS),
		undefined,
	);
});

test('assertResolvableAddresses rejects a public unicast address that is not allowlisted', () => {
	// There is no public bypass: the relaxed path is reached only after the strict
	// upstream guard already refused the request, so re-accepting a public address
	// here could only widen the guard.
	throwsCoded(
		() => assertResolvableAddresses('example.com', [{ address: '1.1.1.1', family: 4 }], DEFAULT_NETS),
		'WEB_BLOCKED_URL',
	);
});

test('assertResolvableAddresses rejects malformed rows as provider errors', async (t) => {
	// Defect: an unchecked row reaches `ipaddr.parse` and escapes as an uncoded,
	// unprefixed error — which upstream then rewrites, losing the diagnosis. Row
	// shape is validated first, mirroring upstream's own "resolved to an invalid
	// IP address" check.
	const malformed = [
		{ label: 'undefined row', addresses: [undefined] },
		{ label: 'null row', addresses: [null] },
		{ label: 'empty object row', addresses: [{}] },
		{ label: 'row without family', addresses: [{ address: '1.1.1.1' }] },
		{ label: 'family contradicts address', addresses: [{ address: '1.1.1.1', family: 6 }] },
		{ label: 'family contradicts IPv6 address', addresses: [{ address: '2001:db8::1', family: 4 }] },
		{ label: 'address is not an IP', addresses: [{ address: 'not-an-ip', family: 4 }] },
		{ label: 'address is not a string', addresses: [{ address: 16909060, family: 4 }] },
		{ label: 'non-array addresses', addresses: '198.18.6.89' },
		{ label: 'undefined addresses', addresses: undefined },
	];

	for (const { label, addresses } of malformed) {
		await t.test(label, () => {
			throwsCoded(
				() => assertResolvableAddresses('example.com', addresses, DEFAULT_NETS),
				'WEB_PROVIDER_ERROR',
			);
		});
	}
});

test('assertResolvableAddresses reports an empty answer set as a provider error', () => {
	// Defect: reporting WEB_BLOCKED_URL here would make the provider retry a
	// resolution that returned nothing, repeating the same empty lookup forever.
	// An empty answer set is not a policy decision.
	throwsCoded(
		() => assertResolvableAddresses('example.com', [], DEFAULT_NETS),
		'WEB_PROVIDER_ERROR',
	);
});

test('every assertResolvableAddresses rejection is a WebError with a prefixed message', () => {
	// Defect: a plain `Error` carrying `.code` has that code destroyed by upstream,
	// which rethrows only errors it recognises as `WebError`. The distinction
	// between blocked and provider-error would then be inert.
	const cases = [
		{ addresses: [], code: 'WEB_PROVIDER_ERROR' },
		{ addresses: [{}], code: 'WEB_PROVIDER_ERROR' },
		{ addresses: [{ address: '1.1.1.1', family: 4 }], code: 'WEB_BLOCKED_URL' },
	];

	for (const { addresses, code } of cases) {
		assert.throws(() => assertResolvableAddresses('example.com', addresses, DEFAULT_NETS), (error) => {
			assert.ok(error instanceof WebError);
			assert.equal(error.name, 'WebError');
			assert.equal(error.code, code);
			assert.ok(error.message.startsWith(PREFIX_LITERAL));
			return true;
		});
	}
});

test('createResolver rejects promptly when the signal aborts during lookup', async () => {
	// Defect: `dns.lookup` cannot be cancelled, so a resolver that simply awaits it
	// makes the caller wait out the whole lookup (and `timeoutMs` cannot bound DNS
	// on this path at all).
	const controller = new AbortController();
	const slowLookup = async () => {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		return [{ address: '198.18.6.89', family: 4 }];
	};
	const resolve = createResolver(DEFAULT_NETS, slowLookup);

	setTimeout(() => controller.abort(), 50);

	const startedAt = Date.now();
	await assert.rejects(() => resolve('example.com', controller.signal));
	const elapsed = Date.now() - startedAt;

	assert.ok(elapsed < 500, `expected a prompt rejection, took ${elapsed}ms of a 1000ms lookup`);
});

test('createResolver rejects an already-aborted signal without calling lookupFn', async () => {
	// Defect: an already-cancelled request must not start DNS work it will only
	// discard — the abort is checked before the lookup is issued.
	let calls = 0;
	const lookupFn = async () => {
		calls += 1;
		return [{ address: '198.18.6.89', family: 4 }];
	};
	const resolve = createResolver(DEFAULT_NETS, lookupFn);

	const controller = new AbortController();
	controller.abort();

	await assert.rejects(() => resolve('example.com', controller.signal));
	assert.equal(calls, 0);
});

test('createResolver returns a resolver of arity 2', () => {
	// The returned function is upstream's `HttpFetchResolver` shape: (hostname, signal).
	assert.equal(typeof createResolver, 'function');
	const resolve = createResolver(DEFAULT_NETS, async () => []);
	assert.equal(resolve.length, 2);
});

test('cordis.patch.yml inserts the row whose id equals the host half name', async () => {
	// Defect: the loader entry id must equal the host half's `export const name`,
	// or `cordis-plugin-loader` hard-crashes the host at startup. The file must
	// also disable the upstream `web-fetch-http` row, which registers the same
	// provider id `http`; registering it twice throws WEB_DUPLICATE_PROVIDER.
	const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

	const insertBlock = text.match(/- insert:\s*\n\s*- id:\s*(\S+)/);
	assert.ok(insertBlock, 'cordis.patch.yml has no "- insert:" block with an id');
	assert.equal(insertBlock[1], rowId);

	const disabledRow = text.match(/- id:\s*(\S+)\s*\n\s*disabled:\s*true/);
	assert.ok(disabledRow, 'cordis.patch.yml does not disable any row');
	assert.equal(disabledRow[1], 'web-fetch-http');
});

test('stripBrackets removes one bracket pair and nothing else', async (t) => {
	const cases = [
		{ label: 'bracketed IPv6 literal', input: '[2001:db8::1]', expected: '2001:db8::1' },
		{ label: 'bare IPv6', input: '2001:db8::1', expected: '2001:db8::1' },
		{ label: 'plain IPv4', input: '1.1.1.1', expected: '1.1.1.1' },
		{ label: 'empty string', input: '', expected: '' },
		{ label: 'only a leading bracket', input: '[2001:db8::1', expected: '[2001:db8::1' },
		{ label: 'only a trailing bracket', input: '2001:db8::1]', expected: '2001:db8::1]' },
	];

	for (const { label, input, expected } of cases) {
		await t.test(label, () => {
			assert.equal(stripBrackets(input), expected);
		});
	}
});
