export function safeStringify(value) {
	try {
		if (typeof value === "string") return value;
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

