import { afterEach, describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor, type FauxSession } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

const HOUR = 60 * 60_000;

async function persistedSession(): Promise<FauxSession & { sessionFile: string }> {
	const session = await startFauxSession([fauxAssistantMessage("reply")]);
	await session.runtime.handleCommand(session.sessionId, { type: "prompt", clientId: session.clientId, text: "hi" });
	await waitFor(() => agentEventTypes(session.events).includes("agent_settled"));
	return { ...session, sessionFile: session.runtime.getSessionState(session.sessionId).sessionFile! };
}

describe("session lifecycle", () => {
	test("disposes unwatched idle sessions and resumes them on attach", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([fauxAssistantMessage("persisted reply")]);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "remember me" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		const sessionFile = runtime.getSessionState(sessionId).sessionFile;
		expect(sessionFile).not.toBeNull();

		expect(runtime.evictIdleSessions(Date.now() + HOUR)).toEqual([]);
		runtime.removeClient(sessionId, "connection-1");
		expect(runtime.evictIdleSessions(Date.now())).toEqual([]);
		expect(runtime.evictIdleSessions(Date.now() + HOUR)).toEqual([sessionId]);
		expect(runtime.isRunning(sessionId)).toBe(false);

		await runtime.attachSession(sessionId, sessionFile!, clientId);
		expect(runtime.isRunning(sessionId)).toBe(true);
		const roles = runtime.getSessionState(sessionId).messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant"]);
		expect(runtime.getSessionRole(sessionId, clientId).role).toBe("controller");

		await runtime.release(sessionId, { clientId });
	});

	test("refuses attach paths outside the sessions dir or for another session", async () => {
		const { runtime, sessionId, clientId, sessionFile } = await persistedSession();
		runtime.removeClient(sessionId, "connection-1");
		runtime.evictIdleSessions(Date.now() + HOUR);

		await expect(runtime.attachSession(sessionId, "/etc/passwd", clientId)).rejects.toThrow("session_path_not_allowed");
		await expect(runtime.attachSession("someone-else", sessionFile, clientId)).rejects.toThrow("session_not_attachable");
		await expect(runtime.attachSession(sessionId, undefined, clientId)).rejects.toThrow("session_not_running");
		expect(runtime.isRunning(sessionId)).toBe(false);
	});

	test("does not auto-attach released sessions or files written elsewhere", async () => {
		const released = await persistedSession();
		await released.runtime.release(released.sessionId, { clientId: released.clientId });
		await expect(released.runtime.attachSession(released.sessionId, released.sessionFile, released.clientId)).rejects.toThrow(
			"session_not_attachable",
		);

		const { runtime, sessionId, clientId, sessionFile } = await persistedSession();
		runtime.removeClient(sessionId, "connection-1");
		runtime.evictIdleSessions(Date.now() + HOUR);
		await appendFile(sessionFile, `${JSON.stringify({ type: "label", id: "cli00001", parentId: null, timestamp: new Date().toISOString(), targetId: "x", label: "cli" })}\n`);
		await expect(runtime.attachSession(sessionId, sessionFile, clientId)).rejects.toThrow("session_not_attachable");

		await runtime.startSession({ resumeSessionPath: sessionFile, clientId });
		expect(runtime.isRunning(sessionId)).toBe(true);
		await runtime.release(sessionId, { clientId });
	});

	test("frees a slot from the least recently used unwatched session at the cap", async () => {
		const { runtime, sessionId: first, clientId } = await startFauxSession([], { runtime: { maxRunningSessions: 1 } });

		await expect(runtime.startSession({ cwd: process.cwd(), clientId })).rejects.toThrow("too_many_active_sessions");

		runtime.removeClient(first, "connection-1");
		const { sessionId: second } = await runtime.startSession({ cwd: process.cwd(), clientId });
		expect(runtime.isRunning(first)).toBe(false);
		expect(runtime.isRunning(second)).toBe(true);

		await runtime.release(second, { clientId });
	});

	test("lists a repo's sessions from the index with running flags and paging", async () => {
		const { runtime, sessionId, clientId, events, faux } = await persistedSession();
		faux.appendResponses([fauxAssistantMessage("second reply")]);
		const { sessionId: second } = await runtime.startSession({ cwd: process.cwd(), clientId });
		await runtime.handleCommand(second, { type: "prompt", clientId, text: "second session" });
		await waitFor(() => agentEventTypes(events).filter((type) => type === "agent_settled").length >= 1);
		await waitFor(() => runtime.getSessionState(second).messages.length === 2);
		await runtime.release(sessionId, { clientId });

		const all = await runtime.listSessions({ cwd: process.cwd() });
		expect(all.sessions.map((session) => [session.id, session.isRunning, session.firstMessage])).toEqual([
			[second, true, "second session"],
			[sessionId, false, "hi"],
		]);
		expect(all.hasMore).toBe(false);

		const firstPage = await runtime.listSessions({ cwd: process.cwd(), limit: 1 });
		expect(firstPage.sessions.map((session) => session.id)).toEqual([second]);
		expect(firstPage.hasMore).toBe(true);
		expect((await runtime.listSessions({ cwd: "/somewhere/else" })).sessions).toEqual([]);

		await runtime.release(second, { clientId });
	});
});
