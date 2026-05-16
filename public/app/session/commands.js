export function parseCompactCommand(text) {
	const match = String(text || "")
		.trim()
		.match(/^\/compact(?:\s+([\s\S]*))?$/i);
	return match ? (match[1] || "").trim() : null;
}
