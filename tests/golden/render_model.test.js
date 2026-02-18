import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { toolCallToText, toolPreviewLines, toolResultToText } from "../../public/app/core/tool_format.js";

function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

function computeToolView(toolName, fullText, expanded) {
	const text = String(fullText ?? "");
	const previewLines = toolPreviewLines(toolName);
	const lines = text.split("\n");
	const truncated = lines.length > previewLines;
	if (!truncated) {
		return { truncated: false, previewLines, expanded: Boolean(expanded), viewText: text };
	}

	const isBash = toolName === "bash";
	const remaining = Math.max(0, lines.length - previewLines);
	const preview = isBash ? lines.slice(-previewLines).join("\n") : lines.slice(0, previewLines).join("\n");
	return {
		truncated: true,
		previewLines,
		expanded: Boolean(expanded),
		remaining,
		mode: isBash ? "tail" : "head",
		viewText: expanded ? text : preview,
	};
}

function keyForUserMessage(msg, text) {
	const ts = msg && typeof msg.timestamp === "number" ? msg.timestamp : null;
	if (ts !== null) return `u:${ts}:${text}`;
	return `u:${text}`;
}

function applySseEvents(events) {
	const blocks = [];
	let currentAssistantIndex = null;
	const toolById = new Map();
	const appendedUserMessageKeys = new Set();

	const ensureAssistant = () => {
		if (currentAssistantIndex !== null) return;
		blocks.push({ type: "assistant", thinking: "", text: "", notices: [] });
		currentAssistantIndex = blocks.length - 1;
	};

	const assistantIsEmpty = () => {
		if (currentAssistantIndex === null) return false;
		const a = blocks[currentAssistantIndex];
		return Boolean(a && a.type === "assistant" && a.thinking === "" && a.text === "");
	};

	const appendUser = (msg) => {
		const text = extractTextContent(msg.content);
		if (!text) return;
		const key = keyForUserMessage(msg, text);
		if (appendedUserMessageKeys.has(key)) return;
		appendedUserMessageKeys.add(key);

		const block = { type: "user", text };
		if (assistantIsEmpty()) {
			blocks.splice(currentAssistantIndex, 0, block);
			currentAssistantIndex += 1;
		} else {
			blocks.push(block);
		}
	};

	for (const ev of events) {
		if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue;

		if (ev.type === "init") {
			blocks.length = 0;
			currentAssistantIndex = null;
			toolById.clear();
			appendedUserMessageKeys.clear();
			continue;
		}

		if (ev.type !== "agent_event" || !ev.event || typeof ev.event.type !== "string") continue;
		const e = ev.event;

		if (e.type === "turn_start") {
			ensureAssistant();
			continue;
		}

		if (e.type === "message_start") {
			if (e.message && e.message.role === "user") appendUser(e.message);
			if (e.message && e.message.role === "assistant") ensureAssistant();
			continue;
		}

		if (e.type === "message_update") {
			const u = e.assistantMessageEvent;
			if (!u || typeof u.type !== "string") continue;
			if (u.type === "thinking_delta" || u.type === "reasoning_delta") {
				ensureAssistant();
				blocks[currentAssistantIndex].thinking += u.delta || "";
			} else if (u.type === "text_delta") {
				ensureAssistant();
				blocks[currentAssistantIndex].text += u.delta || "";
			}
			continue;
		}

		if (e.type === "message_end") {
			const msg = e.message;
			if (msg && msg.role === "user") appendUser(msg);
			if (msg && msg.role === "assistant") {
				// Mirror UI: abort notice lives inside the assistant block if no tool calls.
				const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
				if ((stopReason === "aborted" || stopReason === "error") && currentAssistantIndex !== null) {
					const content = Array.isArray(msg.content) ? msg.content : [];
					const hasToolCalls = content.some((c) => c && typeof c === "object" && c.type === "toolCall");
					if (!hasToolCalls) {
						blocks[currentAssistantIndex].notices.push(stopReason === "aborted" ? "Operation aborted" : "Error");
					}
				}
				currentAssistantIndex = null;
			}
			continue;
		}

		if (e.type === "tool_execution_start") {
			ensureAssistant();
			const toolCallId = String(e.toolCallId);
			const toolName = String(e.toolName);
			const tool = {
				type: "tool",
				toolCallId,
				toolName,
				status: "pending",
				call: toolCallToText(toolName, e.args),
				fullText: "",
				view: computeToolView(toolName, "", false),
			};
			blocks.push(tool);
			toolById.set(toolCallId, tool);
			continue;
		}

		if (e.type === "tool_execution_update") {
			const tool = toolById.get(String(e.toolCallId));
			if (!tool) continue;
			tool.fullText = toolResultToText(e.partialResult);
			tool.view = computeToolView(tool.toolName, tool.fullText, false);
			continue;
		}

		if (e.type === "tool_execution_end") {
			const tool = toolById.get(String(e.toolCallId));
			if (!tool) continue;
			tool.status = e.isError ? "error" : "success";
			tool.fullText = toolResultToText(e.result);
			tool.view = computeToolView(tool.toolName, tool.fullText, false);
			continue;
		}
	}

	return blocks;
}

async function loadFixture(name) {
	const raw = await readFile(new URL(`../../public/fixtures/${name}.json`, import.meta.url), "utf8");
	return JSON.parse(raw);
}

describe("golden: render model", () => {
	test("basic", async () => {
		const events = await loadFixture("basic");
		expect(applySseEvents(events)).toMatchSnapshot();
	});

	test("tools", async () => {
		const events = await loadFixture("tools");
		expect(applySseEvents(events)).toMatchSnapshot();
	});

	test("tool_before_message", async () => {
		const events = await loadFixture("tool_before_message");
		expect(applySseEvents(events)).toMatchSnapshot();
	});

	test("abort", async () => {
		const events = await loadFixture("abort");
		expect(applySseEvents(events)).toMatchSnapshot();
	});
});

