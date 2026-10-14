import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TranscriptMessage } from "../src/transcript.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor, type FauxSession } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

function describeMessage(message: TranscriptMessage): string {
	if (message.role === "user") return `user:${typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")}`;
	if (message.role === "assistant") return `assistant:${message.content.map((block) => (block.type === "text" ? block.text : "")).join("")}`;
	return message.role;
}

async function promptAndSettle(session: FauxSession, text: string): Promise<void> {
	const settled = agentEventTypes(session.events).filter((type) => type === "agent_settled").length;
	await session.runtime.handleCommand(session.sessionId, { type: "prompt", clientId: session.clientId, text });
	await waitFor(() => agentEventTypes(session.events).filter((type) => type === "agent_settled").length > settled);
}

describe("transcript", () => {
	test("keeps history before a compaction and places the summary where it happened", async () => {
		const session = await startFauxSession(
			[fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("summary"), fauxAssistantMessage("turn prefix summary"), fauxAssistantMessage("three")],
			{ settings: { compaction: { keepRecentTokens: 1 } } },
		);
		const { runtime, sessionId, clientId, events } = session;

		await promptAndSettle(session, "first");
		await promptAndSettle(session, "second");
		await runtime.handleCommand(sessionId, { type: "compact", clientId });
		await waitFor(() => agentEventTypes(events).includes("compaction_end"));
		await promptAndSettle(session, "third");

		const state = runtime.getSessionState(sessionId);
		expect(state.messages.map(describeMessage)).toEqual([
			"user:first",
			"assistant:one",
			"user:second",
			"assistant:two",
			"compactionSummary",
			"user:third",
			"assistant:three",
		]);
		expect(state.hasOlderMessages).toBe(false);
		expect(new Set(state.messages.map((message) => message.entryId)).size).toBe(state.messages.length);
		expect(events.some((event) => event.type === "state_patch" && "messages" in event.patch)).toBe(false);

		await runtime.release(sessionId, { clientId });
	});

	test("pages older history by entry id", async () => {
		const session = await startFauxSession([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const { runtime, sessionId, clientId } = session;
		await promptAndSettle(session, "first");
		await promptAndSettle(session, "second");

		const latest = runtime.getTranscriptPage(sessionId, { limit: 2 });
		expect(latest.messages.map(describeMessage)).toEqual(["user:second", "assistant:two"]);
		expect(latest.hasOlder).toBe(true);

		const older = runtime.getTranscriptPage(sessionId, { before: latest.messages[0]!.entryId, limit: 2 });
		expect(older.messages.map(describeMessage)).toEqual(["user:first", "assistant:one"]);
		expect(older.hasOlder).toBe(false);

		expect(() => runtime.getTranscriptPage(sessionId, { before: "missing" })).toThrow("unknown_entry");
		await runtime.release(sessionId, { clientId });
	});
});
