import { describe, expect, test } from "bun:test";
import { parseCompactCommand } from "../public/app/session/commands.js";

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
});
