import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { EMPTY_LIVE_SNAPSHOT, reduceLiveSnapshot, type LiveSnapshot } from "../src/live-snapshot.ts";

type AssistantMessage = Extract<Extract<AgentSessionEvent, { type: "message_update" }>["message"], { role: "assistant" }>;

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason, timestamp: 1 };
}

function reduceAll(events: AgentSessionEvent[], from: LiveSnapshot = EMPTY_LIVE_SNAPSHOT): LiveSnapshot {
	return events.reduce(reduceLiveSnapshot, from);
}

describe("live snapshot", () => {
	test("tracks the streaming assistant message until it is persisted", () => {
		const partial = assistant([{ type: "text", text: "Hel" }]);
		const streaming = reduceAll([
			{ type: "agent_start" },
			{ type: "message_start", message: assistant([]) },
			{ type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial } },
		]);
		expect(streaming.streamingMessage).toBe(partial);

		const ended = reduceLiveSnapshot(streaming, { type: "message_end", message: assistant([{ type: "text", text: "Hello" }]) });
		expect(ended.streamingMessage).toBeNull();
	});

	test("ignores user messages", () => {
		const state = reduceAll([{ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } }]);
		expect(state).toBe(EMPTY_LIVE_SNAPSHOT);
	});

	test("keeps running and finished tools until their result message lands", () => {
		const running = reduceAll([
			{ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
			{ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: { command: "ls" }, partialResult: { content: [{ type: "text", text: "a" }] } },
			{ type: "tool_execution_start", toolCallId: "call_2", toolName: "read", args: { path: "x" } },
			{ type: "tool_execution_start", toolCallId: "nested_1", toolName: "grep", args: {}, parentToolCallId: "call_1" },
		]);
		expect(running.tools.map((tool) => [tool.toolCallId, tool.done])).toEqual([
			["call_1", false],
			["call_2", false],
			["nested_1", false],
		]);
		expect(running.tools[0]?.partialResult).toEqual({ content: [{ type: "text", text: "a" }] });
		expect(running.tools[2]?.parentToolCallId).toBe("call_1");

		const finished = reduceLiveSnapshot(running, {
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "a\nb" }] },
			isError: false,
			durationMs: 12,
		});
		expect(finished.tools[0]).toEqual({
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: undefined,
			result: { content: [{ type: "text", text: "a\nb" }] },
			isError: false,
			durationMs: 12,
			done: true,
		});

		const persisted = reduceLiveSnapshot(finished, {
			type: "message_end",
			message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [], isError: false, timestamp: 2 },
		});
		expect(persisted.tools.map((tool) => tool.toolCallId)).toEqual(["call_2"]);
	});

	test("tracks retry and compaction status", () => {
		const retrying = reduceAll([
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529" },
			{ type: "compaction_start", reason: "threshold" },
		]);
		expect(retrying.retry).toEqual({ attempt: 1, maxAttempts: 3 });
		expect(retrying.compaction).toEqual({ reason: "threshold" });

		const done = reduceAll(
			[
				{ type: "auto_retry_end", success: true, attempt: 1 },
				{ type: "compaction_end", reason: "threshold", result: undefined, aborted: true, willRetry: false },
			],
			retrying,
		);
		expect(done.retry).toBeNull();
		expect(done.compaction).toBeNull();
	});

	test("clears an interrupted run on agent_settled", () => {
		const state = reduceAll([
			{ type: "message_start", message: assistant([], "aborted") },
			{ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: {} },
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529" },
			{ type: "compaction_start", reason: "manual" },
			{ type: "agent_settled", aborted: true },
		]);
		expect(state).toEqual({ ...EMPTY_LIVE_SNAPSHOT, compaction: { reason: "manual" } });
	});
});
