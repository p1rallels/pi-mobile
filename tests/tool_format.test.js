import { describe, expect, test } from "bun:test";
import { codemodeSummary, displayToolName, formatDuration, toolCallToText, toolOutputText } from "../public/app/core/tool_format.js";

const text = (value) => [{ type: "text", text: value }];
const WORKER = { id: "01a152d4-d2c3-751d-ab2f-1d14f1974871", name: "worker" };

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

	test("shows msg_send as the message going out, and what came of it", () => {
		expect(toolCallToText("msg_send", { to: "worker", message: "rebase on main\nthen push" })).toBe("→ worker: rebase on main\nthen push");
		expect(toolCallToText("msg_send", { to: "parent", message: "done?", reply_to: "0mgqk3x2p-a1b2c3", delivery: "follow_up", wait_seconds: 60 })).toBe(
			"→ parent (re 0mgqk3x2p-a1b2c3, follow-up): done?",
		);
		expect(toolCallToText("msg_send", {})).toBe("msg_send");

		const message = { id: "0mgqk3x2p-a1b2c3", from: { id: "me" }, text: "rebase" };
		const sent = { content: text(`Sent 0mgqk3x2p-a1b2c3 to worker (${WORKER.id}): idle; it wakes up to handle the message.`), details: { message, to: WORKER.id, live: true } };
		expect(toolOutputText("msg_send", sent)).toBe("sent · idle; it wakes up to handle the message");
		expect(toolOutputText("msg_send", { ...sent, content: text("Sent it.") })).toBe("sent");
		expect(toolOutputText("msg_send", sent, { partial: true })).toBe("sent · waiting for a reply…");
		const replied = { content: text("Sent …\nworker replied (0mgqk3x3a-ffffff):\nok, pushed"), details: { message, reply: { id: "0mgqk3x3a-ffffff", from: WORKER, text: "ok, pushed" }, outcome: "message" } };
		expect(toolOutputText("msg_send", replied)).toBe("↩ worker: ok, pushed");
		expect(toolOutputText("msg_send", { content: text("No reply"), details: { message, outcome: "timeout" } })).toBe("no reply");
		expect(toolOutputText("msg_send", { content: text("Stopped"), details: { message, outcome: "aborted" } })).toBe("stopped waiting, no reply");
		const fanOut = [
			`Sent 0mgqk3x2p-a1b2c3 to worker (${WORKER.id}): busy; it sees the message at its next step.`,
			"Sent 0mgqk3x2p-d4e5f6 to docs (01a152d4-0000-7000-8000-00000000000d): idle; it wakes up to handle the message.",
		].join("\n");
		expect(toolOutputText("msg_send", { content: text(fanOut), details: { message, messages: [message, message], to: "children", recipients: [WORKER.id, "d"] } })).toBe(
			"sent to 2\nworker: busy; it sees the message at its next step\ndocs: idle; it wakes up to handle the message",
		);
	});

	test("keeps msg's own words when a result is an error or lacks what it needs", () => {
		expect(toolOutputText("msg_send", { content: text("unknown recipient. msg_list shows who's around."), details: {} }, { isError: true })).toBe(
			"unknown recipient. msg_list shows who's around.",
		);
		expect(toolOutputText("msg_send", { content: text("Sent somewhere") })).toBe("Sent somewhere");
		expect(toolOutputText("msg_send", { content: text("Sent somewhere"), details: { odd: true } })).toBe("Sent somewhere");
		expect(toolOutputText("msg_send", "raw")).toBe("raw");
	});

	test("shows msg_wait, msg_list and relay compactly", () => {
		expect(toolCallToText("msg_wait", { from: "children", timeout_seconds: 600 })).toBe("msg_wait ← children · up to 10m");
		expect(toolCallToText("msg_wait", {})).toBe("msg_wait ← anyone");
		const got = { content: text("<msg …>"), details: { from: WORKER.id, message: { from: WORKER, text: "all green", kind: "ended" }, outcome: "message" } };
		expect(toolOutputText("msg_wait", got)).toBe("worker (finished): all green");
		expect(toolOutputText("msg_wait", { content: text("No message from anyone within 300s."), details: { outcome: "timeout" } })).toBe("no message");
		expect(toolOutputText("msg_wait", { content: text("Waiting up to 300s…"), details: {} }, { partial: true })).toBe("Waiting up to 300s…");

		expect(toolCallToText("msg_list", {})).toBe("msg_list");
		expect(toolCallToText("msg_list", { all: true, set_name: "lead" })).toBe("msg_list · all · as lead");
		expect(toolOutputText("msg_list", { content: text("you: lead\nworker · 01a152d4 · print · busy"), details: { live: 1 } })).toBe("you: lead\nworker · 01a152d4 · print · busy");

		expect(toolCallToText("relay", { note: "tests pass, docs left" })).toBe("relay: tests pass, docs left");
		expect(toolCallToText("relay", { note: "shipped", done: true })).toBe("relay (done): shipped");
		expect(toolCallToText("relay", {})).toBe("relay");
		expect(toolOutputText("relay", { content: text("reset #2 queued: it happens as soon as this turn's tool calls finish"), details: { outcome: "queued", note: "x", n: 2 } })).toBe(
			"reset #2 queued for the end of this turn",
		);
		expect(toolOutputText("relay", { content: text("loop finished, no reset."), details: { outcome: "done" } })).toBe("done, no reset");
		expect(toolOutputText("relay", { content: text("relay is capped at 20 resets."), details: { outcome: "capped" } })).toBe("relay is capped at 20 resets.");
	});

	test("formats durations compactly", () => {
		expect(formatDuration(42)).toBe("42ms");
		expect(formatDuration(1530)).toBe("1.5s");
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(125_000)).toBe("2m 5s");
		expect(formatDuration(undefined)).toBe("");
	});
});
