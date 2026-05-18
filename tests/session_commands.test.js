import { describe, expect, test } from "bun:test";
import { parseCompactCommand, parseQueueCommand } from "../public/app/session/commands.js";

describe("session commands", () => {
	test("parses compact commands like pi", () => {
		expect(parseCompactCommand("/compact")).toBe("");
		expect(parseCompactCommand("  /compact   focus on security  ")).toBe("focus on security");
	});

	test("ignores non-compact prompts", () => {
		expect(parseCompactCommand("please /compact this text")).toBeNull();
		expect(parseCompactCommand("/compactness")).toBeNull();
		expect(parseCompactCommand("/COMPACT keep test context")).toBeNull();
		expect(parseCompactCommand("/compact\nkeep test context")).toBeNull();
		expect(parseCompactCommand("")).toBeNull();
	});

	test("parses queue commands", () => {
		expect(parseQueueCommand("/queue later please")).toBe("later please");
		expect(parseQueueCommand("  /queue   later please  ")).toBe("later please");
		expect(parseQueueCommand("/queue")).toBe("");
	});

	test("ignores non-queue prompts", () => {
		expect(parseQueueCommand("please /queue this text")).toBeNull();
		expect(parseQueueCommand("/queueing later")).toBeNull();
		expect(parseQueueCommand("/QUEUE later")).toBeNull();
		expect(parseQueueCommand("/queue\nlater")).toBeNull();
	});
});
