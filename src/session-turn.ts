/**
 * Where a pi conversation's turn stands, read from its session file. pi appends whole entries when each
 * message ends (never token by token), so the last user, assistant or tool result message decides:
 * the same rule pfs uses before deleting a fork under an agent that's thinking.
 */
export type Turn = "thinking" | "running_tools" | "done";

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A user prompt or a tool's result means the model is about to answer; an assistant that called tools is waiting on them. */
export function turnOfMessage(role: unknown, stopReason: unknown): Turn | null {
	switch (role) {
		case "user":
		case "toolResult":
			return "thinking";
		case "assistant":
			return stopReason === "toolUse" ? "running_tools" : "done";
		default:
			return null;
	}
}

/** What one session entry says about the turn, or null when it says nothing (other roles and entry types). */
export function turnOfEntry(entry: unknown): Turn | null {
	const fields = record(entry);
	if (!fields || fields.type !== "message") return null;
	const message = record(fields.message);
	return message ? turnOfMessage(message.role, message.stopReason) : null;
}

export function isOpenTurn(turn: Turn): boolean {
	return turn !== "done";
}

/** The last deciding entry wins; a file without one reads done. */
export function turnOfEntries(entries: readonly unknown[], start: Turn = "done"): Turn {
	return entries.reduce<Turn>((turn, entry) => turnOfEntry(entry) ?? turn, start);
}
