import { shellQuote } from "../core/shell_quote.js";

export function computeCliCommand(state) {
	if (!state || !state.sessionFile) return null;
	const cwd = state.cwd || "";
	const file = state.sessionFile;
	return `cd ${shellQuote(cwd)} && pi --session ${shellQuote(file)}`;
}
