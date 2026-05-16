import { describe, expect, test } from "bun:test";
import { parseCompactCommand } from "../public/app/session/commands.js";

describe("session commands", () => {
	test("parses compact commands", () => {
		expect(parseCompactCommand("/compact")).toBe("");
		expect(parseCompactCommand("  /compact   focus on security  ")).toBe("focus on security");
		expect(parseCompactCommand("/COMPACT\nkeep test context")).toBe("keep test context");
	});

	test("ignores non-compact prompts", () => {
		expect(parseCompactCommand("please /compact this text")).toBeNull();
		expect(parseCompactCommand("/compactness")).toBeNull();
		expect(parseCompactCommand("")).toBeNull();
	});
});
