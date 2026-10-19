import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionClient } from "../src/session-runtime.ts";
import type { SseEvent } from "../src/types.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor, type SseFrame } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

/**
 * A relay-like extension: entries appended at turn_end, the way pi 1.2's boundaries do it (entry_appended, no
 * message events). The first turn gets a nudge, the second a relay reset (a retain-none compaction) and a state
 * entry nobody draws.
 */
const RELAY_PROBE = `
export default function relayProbe(pi) {
	let turns = 0;
	pi.on("turn_end", () => {
		turns += 1;
		if (turns === 1) {
			return { entries: [{ type: "custom_message", customType: "relay", content: "41%: finish the step, then call relay", display: true, details: { kind: "nudge", percent: 41 } }] };
		}
		if (turns === 2) {
			return {
				entries: [
					{ type: "compaction", summary: "fresh start: carry on", firstKeptEntryId: null, details: { relay: { n: 1, percent: 45, note: "tests pass, docs left" } } },
					{ type: "custom", customType: "relay-state", data: { n: 1 } },
				],
			};
		}
		return undefined;
	});
}
`;

function viewer(connectionId: string): { client: SessionClient; frames: SseFrame[] } {
	const frames: SseFrame[] = [];
	return { frames, client: { connectionId, clientId: connectionId, send: (event, id) => frames.push({ event, id }), close() {} } };
}

type Appended = { entryType: string; entryId: string; frameEntryId: string | undefined; id: string | undefined };

function appended(frames: SseFrame[]): Appended[] {
	return frames.flatMap(({ event, id }) =>
		event.type === "agent_event" && event.event.type === "entry_appended"
			? [{ entryType: event.event.entry.type, entryId: event.event.entry.id, frameEntryId: event.entryId, id }]
			: [],
	);
}

/** Every entry pi wrote under the agent dir's sessions. */
async function savedEntries(agentDir: string): Promise<Array<Record<string, unknown>>> {
	const files = await Array.fromAsync(new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: agentDir, absolute: true }));
	const lines = (await Promise.all(files.map((file) => Bun.file(file).text()))).flatMap((body) => body.split("\n").filter(Boolean));
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function contextPercent(event: SseEvent): number | null | undefined {
	return event.type === "state_patch" ? event.patch.contextUsage?.percent : undefined;
}

describe("entries appended at turn boundaries", () => {
	test("reach the page with their entry id as the frame cursor, and a reset refreshes the context meter", async () => {
		const { runtime, sessionId, clientId, events, frames, agentDir } = await startFauxSession([fauxAssistantMessage("one"), fauxAssistantMessage("two")], {
			extensions: { "relay-probe.ts": RELAY_PROBE },
		});
		const settled = () => agentEventTypes(events).filter((type) => type === "agent_settled").length;
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "first" });
		await waitFor(() => settled() === 1);
		const afterNudge = frames.findLast(({ id }) => id !== undefined)?.id;
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "second" });
		await waitFor(() => settled() === 2);

		const seen = appended(frames);
		expect(seen.map(({ entryType }) => entryType)).toEqual(["custom_message", "compaction", "custom"]);
		const wireReset = frames.find(({ event }) => event.type === "agent_event" && event.event.type === "entry_appended" && event.event.entry.type === "compaction");
		expect(wireReset?.event.type === "agent_event" && wireReset.event.event.type === "entry_appended" ? wireReset.event.event.entry : null).toMatchObject({
			summary: "fresh start: carry on",
			details: { relay: { n: 1, percent: 45, note: "tests pass, docs left" } },
		});
		expect(JSON.stringify(wireReset?.event)).not.toContain("systemMessage");
		const saved = await savedEntries(agentDir);
		expect(saved.find((entry) => entry.type === "compaction")?.systemMessage).toBeDefined();
		expect(seen.every(({ entryId, frameEntryId, id }) => frameEntryId === entryId && id === entryId)).toBe(true);
		expect(afterNudge).toBe(seen[0]?.entryId);

		const compactionAt = frames.findIndex(({ event }) => event.type === "agent_event" && event.event.type === "entry_appended" && event.event.entry.type === "compaction");
		const patch = frames.slice(compactionAt + 1).find(({ event }) => event.type === "state_patch");
		expect(patch).toBeDefined();
		expect(contextPercent(patch!.event)).toBeNull();

		const page = runtime.getTranscriptPage(sessionId, {});
		const nudge = page.messages.find((message) => message.role === "custom");
		expect(nudge).toMatchObject({ customType: "relay", details: { kind: "nudge", percent: 41 }, entryId: seen[0]?.entryId });
		const reset = page.messages.find((message) => message.role === "compactionSummary");
		expect(reset).toMatchObject({ summary: "fresh start: carry on", details: { relay: { n: 1, percent: 45, note: "tests pass, docs left" } }, entryId: seen[1]?.entryId });

		const back = runtime.connectClient(sessionId, viewer("back").client, afterNudge).init.transcript;
		expect(back.mode).toBe("append");
		expect(back.messages.map((message) => message.role)).toEqual(["user", "assistant", "compactionSummary"]);

		await runtime.release(sessionId, { clientId });
	});

	test("an ordinary compaction keeps its summary message as it was", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([fauxAssistantMessage("first answer"), fauxAssistantMessage("the summary")], {
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hello" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		await runtime.handleCommand(sessionId, { type: "compact", clientId });
		await waitFor(() => agentEventTypes(events).includes("compaction_end"));

		const summary = runtime.getTranscriptPage(sessionId, {}).messages.find((message) => message.role === "compactionSummary");
		expect(summary).toBeDefined();
		expect(summary && "details" in summary).toBe(false);

		await runtime.release(sessionId, { clientId });
	});
});

describe("finding one session by id", () => {
	test("lists just that session, from any folder", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([fauxAssistantMessage("hi")]);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hello" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));

		const found = await runtime.listSessions({ id: sessionId });
		expect(found.sessions.map((session) => [session.id, session.isRunning])).toEqual([[sessionId, true]]);
		expect((await runtime.listSessions({ id: "nobody" })).sessions).toEqual([]);

		await runtime.release(sessionId, { clientId });
		const saved = await runtime.listSessions({ id: sessionId });
		expect(saved.sessions.map((session) => [session.id, session.isRunning])).toEqual([[sessionId, false]]);
		expect(saved.sessions[0]?.path).toBeTruthy();
	});
});
