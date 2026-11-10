/** What a request offers to tell its requester apart, for keying rate limits and per-requester caps. */
export interface RequesterSignals {
	/** fingerprint of the device certificate secure mode verified for this request, if it did */
	device: string | null;
	/** PI_WEB_TRUST_PROXY=1: requests arrive through a proxy that sets X-Forwarded-For */
	trustProxy: boolean;
	/** the X-Forwarded-For header as it arrived */
	forwardedFor: string | null;
	/** the TCP peer's address */
	peerAddress: string | null | undefined;
}

/**
 * The address the proxy itself added: the last X-Forwarded-For entry. Caddy's reverse_proxy replaces an incoming
 * X-Forwarded-For with the peer address unless the peer is in trusted_proxies, and then appends the peer to it, so
 * anything before the last entry is whatever the client sent.
 */
export function proxyAddedAddress(forwardedFor: string | null): string | null {
	return forwardedFor?.split(",").at(-1)?.trim() || null;
}

/** A requester's key: its verified device, else the address the trusted proxy saw, else the TCP peer. Never a header the client picks. */
export function requesterKey({ device, trustProxy, forwardedFor, peerAddress }: RequesterSignals): string {
	if (device) return `device:${device}`;
	const proxied = trustProxy ? proxyAddedAddress(forwardedFor) : null;
	if (proxied) return `ip:${proxied}`;
	return peerAddress ? `ip:${peerAddress}` : "__unknown__";
}
