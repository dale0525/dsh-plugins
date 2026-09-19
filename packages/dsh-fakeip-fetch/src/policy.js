/**
 * Address policy for the fake-ip fetch provider.
 *
 * A local DNS proxy in "fake-ip" mode answers every external hostname with an
 * address from one fixed reserved range (Clash and sing-box default to
 * `198.18.0.0/15`). The upstream `@deepseek-ai/dsh-web-fetch-http` guard
 * classifies those answers as non-public and refuses the request with
 * `WEB_BLOCKED_URL`, which makes every legitimate site unfetchable.
 *
 * This module is the single source of truth for what that fallback accepts. The
 * fallback is reached only after the upstream guard has already refused the
 * request, so it accepts **nothing but the configured allowlist**: an address is
 * acceptable only when it falls inside a range the operator explicitly listed
 * AND that listed range is itself a reserved, non-routable block. There is
 * deliberately no "public unicast" bypass — the upstream guard already accepted
 * every public destination on the strict path, so re-accepting one here could
 * only ever widen the guard.
 */
import { isIP } from 'node:net';
import { WebError } from '@deepseek-ai/dsh-web';
import ipaddr from 'ipaddr.js';

/**
 * Clash / sing-box default fake-ip pool. Shipped as the default so the plugin
 * works out of the box on the common topology; override it with the
 * `allowedCidrs` config when the local proxy uses a different pool.
 */
export const DEFAULT_ALLOWED_CIDRS = ['198.18.0.0/15'];

/**
 * Every `reserved` block `ipaddr.js` knows about, derived at load time.
 *
 * Derived rather than copied so the list cannot drift from the library that
 * `range()` itself consults. `reserved` is a set of small discrete blocks
 * (`192.0.0.0/24`, `198.18.0.0/15`, `240.0.0.0/4`, …), not one contiguous
 * range — which is exactly why a prefix-length ceiling alone is insufficient:
 * a wide-enough prefix can straddle reserved space into public unicast.
 */
const RESERVED_BLOCKS = ['IPv4', 'IPv6'].flatMap((kind) => {
	const blocks = ipaddr[kind].prototype.SpecialRanges.reserved ?? [];
	return blocks.map(([net, prefixLen]) => ({ net, prefixLen }));
});

/**
 * Endpoints that must never be exempted, whatever the allowlist says.
 *
 * `reserved` is not the same as "safe to exempt": `192.0.0.0/24` (IETF Protocol
 * Assignments) is reserved, yet it contains `192.0.0.192` — the Oracle Cloud
 * instance-metadata endpoint — and `192.0.0.170` / `192.0.0.171`, which the
 * DNS64/NAT64 discovery procedure uses. An operator who wrote
 * `allowedCidrs: ['192.0.0.0/24']` would therefore hand any hostname the ability
 * to reach cloud metadata, which is exactly what this plugin promises never to
 * allow.
 *
 * The other well-known metadata endpoints (`169.254.169.254`, `100.100.100.200`,
 * `169.254.0.23`) already sit outside every reserved block and so cannot be
 * allowlisted in the first place; they are listed anyway so that the invariant
 * is stated in one place and keeps holding if `ipaddr.js` ever reclassifies them.
 */
const SENSITIVE_ADDRESSES = [
	{ address: '192.0.0.192', note: 'Oracle Cloud instance metadata' },
	{ address: '192.0.0.170', note: 'NAT64/DNS64 discovery' },
	{ address: '192.0.0.171', note: 'NAT64/DNS64 discovery' },
	{ address: '169.254.169.254', note: 'cloud instance metadata' },
	{ address: '169.254.0.23', note: 'cloud instance metadata' },
	{ address: '100.100.100.200', note: 'cloud instance metadata' },
].map(({ address, note }) => ({ parsed: ipaddr.parse(address), address, note }));

/**
 * Error message prefix, so every failure from this plugin is greppable.
 *
 * Exported because the tests assert on it; keeping the literal in one place is
 * what makes the assertion meaningful rather than self-fulfilling.
 */
export const PREFIX = 'fakeip-fetch: ';

/**
 * Build a coded error.
 *
 * The class is the seam's own `WebError`, not a plain `Error`, because upstream
 * `requestOnce` rethrows only errors it recognises as `WebError` and rewrites
 * everything else to `WEB_PROVIDER_ERROR`. A plain `Error` carrying `.code`
 * would therefore have its code silently destroyed and the distinction below
 * would be inert.
 *
 * The codes mirror upstream's `resolvePublicAddresses`: a destination the
 * policy refuses is `WEB_BLOCKED_URL`, while a resolution that produced nothing
 * usable is `WEB_PROVIDER_ERROR`. Keeping them distinct matters because the
 * provider retries only on `WEB_BLOCKED_URL` — an empty answer set is not a
 * policy decision and must not be treated as one.
 */
function codedError(code, message) {
	return new WebError(PREFIX + message, code);
}

/** Strip the brackets Node keeps on an IPv6 literal in a URL hostname. */
export function stripBrackets(hostname) {
	return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Parse and validate the operator's allowlist.
 *
 * Every entry must describe a block that lies **entirely** inside reserved
 * space. The subtlety: `ipaddr.parseCIDR` does not mask its input, so
 * `198.18.0.0/5` yields the reserved base `198.18.0.0` with prefix 5 — a range
 * check on the parsed base therefore passes while the entry actually covers
 * `192.0.0.0/5`, which runs to `199.255.255.255` and includes the private
 * `192.168.0.0/16`. A single character (`.0/5` for `.0/15`) would silently open
 * the LAN, so the effective block is masked first and must be contained in one
 * reserved block.
 *
 * A real private range is refused as well — exempting it would let a hostname
 * steer the fetcher at the LAN or at a cloud metadata endpoint.
 *
 * @param cidrs - configured allowlist entries, e.g. `['198.18.0.0/15']`.
 * @returns parsed entries, ready for {@link matchesAnyCidr}.
 */
export function parseAllowedCidrs(cidrs) {
	if (!Array.isArray(cidrs) || cidrs.length === 0) {
		throw new Error(`${PREFIX}allowedCidrs must be a non-empty array of CIDR strings`);
	}
	return cidrs.map((entry) => {
		if (typeof entry !== 'string' || entry.length === 0) {
			throw new Error(`${PREFIX}allowedCidrs entries must be non-empty strings`);
		}
		let net;
		let prefixLen;
		try {
			[net, prefixLen] = ipaddr.parseCIDR(entry);
		} catch {
			throw new Error(`${PREFIX}allowedCidrs entry "${entry}" is not a valid CIDR`);
		}
		const kind = net.kind();
		const Address = kind === 'ipv4' ? ipaddr.IPv4 : ipaddr.IPv6;
		// Mask the written base: `networkAddressFromCIDR` is what the entry
		// actually covers, and what must be judged.
		const network = Address.networkAddressFromCIDR(entry);
		const contained = RESERVED_BLOCKS.some(
			({ net: block, prefixLen: blockPrefix }) =>
				block.kind() === kind && blockPrefix <= prefixLen && network.match(block, blockPrefix),
		);
		if (!contained) {
			const range = network.range();
			throw new Error(
				`${PREFIX}allowedCidrs entry "${entry}" covers ${network.toString()}/${prefixLen}, ` +
					`which is not contained in reserved space (${range}); ` +
					'exempting it would widen the fetch guard beyond fake-ip',
			);
		}
		// Reserved is necessary but not sufficient: a reserved block can still
		// hold a cloud-metadata or NAT64-discovery endpoint. Refuse such an entry
		// outright rather than silently narrowing it, so the operator learns the
		// entry is unusable instead of believing it took effect.
		for (const { parsed, address, note } of SENSITIVE_ADDRESSES) {
			if (parsed.kind() === kind && parsed.match(network, prefixLen)) {
				throw new Error(
					`${PREFIX}allowedCidrs entry "${entry}" covers ${address} (${note}), ` +
						'which must never be exempted from the fetch guard',
				);
			}
		}
		return { net: network, prefixLen };
	});
}

/**
 * Normalize one address for range matching.
 *
 * An IPv4-mapped IPv6 address (`::ffff:198.18.6.89`) is unwrapped to its IPv4
 * form first: a dual-stack lookup returns the fake-ip answer in that shape, and
 * comparing it against an IPv4 allowlist entry without unwrapping would fail
 * and reject every hostname.
 *
 * @param address - textual IPv4 or IPv6 address, brackets allowed.
 * @returns the parsed `ipaddr.js` address object.
 */
function normalizeAddress(address) {
	const parsed = ipaddr.parse(stripBrackets(address));
	return parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
}

/** True when the address falls inside any parsed allowlist entry. */
function matchesAnyCidr(address, nets) {
	const parsed = normalizeAddress(address);
	return nets.some(({ net, prefixLen }) => parsed.kind() === net.kind() && parsed.match(net, prefixLen));
}

/**
 * Reject a DNS answer set unless every row is well-formed and allowlisted.
 *
 * All-or-nothing: a hostname that returns one fake-ip address and one real
 * private address is refused outright, so an attacker-controlled record set
 * cannot smuggle a LAN destination through the exemption. There is no public
 * bypass — see the module header for why re-accepting a public address here
 * could only widen the guard.
 *
 * Row shape is validated before the allowlist is consulted, mirroring upstream's
 * own "resolved to an invalid IP address" check. Without it a row whose `family`
 * contradicts its address (or a row that is not an object at all) would reach
 * `ipaddr.parse` and escape as an uncoded, unprefixed error.
 *
 * @param hostname - the URL hostname, for the error message.
 * @param addresses - `{ address, family }` rows from resolution.
 * @param nets - parsed allowlist entries.
 * @throws a {@link WebError} with `code === 'WEB_BLOCKED_URL'` when any address
 * is outside the allowlist, and `WEB_PROVIDER_ERROR` when there is nothing
 * well-formed to judge.
 */
export function assertResolvableAddresses(hostname, addresses, nets) {
	if (!Array.isArray(addresses) || addresses.length === 0) {
		throw codedError('WEB_PROVIDER_ERROR', `hostname "${hostname}" resolved to no addresses`);
	}
	for (const entry of addresses) {
		if (entry === null || typeof entry !== 'object' || typeof entry.address !== 'string') {
			throw codedError('WEB_PROVIDER_ERROR', `hostname "${hostname}" resolved to an invalid IP address`);
		}
		const { address, family } = entry;
		if ((family !== 4 && family !== 6) || isIP(address) !== family) {
			throw codedError('WEB_PROVIDER_ERROR', `hostname "${hostname}" resolved to an invalid IP address`);
		}
		if (!matchesAnyCidr(address, nets)) {
			throw codedError(
				'WEB_BLOCKED_URL',
				`URL hostname "${hostname}" resolves to a non-public IP address`,
			);
		}
	}
}
