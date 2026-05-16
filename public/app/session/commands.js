export function parseCompactCommand(text) {
	const trimmed = String(text || "").trim();
	if (trimmed === "/compact") return "";
	if (trimmed.startsWith("/compact ")) return trimmed.slice(9).trim();
	return null;
}
