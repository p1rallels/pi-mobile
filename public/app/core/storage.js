function safeLocalStorageRemove(key) {
	try {
		localStorage.removeItem(key);
	} catch {
		// ignore (private mode / restricted storage)
	}
}

export function readBootstrapToken() {
	const url = new URL(window.location.href);
	const qp = url.searchParams.get("token");
	return qp && qp.trim().length > 0 ? qp.trim() : null;
}

export function clearBootstrapToken() {
	const key = "piWebToken";
	safeLocalStorageRemove(key);
	const url = new URL(window.location.href);
	if (url.searchParams.has("token")) {
		url.searchParams.delete("token");
		window.history.replaceState(null, "", url.toString());
	}
}
