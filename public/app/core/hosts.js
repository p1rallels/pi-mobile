// Hosts and the per-origin browser session, shared by the phone shell and the canvas.

/** @param {unknown} hostname */
export function isLoopbackBrowserHost(hostname) {
	const normalized = String(hostname || "").trim().toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized.startsWith("127.")
	);
}

/** @param {{ url: string }} host */
export function hostOrigin(host) {
	return new URL(host.url, window.location.href).origin;
}

/** @param {any[]} rawHosts */
export function mergeHosts(rawHosts) {
	const byOrigin = new Map();
	for (const host of rawHosts) {
		if (!host || typeof host !== "object" || host.enabled === false || typeof host.url !== "string") continue;
		try {
			byOrigin.set(hostOrigin(host), { ...host, url: hostOrigin(host) });
		} catch {
			continue;
		}
	}
	return [...byOrigin.values()].sort((a, b) => String(a.label || a.id || a.url).localeCompare(String(b.label || b.id || b.url)));
}

/** The host serving this page, before /api/hosts says more. */
export function pageHost() {
	return { id: "current", label: window.location.hostname || "current", url: window.location.origin, enabled: true };
}

/**
 * One browser client id per origin (POST /api/client), cached across host switches.
 * @param {{ getBaseUrl: () => string, postJson: (path: string, body: unknown) => Promise<any> }} api
 */
export function createClientSessions(api) {
	const byOrigin = new Map();
	/** @type {string | null} */
	let clientId = null;

	async function ensure() {
		const origin = api.getBaseUrl();
		const cached = byOrigin.get(origin);
		if (cached) {
			clientId = cached;
			return cached;
		}
		const clientSession = await api.postJson("/api/client", {});
		if (!clientSession || typeof clientSession.clientId !== "string" || clientSession.clientId.length === 0) {
			throw new Error("Failed to establish browser session.");
		}
		byOrigin.set(origin, clientSession.clientId);
		clientId = clientSession.clientId;
		return clientSession.clientId;
	}

	async function refresh() {
		byOrigin.delete(api.getBaseUrl());
		return ensure();
	}

	return { ensure, refresh, current: () => clientId };
}

/**
 * @param {{ getBaseUrl: () => string, getJson: (path: string) => Promise<any> }} api @param {{ url: string }} activeHost
 */
export async function loadHostList(api, activeHost) {
	const data = await api.getJson("/api/hosts").catch(() => ({ hosts: [] }));
	const hosts = mergeHosts(Array.isArray(data.hosts) ? data.hosts : []);
	return hosts.some((host) => hostOrigin(host) === api.getBaseUrl()) ? hosts : mergeHosts([...hosts, activeHost]);
}
