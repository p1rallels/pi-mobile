import { describe, expect, test } from "bun:test";
import { codemodeSummary, displayToolName, formatDuration, toolCallToText } from "../public/app/core/tool_format.js";

describe("tool format", () => {
	test("names mcp tools by server and tool", () => {
		expect(displayToolName("mcp__docs__search")).toBe("docs › search");
		expect(displayToolName("mcp__dev-radius__find__deep")).toBe("dev-radius › find__deep");
		expect(displayToolName("bash")).toBe("bash");
		expect(toolCallToText("mcp__docs__search", { query: "x" })).toBe('docs › search {"query":"x"}');
		expect(toolCallToText("mcp__docs__list", {})).toBe("docs › list");
	});

	test("summarizes codemode scripts by their first statement", () => {
		const script = '// @options: {"timeout_ms": 1000}\n\nconst files = await tools.find({ pattern: "*.ts" });\nreturn files;';
		expect(codemodeSummary({ code: script })).toBe('const files = await tools.find({ pattern: "*.ts" });');
		expect(toolCallToText("codemode", { code: script })).toBe('codemode: const files = await tools.find({ pattern: "*.ts" });');
		expect(toolCallToText("codemode", {})).toBe("codemode");
	});

	test("formats durations compactly", () => {
		expect(formatDuration(42)).toBe("42ms");
		expect(formatDuration(1530)).toBe("1.5s");
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(125_000)).toBe("2m 5s");
		expect(formatDuration(undefined)).toBe("");
	});
});
