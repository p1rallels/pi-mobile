import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ApiSessionStats, SseEvent } from "../src/types.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

function streamingFlags(events: SseEvent[]): Array<[string, boolean | undefined]> {
	const flags: Array<[string, boolean | undefined]> = [];
	let lastEvent = "";
	for (const event of events) {
		if (event.type === "agent_event") lastEvent = event.event.type;
		if (event.type === "state_patch") flags.push([lastEvent, event.patch.isStreaming]);
	}
	return flags;
}

describe("session run state", () => {
	test("stays streaming through an automatic retry until agent_settled", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }),
			fauxAssistantMessage("recovered"),
		]);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hello" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));

		const types = agentEventTypes(events);
		expect(types).toContain("auto_retry_start");
		expect(types).toContain("auto_retry_end");
		expect(types.filter((type) => type === "agent_end").length).toBe(2);

		const firstAgentEnd = events.find((event) => event.type === "agent_event" && event.event.type === "agent_end");
		expect(firstAgentEnd?.type === "agent_event" && firstAgentEnd.event.type === "agent_end" && firstAgentEnd.event.willRetry).toBe(true);

		const flags = streamingFlags(events);
		expect(flags.at(-1)).toEqual(["agent_settled", false]);
		expect(flags.slice(0, -1).every(([, isStreaming]) => isStreaming === true)).toBe(true);
		expect(runtime.getSessionState(sessionId).isStreaming).toBe(false);

		await runtime.release(sessionId, { clientId });
	});

	test("footer totals follow each message as it lands, not just the end of the run", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([fauxAssistantMessage("a reply long enough to cost a few output tokens")]);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hello" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));

		// the stats in the first patch after each message_end, up to agent_end
		const afterMessage: Array<[string, ApiSessionStats | null | undefined]> = [];
		let ended: string | null = null;
		for (const event of events) {
			if (event.type === "agent_event" && event.event.type === "agent_end") break;
			if (event.type === "agent_event" && event.event.type === "message_end") ended = event.event.message.role;
			else if (event.type === "state_patch" && ended !== null) {
				afterMessage.push([ended, event.patch.stats]);
				ended = null;
			}
		}
		const statsAfter = (role: string) => afterMessage.find(([ended]) => ended === role)?.[1];
		expect(afterMessage.map(([role]) => role).slice(-2)).toEqual(["user", "assistant"]);
		expect(statsAfter("user")?.tokens.output).toBe(0);
		expect(statsAfter("assistant")?.tokens.output).toBeGreaterThan(0);

		await runtime.release(sessionId, { clientId });
	});
});
