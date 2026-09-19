/**
 * fake-ip fetch provider for DSH.
 *
 * Local DNS in fake-ip mode (Clash, sing-box) answers every external hostname
 * with an address from one reserved range. The upstream fetch guard rejects
 * those as non-public, so `web_fetch` fails on every legitimate site. This
 * plugin registers a replacement provider that tries the real guard first and
 * only falls back to a resolver which additionally accepts the operator's
 * configured fake-ip range.
 *
 * The guard is narrowed, never removed: loopback, LAN, link-local and cloud
 * metadata destinations stay blocked on both paths. (Configuring an IPv6
 * allowlist entry would weaken this — upstream's RFC 6052 re-check does not
 * survive an injected resolver. See the README; IPv4 entries are all that is
 * needed for a fake-ip setup.)
 *
 * Registered provider id is upstream's `http`, not a new one, so the `web`
 * row's `fetchProvider` config stays exactly as `dsh-base` ships it. The row
 * that would otherwise register the same id is disabled by this package's own
 * patch file, so the two can never race for the id.
 */
import z from '@deepseek-ai/schemastery';
import {
	Config as UpstreamConfig,
	HttpFetchProvider,
	LOCAL_FETCH_PROVIDER_ID,
	apply as upstreamApply,
} from '@deepseek-ai/dsh-web-fetch-http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
	DEFAULT_ALLOWED_CIDRS,
	assertResolvableAddresses,
	parseAllowedCidrs,
	stripBrackets,
} from './policy.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'fakeip-fetch';

/** Needs the web seam to register the provider. */
export const inject = ['web'];

/**
 * Upstream's limits, plus the fake-ip allowlist.
 *
 * Built by spreading upstream's schema so the transport limits keep tracking
 * upstream defaults instead of being copied into this package.
 */
export const Config = z.object({
	...UpstreamConfig.dict,
	allowedCidrs: z.array(z.string()).default(DEFAULT_ALLOWED_CIDRS),
});

/**
 * Race a non-cancellable OS lookup without letting it delay cancellation.
 *
 * `dns.lookup` cannot be cancelled, so the promise is left to settle unused; it
 * only stops the caller from waiting. Upstream does the same for the strict
 * path, and without it `timeoutMs` could not bound DNS on this path either.
 *
 * @param promise - the in-flight lookup.
 * @param signal - the caller's abort signal.
 * @returns the lookup result, or a rejection as soon as the signal aborts.
 */
function raceWithSignal(promise, signal) {
	if (signal?.aborted) {
		return Promise.reject(new Error('web fetch aborted during hostname resolution', { cause: signal.reason }));
	}
	return new Promise((resolve, reject) => {
		const onAbort = () =>
			reject(new Error('web fetch aborted during hostname resolution', { cause: signal.reason }));
		signal?.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
	});
}

/**
 * Build the fallback resolver.
 *
 * Resolution is all-or-nothing on the complete answer set, matching the
 * upstream guard: a hostname that answers with both a fake-ip address and a
 * real private one is refused, so a record set cannot smuggle a LAN
 * destination past the exemption.
 *
 * The signature is upstream's `HttpFetchResolver` — `(hostname, signal)` — and
 * the signal is honoured, so a caller abort or the configured `timeoutMs`
 * bounds the DNS wait instead of only taking effect after it returns.
 *
 * @param nets - parsed allowlist entries from {@link parseAllowedCidrs}.
 * @param lookupFn - DNS lookup, injectable for tests.
 * @returns an `HttpFetchResolver`-shaped function.
 */
export function createResolver(nets, lookupFn = lookup) {
	return async (hostname, signal) => {
		const unbracketed = stripBrackets(hostname);
		const literalFamily = isIP(unbracketed);
		let rows;
		if (literalFamily !== 0) {
			rows = [{ address: unbracketed, family: literalFamily }];
		} else {
			// Check before issuing the lookup, so an already-cancelled request
			// does not start DNS work it will only discard.
			if (signal?.aborted) {
				throw new Error('web fetch aborted during hostname resolution', { cause: signal.reason });
			}
			rows = await raceWithSignal(lookupFn(unbracketed, { all: true, order: 'verbatim' }), signal);
		}
		assertResolvableAddresses(hostname, rows, nets);
		return rows.map((row) => ({ address: row.address, family: row.family }));
	};
}

/**
 * A fetch provider that falls back to the fake-ip allowlist.
 *
 * Two upstream providers back this: `strict` with the untouched guard, and
 * `relaxed` with the widened resolver. The strict one is tried first, so the
 * exemption only ever applies to a request the real guard actually refused.
 */
export class FakeIpFetchProvider {
	/** Upstream's own provider id, so the `web` row needs no config change. */
	id = LOCAL_FETCH_PROVIDER_ID;

	#strict;
	#relaxed;

	/**
	 * @param limits - upstream transport limits.
	 * @param allowedCidrs - fake-ip ranges to exempt; validated here, so a bad
	 * entry fails at load time rather than on the first fetch.
	 */
	constructor(limits, allowedCidrs) {
		const nets = parseAllowedCidrs(allowedCidrs);
		this.#strict = new HttpFetchProvider(limits);
		this.#relaxed = new HttpFetchProvider(limits, createResolver(nets));
	}

	/** Anonymous public fetcher, always usable — same answer as upstream. */
	available() {
		return this.#strict.available();
	}

	/**
	 * Fetch through the real guard, retrying through the fake-ip allowlist only
	 * when that guard rejected the destination.
	 *
	 * The original strict error is rethrown when the fallback also fails, so a
	 * refused request keeps reporting the guard's own diagnosis.
	 */
	async fetch(request, signal) {
		try {
			return await this.#strict.fetch(request, signal);
		} catch (error) {
			if (error?.code !== 'WEB_BLOCKED_URL') throw error;
			try {
				return await this.#relaxed.fetch(request, signal);
			} catch {
				throw error;
			}
		}
	}
}

/**
 * Register the provider with the web seam.
 *
 * The limits are validated by running upstream's own `apply` against a throwaway
 * seam and keeping only the provider it builds for us to discard. This package's
 * patch disables the upstream `web-fetch-http` row — the row whose `apply` would
 * otherwise do that validation — so without this the transport limits would go
 * unchecked. That is not cosmetic: Node coerces a timer delay above 2^31-1 ms to
 * 1 ms, so an unchecked `timeoutMs` silently makes every fetch time out
 * immediately. Delegating to upstream keeps the rules (and their error text) in
 * upstream's hands instead of copying four assertions that would drift.
 */
export function apply(ctx, config) {
	let upstream;
	upstreamApply(
		{ web: { registerFetchProvider(provider) { upstream = provider; } } },
		config,
	);
	const { limits } = upstream;
	ctx.web.registerFetchProvider(new FakeIpFetchProvider(limits, config.allowedCidrs));
}
