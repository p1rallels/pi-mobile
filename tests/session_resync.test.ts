import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionClient } from "../src/session-runtime.ts";
import type { SseEvent } from "../src/types.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor, type SseFrame } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

const LONG_ANSWER = Array.from({ length: 40 }, (_, index) => `word${String(index)}`).join(" ");

function viewer(connectionId: string): { client: SessionClient; frames: SseFrame[] } {
	const frames: SseFrame[] = [];
	return { frames, client: { connectionId, clientId: connectionId, send: (event, id) => frames.push({ event, id }), close() {} } };
}

function textDeltas(frames: SseFrame[]): string {
	return frames
		.flatMap(({ event }) =>
			event.type === "agent_event" && event.event.type === "message_update" && event.event.assistantMessageEvent.type === "text_delta"
				? [event.event.assistantMessageEvent.delta]
				: [],
		)
		.join("");
}

function messageEnds(frames: SseFrame[]): Array<{ role: string; entryId: string | undefined; id: string | undefined }> {
	return frames.flatMap(({ event, id }) =>
		event.type === "agent_event" && event.event.type === "message_end" ? [{ role: event.event.message.role, entryId: event.entryId, id }] : [],
	);
}

function partialText(event: SseEvent): string {
	const message = event.type === "init" ? event.live.streamingMessage : null;
	const content = message?.role === "assistant" ? message.content : null;
	return Array.isArray(content) ? content.map((block) => (block.type === "text" ? block.text : "")).join("") : "";
}

describe("session resync", () => {
	test("announces every persisted message with its entry id as the frame cursor", async () => {
		const { runtime, sessionId, clientId, events, frames } = await startFauxSession([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "call_echo" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "run it" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));

		const persisted = runtime.getSessionState(sessionId).messages.map((message) => [message.role, message.entryId]);
		const announced = messageEnds(frames);
		expect(announced.filter(({ role }) => role !== "system").map(({ role, entryId }) => [role, entryId])).toEqual(persisted);
		expect(announced.every(({ entryId, id }) => entryId !== undefined && id === entryId)).toBe(true);
		expect(frames.filter(({ id }) => id !== undefined).length).toBe(announced.length);

		await runtime.release(sessionId, { clientId });
	});

	test("announces a compaction with the entry id of its summary", async () => {
		const { runtime, sessionId, clientId, events, frames } = await startFauxSession(
			[fauxAssistantMessage("first answer"), fauxAssistantMessage("the summary")],
			{ settings: { compaction: { keepRecentTokens: 1 } } },
		);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hello" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		await runtime.handleCommand(sessionId, { type: "compact", clientId });
		await waitFor(() => agentEventTypes(events).includes("compaction_end"));

		const frame = frames.find(({ event }) => event.type === "agent_event" && event.event.type === "compaction_end");
		const summary = runtime.getSessionState(sessionId).messages.find((message) => message.role === "compactionSummary");
		expect(summary?.entryId).toBeDefined();
		expect(frame?.event.type === "agent_event" ? frame.event.entryId : undefined).toBe(summary?.entryId);
		expect(frame?.id).toBe(summary?.entryId);

		await runtime.release(sessionId, { clientId });
	});

	test("shows a viewer that joins mid-stream the partial message exactly once", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([fauxAssistantMessage(LONG_ANSWER)], {
			faux: { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
		});
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "talk" });
		await waitFor(() => textDeltas(events.map((event) => ({ event }))).length > 20);

		const late = viewer("late");
		const { init, cursor } = runtime.connectClient(sessionId, late.client);
		expect(init.transcript.mode).toBe("replace");
		expect(init.transcript.messages.map((message) => message.role)).toEqual(["user"]);
		expect(cursor).toBe(init.transcript.messages[0]?.entryId);
		const partial = partialText(init);
		expect(partial.length).toBeGreaterThan(0);
		expect(partial.length).toBeLessThan(LONG_ANSWER.length);

		await waitFor(() => agentEventTypes(late.frames.map(({ event }) => event)).includes("agent_settled"));
		expect(partial + textDeltas(late.frames)).toBe(LONG_ANSWER);
		expect(messageEnds(late.frames).map(({ role }) => role)).toEqual(["assistant"]);

		await runtime.release(sessionId, { clientId });
	});

	test("shows a viewer that joins during a tool call the call as running", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.4; echo slow" }, { id: "call_slow" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "wait" });
		await waitFor(() => agentEventTypes(events).includes("tool_execution_start"));

		const late = viewer("late");
		const { init } = runtime.connectClient(sessionId, late.client);
		expect(init.live.streamingMessage).toBeNull();
		expect(init.live.tools.map((tool) => [tool.toolCallId, tool.toolName, tool.done])).toEqual([["call_slow", "bash", false]]);
		expect(init.transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

		await waitFor(() => agentEventTypes(late.frames.map(({ event }) => event)).includes("agent_settled"));
		expect(agentEventTypes(late.frames.map(({ event }) => event))).toContain("tool_execution_end");
		expect(runtime.connectClient(sessionId, viewer("after").client).init.live.tools).toEqual([]);

		await runtime.release(sessionId, { clientId });
	});

	test("sends a returning viewer only the entries after its cursor", async () => {
		const { runtime, sessionId, clientId, events, frames, faux } = await startFauxSession([fauxAssistantMessage("first")]);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "one" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		const cursor = frames.findLast(({ id }) => id !== undefined)?.id;
		expect(cursor).toBeDefined();
		runtime.removeClient(sessionId, "connection-1");

		faux.appendResponses([fauxAssistantMessage("second")]);
		const before = runtime.connectClient(sessionId, viewer("driver").client);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "two" });
		await waitFor(() => runtime.getSessionState(sessionId).messages.length === 4 && !runtime.getSessionState(sessionId).isStreaming);

		const back = runtime.connectClient(sessionId, viewer("back").client, cursor);
		expect(back.init.transcript.mode).toBe("append");
		expect(back.init.transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(back.init.cursor).not.toBe(before.init.cursor);
		expect(runtime.connectClient(sessionId, viewer("unknown").client, "nope0000").init.transcript.mode).toBe("replace");

		await runtime.release(sessionId, { clientId });
	});

	test("gives a windowed viewer only the tail, and a fresh tail when it missed more than that", async () => {
		const { runtime, sessionId, clientId, events, frames } = await startFauxSession([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
		]);
		const settled = () => agentEventTypes(events).filter((type) => type === "agent_settled").length;
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "first" });
		await waitFor(() => settled() === 1);
		const cursor = frames.findLast(({ id }) => id !== undefined)?.id;
		for (const [index, text] of ["second", "third"].entries()) {
			await runtime.handleCommand(sessionId, { type: "prompt", clientId, text });
			await waitFor(() => settled() === index + 2);
		}

		const tail = runtime.connectClient(sessionId, viewer("tile").client, undefined, { limit: 2 }).init.transcript;
		expect(tail.mode).toBe("replace");
		expect(tail.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(tail.mode === "replace" && tail.hasOlder).toBe(true);
		expect(runtime.connectClient(sessionId, viewer("phone").client).init.transcript.messages).toHaveLength(6);

		const behind = runtime.connectClient(sessionId, viewer("back").client, cursor, { limit: 2 }).init.transcript;
		expect(behind.mode).toBe("replace");
		expect(behind.messages).toHaveLength(2);
		expect(runtime.connectClient(sessionId, viewer("back-wide").client, cursor, { limit: 10 }).init.transcript.mode).toBe("append");

		await runtime.release(sessionId, { clientId });
	});
});
