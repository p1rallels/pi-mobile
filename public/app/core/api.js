async function handleJsonResponse(res) {
	const body = await res.json().catch(() => ({}));
	if (res.ok) return body;
	const message = body.error || `${res.status} ${res.statusText}`;
	if (
		res.status === 401 &&
		typeof message === "string" &&
		message.toLowerCase().includes("face id")
	) {
		window.dispatchEvent(new CustomEvent("pi-web-faceid-required", { detail: { message } }));
	}
	throw new Error(message);
}

function normalizeBaseUrl(baseUrl) {
	return new URL(baseUrl || window.location.origin, window.location.href).origin;
}

export function createApi({ baseUrl = window.location.origin } = {}) {
	let currentBaseUrl = normalizeBaseUrl(baseUrl);

	function headers() {
		return { "content-type": "application/json" };
	}

	function resolveUrl(path) {
		return new URL(path, currentBaseUrl).toString();
	}

	function setBaseUrl(nextBaseUrl) {
		currentBaseUrl = normalizeBaseUrl(nextBaseUrl);
	}

	function getBaseUrl() {
		return currentBaseUrl;
	}

	async function getJson(path) {
		const res = await fetch(resolveUrl(path), { headers: headers(), credentials: "include" });
		return handleJsonResponse(res);
	}

	async function postJson(path, payload) {
		const res = await fetch(resolveUrl(path), {
			method: "POST",
			credentials: "include",
			headers: headers(),
			body: JSON.stringify(payload),
		});
		return handleJsonResponse(res);
	}

	function eventSource(path) {
		return new EventSource(resolveUrl(path), { withCredentials: true });
	}

	return { headers, getJson, postJson, eventSource, getBaseUrl, setBaseUrl, resolveUrl };
}
