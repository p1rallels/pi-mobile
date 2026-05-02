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

export function createApi() {
	function headers() {
		return { "content-type": "application/json" };
	}

	async function getJson(path) {
		const res = await fetch(path, { headers: headers(), credentials: "same-origin" });
		return handleJsonResponse(res);
	}

	async function postJson(path, payload) {
		const res = await fetch(path, {
			method: "POST",
			credentials: "same-origin",
			headers: headers(),
			body: JSON.stringify(payload),
		});
		return handleJsonResponse(res);
	}

	return { headers, getJson, postJson };
}
