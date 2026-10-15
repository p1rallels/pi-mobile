import { describe, expect, test } from "bun:test";
import { isOpenTurn, turnOfEntries, turnOfEntry } from "../src/session-turn.ts";

const message = (role: string, extra: Record<string, unknown> = {}) => ({ type: "message", id: role, parentId: null, timestamp: "t", message: { role, ...extra } });

describe("session turn", () => {
	test("reads the turn from the last user, assistant or tool result message", () => {
		expect(turnOfEntry(message("user"))).toBe("thinking");
		expect(turnOfEntry(message("toolResult", { isError: true }))).toBe("thinking");
		expect(turnOfEntry(message("assistant", { stopReason: "toolUse" }))).toBe("running_tools");
		for (const stopReason of ["stop", "length", "aborted", "error", undefined]) {
			expect(turnOfEntry(message("assistant", { stopReason }))).toBe("done");
		}
	});

	test("other roles and entry types say nothing", () => {
		expect(turnOfEntry(message("bashExecution"))).toBeNull();
		expect(turnOfEntry(message("custom"))).toBeNull();
		expect(turnOfEntry(message("system"))).toBeNull();
		expect(turnOfEntry({ type: "custom_message", message: { role: "user" } })).toBeNull();
		expect(turnOfEntry({ type: "session_info", name: "x" })).toBeNull();
		expect(turnOfEntry(null)).toBeNull();
		expect(turnOfEntry("message")).toBeNull();
		expect(turnOfEntry({ type: "message", message: "user" })).toBeNull();
	});

	test("the last deciding entry wins and nothing reads done", () => {
		expect(turnOfEntries([])).toBe("done");
		expect(turnOfEntries([message("user"), message("assistant", { stopReason: "toolUse" }), message("bashExecution"), { type: "label" }])).toBe("running_tools");
		expect(turnOfEntries([message("user"), message("assistant", { stopReason: "stop" })])).toBe("done");
		expect(turnOfEntries([{ type: "label" }], "thinking")).toBe("thinking");
		expect(isOpenTurn("thinking")).toBe(true);
		expect(isOpenTurn("running_tools")).toBe(true);
		expect(isOpenTurn("done")).toBe(false);
	});
});
