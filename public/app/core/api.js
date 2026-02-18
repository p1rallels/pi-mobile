export function createApi(token) {
	function headers() {
		const h = { "content-type": "application/json" };
		if (token) h.authorization = `Bearer ${token}`;
		return h;
	}

	async function getJson(path) {
		const res = await fetch(path, { headers: headers() });
		const body = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
		return body;
	}

	async function postJson(path, payload) {
		const res = await fetch(path, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(payload),
		});
		const body = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
		return body;
	}

	return { headers, getJson, postJson };
}

