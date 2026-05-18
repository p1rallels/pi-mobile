export function parseCompactCommand(text) {
	const trimmed = String(text || "").trim();
	if (trimmed === "/compact") return "";
	if (trimmed.startsWith("/compact ")) return trimmed.slice(9).trim();
	return null;
}

export function parseQueueCommand(text) {
	const trimmed = String(text || "").trim();
	if (trimmed === "/queue") return "";
	if (trimmed.startsWith("/queue ")) return trimmed.slice(7).trim();
	return null;
}
