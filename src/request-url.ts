/**
 * A request's URL as the server takes it, or null for a bad request: one that doesn't parse (a Host with its port out
 * of range), whose path has an empty segment, or whose host ends in a dot. The routers skip empty segments while the
 * Face ID gate reads the path as it is, so `//api/...` (or `/\api/...`, which URL parsing turns into it) would reach a
 * handler past its gate. `host.` is `host` to the Host check but another RP to Face ID, with passkeys and a first use
 * of its own, so it's refused here and every consumer of the hostname sees one spelling. The app builds neither.
 */
export function parseRequestUrl(raw: string): URL | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	return url.pathname.includes("//") || url.hostname.endsWith(".") ? null : url;
}

const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"] as const;

/**
 * Whether a proxy handed the request on. Through the proxy every request comes from 127.0.0.1 too, so a loopback Host
 * can't tell a process on this host from a browser elsewhere; Caddy's reverse_proxy always sets X-Forwarded-For (and
 * pi-web's Caddyfile X-Forwarded-Proto), a process on this host sends none of these unless it means to pass as proxied.
 */
export function cameThroughProxy(headers: Headers): boolean {
	return FORWARDING_HEADERS.some((name) => headers.has(name));
}
