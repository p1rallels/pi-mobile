import { safeRandomUUID } from "./uuid.js";

function safeLocalStorageGet(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeLocalStorageSet(key, value) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// ignore (private mode / restricted storage)
	}
}

export function getOrCreateClientId() {
	const key = "piWebClientId";
	let id = safeLocalStorageGet(key);
	if (!id) {
		id = safeRandomUUID();
		safeLocalStorageSet(key, id);
	}
	return id;
}

export function getToken() {
	const key = "piWebToken";
	const url = new URL(window.location.href);
	const qp = url.searchParams.get("token");
	if (qp && qp.trim().length > 0) {
		const trimmed = qp.trim();
		safeLocalStorageSet(key, trimmed);
		// Only strip the token from the URL once we know it persisted.
		// Some mobile/in-app browsers restrict storage; keeping the token in the URL is
		// better than silently breaking reloads.
		if (safeLocalStorageGet(key) === trimmed) {
			url.searchParams.delete("token");
			window.history.replaceState(null, "", url.toString());
		}
		return trimmed;
	}
	return safeLocalStorageGet(key);
}

