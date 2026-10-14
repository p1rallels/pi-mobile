import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toWireEvent } from "../src/wire-events.ts";

type AssistantMessage = Extract<Extract<AgentSessionEvent, { type: "message_update" }>["message"], { role: "assistant" }>;

const usage = { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason: "stop", timestamp: 1 };
}

describe("wire events", () => {
	test("strips cumulative snapshots from text deltas", () => {
		const partial = assistant([{ type: "text", text: "Hello wor" }]);
		const event: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wor", partial },
		};

		const wire = toWireEvent(event);

		expect(wire).toEqual({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wor" } });
		expect(JSON.stringify(wire)).not.toContain("Hello");
	});

	test("names the tool call on toolcall_start", () => {
		const partial = assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }]);
		const event: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
		};

		expect(toWireEvent(event)).toEqual({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
		});
	});

	test("passes other events through untouched", () => {
		const event: AgentSessionEvent = { type: "agent_settled", aborted: false };
		expect(toWireEvent(event)).toBe(event);
	});
});
