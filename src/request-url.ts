/**
 * A request's URL as the server takes it, or null for a bad request: one that doesn't parse (a Host with its port out
 * of range) or whose path has an empty segment. The routers skip empty segments while the Face ID gate reads the path
 * as it is, so `//api/...` (or `/\api/...`, which URL parsing turns into it) would reach a handler past its gate. The
 * app never builds such a path.
 */
export function parseRequestUrl(raw: string): URL | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	return url.pathname.includes("//") ? null : url;
}
