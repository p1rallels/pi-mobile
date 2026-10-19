// Subs open read-only and parents with live subs stay loaded (src/msg-subs.ts, src/session-slots.ts), on a real runtime
// with faux sessions and msg's presence records on disk, written the way msg writes them (a temp file renamed into
// place). The idle sweep runs on an injected time: PI_WEB_IDLE_SESSION_MINUTES can't go under a minute here.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { watchMsgMail, type MailWatch } from "../src/msg-mail.ts";
import { SUB_GRACE_MS } from "../src/msg-subs.ts";
import { PiWebRuntime, ReadOnlySessionError } from "../src/session-runtime.ts";
import type { ApiReadOnly, FollowSseEvent } from "../src/types.ts";
import { cleanupAgentDirs, startFauxSession, waitFor, type FauxSession } from "./support/faux_runtime.ts";

const HOUR = 60 * 60_000;
const SUB = "01a155b1-0000-7000-8000-0000000000b1";
const SUB2 = "01a155b1-0000-7000-8000-0000000000b2";
const PARENT = "01a152a0-0000-7000-8000-0000000000a1";
// above any pid macOS hands out: a sub's process may be gone, the waiting rule only reads its record
const DEAD_PID = 999_999;

const watches: MailWatch[] = [];
const folders: string[] = [];

afterEach(async () => {
	for (const watch of watches.splice(0)) watch.stop();
	await cleanupAgentDirs();
	await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

type Session = FauxSession & { sessionFile: string; root: string; lines: string[] };

/** A folder of its own, like a pfs fork's, that a test may delete. */
async function folder(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-subs-"));
	folders.push(dir);
	return dir;
}

/** A session pi-web hosts, saved, nobody watching it; the sweep's lines go to `lines`. */
async function persistedSession(
	options: { responses?: FauxResponseStep[]; cwd?: string; runtime?: { maxRunningSessions?: number; clock?: () => number } } = {},
): Promise<Session> {
	const lines: string[] = [];
	const session = await startFauxSession(options.responses ?? [fauxAssistantMessage("reply")], {
		cwd: options.cwd,
		runtime: { ...options.runtime, log: (line) => lines.push(line), listPiProcesses: async () => [] },
	});
	await prompt(session, session.sessionId);
	const sessionFile = session.runtime.getSessionState(session.sessionId).sessionFile;
	if (!sessionFile) throw new Error("the session was never saved");
	session.runtime.removeClient(session.sessionId, "connection-1");
	return { ...session, sessionFile, root: join(session.agentDir, "msg"), lines };
}

/** Sends a prompt and waits until the session settled, saved, with its answer. */
async function prompt(session: FauxSession, sessionId: string): Promise<void> {
	const { runtime } = session;
	await runtime.handleCommand(sessionId, { type: "prompt", clientId: session.clientId, text: "hi" });
	await waitFor(() => {
		const state = runtime.getSessionState(sessionId);
		return !state.isStreaming && state.messages.length >= 2 && state.sessionFile !== null && runtime.getHealth().busySessions === 0;
	});
}

/** A presence record the way msg writes one: to a temp file, renamed into place (which is what moves the folder's mtime). */
async function writePresence(root: string, record: Record<string, unknown> & { id: string }): Promise<void> {
	const dir = join(root, "sessions");
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `.${record.id}.${String(process.pid)}.tmp`);
	await writeFile(temp, `${JSON.stringify({ v: 1, mode: "print", activity: "busy", pid: DEAD_PID, startedAt: Date.now() - 60_000, heartbeatAt: Date.now(), ...record })}\n`);
	await rename(temp, join(dir, `${record.id}.json`));
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A sub's session file in pi's format, in pi's sessions folder for `cwd`: a prompt and its finished answer. */
async function writeSubFile(agentDir: string, cwd: string, id: string): Promise<string> {
	const dir = join(agentDir, "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-19T19-44-17-051Z_${id}.jsonl`);
	const at = Date.now() - 60_000;
	const time = (offset: number) => new Date(at + offset).toISOString();
	const entries = [
		{ type: "session", version: 3, id, timestamp: time(0), cwd },
		{ type: "message", id: "e0000001", parentId: null, timestamp: time(1), message: { role: "user", content: [{ type: "text", text: "scout the store" }], timestamp: at + 1 } },
		{
			type: "message",
			id: "e0000002",
			parentId: "e0000001",
			timestamp: time(2),
			message: { role: "assistant", content: [{ type: "text", text: "three records" }], api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "stop", timestamp: at + 2 },
		},
	];
	await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	return path;
}

function watchMail(runtime: PiWebRuntime, root: string, lines: string[]): MailWatch {
	const watch = watchMsgMail(runtime, { root, intervalMs: 60_000, log: (line) => lines.push(line) });
	watches.push(watch);
	return watch;
}

/** A message the way msg delivers it: written to the recipient's tmp/, renamed into new/. */
async function deliver(root: string, sessionId: string, id: string): Promise<void> {
	const box = join(root, "inbox", sessionId);
	await mkdir(join(box, "tmp"), { recursive: true });
	await mkdir(join(box, "new"), { recursive: true });
	const tmp = join(box, "tmp", `.${id}.json.${String(process.pid)}.abcd1234.tmp`);
	await writeFile(tmp, `${JSON.stringify({ v: 1, id, ts: Date.now(), from: { id: "01a160aa-0000-7000-8000-000000000001", name: "peer" }, to: sessionId, text: "ping" })}\n`);
	await rename(tmp, join(box, "new", `${id}.json`));
}

async function refusal(work: Promise<unknown>): Promise<ReadOnlySessionError> {
	const error = await work.then(
		() => null,
		(caught: unknown) => caught,
	);
	if (!(error instanceof ReadOnlySessionError)) throw new Error(`expected a read-only refusal, got ${String(error)}`);
	return error;
}

/** The sessions pi-web's re-attach store names (detached-sessions.json), as written. */
async function detachedRecords(agentDir: string): Promise<string[]> {
	const raw = await readFile(join(agentDir, "pi-web", "detached-sessions.json"), "utf8").catch(() => "[]");
	return (JSON.parse(raw) as Array<{ sessionId: string }>).map((record) => record.sessionId);
}

describe("subs open read-only", () => {
	test("pi-web never loads a sub: resume and attach refuse it, and the list, the file read and the follow view say why", async () => {
		const lead = await persistedSession();
		const { runtime, agentDir, root, sessionId: leadId, clientId } = lead;
		const fork = await folder();
		const subPath = await writeSubFile(agentDir, fork, SUB);
		await writePresence(root, { id: SUB, name: "scout", parent: leadId, cwd: fork, endedAt: Date.now() - 1_000 });
		const why: ApiReadOnly = { reason: "sub", parent: leadId };

		expect((await refusal(runtime.startSession({ resumeSessionPath: subPath, clientId }))).readOnly).toEqual(why);
		expect((await refusal(runtime.attachSession(SUB, subPath, clientId))).readOnly).toEqual(why);
		expect(runtime.isRunning(SUB)).toBe(false);

		const listed = await runtime.listSessions({ id: SUB });
		expect(listed.sessions.map((session) => [session.id, session.readOnly])).toEqual([[SUB, why]]);
		expect((await runtime.listSessions({ id: leadId })).sessions[0]?.readOnly).toBeUndefined();
		const page = await runtime.readTranscriptFile(subPath, { limit: 10 });
		expect(page.readOnly).toEqual(why);
		expect(page.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

		const sent: unknown[] = [];
		const follow = await runtime.followSession(SUB, subPath, { send: (event) => sent.push(event), close() {} });
		follow.stop();
		const init = follow.init as Extract<FollowSseEvent, { type: "follow_init" }>;
		expect(init.session.readOnly).toEqual(why);
		expect(init.follow.state).toBe("done");
		await runtime.release(leadId, { clientId });
	});

	test("so is any session whose folder is gone, sub or not; it's forgotten for re-attach", async () => {
		const cwd = await folder();
		const { runtime, sessionId, sessionFile, clientId, lines } = await persistedSession({ cwd });
		expect(runtime.evictIdleSessions(Date.now() + HOUR)).toEqual([sessionId]);
		expect(runtime.detachedSessions().map((ref) => ref.sessionId)).toEqual([sessionId]);
		await rm(cwd, { recursive: true, force: true });

		expect((await refusal(runtime.attachSession(sessionId, sessionFile, clientId))).readOnly).toEqual({ reason: "folder" });
		expect(runtime.detachedSessions()).toEqual([]);
		expect((await refusal(runtime.startSession({ resumeSessionPath: sessionFile, clientId }))).readOnly).toEqual({ reason: "folder" });
		expect(runtime.isRunning(sessionId)).toBe(false);
		expect((await runtime.listSessions({ id: sessionId })).sessions[0]?.readOnly).toEqual({ reason: "folder" });
		expect((await runtime.readTranscriptFile(sessionFile, {})).readOnly).toEqual({ reason: "folder" });
		expect(lines).toEqual([]);
	});

	test("the sweep forgets a re-attach record that opens read-only now, and says so", async () => {
		const cwd = await folder();
		const { runtime, sessionId, lines } = await persistedSession({ cwd });
		runtime.evictIdleSessions(Date.now() + HOUR);
		await rm(cwd, { recursive: true, force: true });
		const report = await runtime.sweep();
		expect(report.forgotten).toEqual([{ sessionId, readOnly: { reason: "folder" } }]);
		expect(runtime.detachedSessions()).toEqual([]);
		expect(lines).toEqual([`[pi-web] forgot ${sessionId} for re-attach: its folder is gone`]);
	});
});

describe("a parent with subs stays loaded", () => {
	test("the idle sweep keeps a parent a sub still counts on, and disposes it once the sub ended", async () => {
		const { runtime, sessionId, root, lines } = await persistedSession();
		const later = Date.now() + HOUR;
		// msg would rewrite the heartbeat every 10s; this one is a minute old an hour from now
		await writePresence(root, { id: SUB, parent: sessionId, cwd: process.cwd(), heartbeatAt: later - 60_000 });
		const kept = await runtime.sweep(later);
		expect(kept.disposed).toEqual([]);
		expect(runtime.isRunning(sessionId)).toBe(true);
		expect(runtime.sessionRoom().running.map((slot) => [slot.sessionId, slot.evictable])).toEqual([[sessionId, false]]);

		await writePresence(root, { id: SUB, parent: sessionId, cwd: process.cwd(), heartbeatAt: later - 60_000, endedAt: later - 30_000 });
		expect((await runtime.sweep(later)).disposed).toEqual([sessionId]);
		expect(runtime.isRunning(sessionId)).toBe(false);
		expect(lines).toEqual([`[pi-web] disposed idle session ${sessionId}`]);
	});

	test("a sub that never ended (crashed, hung, its process gone) keeps its parent for 5 minutes past its last heartbeat", async () => {
		const { runtime, sessionId, root } = await persistedSession();
		const heartbeatAt = Date.now() + HOUR;
		await writePresence(root, { id: SUB, parent: sessionId, cwd: process.cwd(), heartbeatAt, pid: DEAD_PID });
		expect((await runtime.sweep(heartbeatAt + SUB_GRACE_MS - 1_000)).disposed).toEqual([]);
		expect(runtime.isRunning(sessionId)).toBe(true);
		expect((await runtime.sweep(heartbeatAt + SUB_GRACE_MS)).disposed).toEqual([sessionId]);
	});

	test("health counts it as waiting, and only while it's idle with a sub that counts", async () => {
		const { runtime, sessionId, root } = await persistedSession();
		expect(runtime.getHealth().waitingSessions).toBe(0);
		await writePresence(root, { id: SUB, parent: sessionId, cwd: process.cwd() });
		await runtime.refreshPresence();
		expect(runtime.getHealth()).toMatchObject({ runningSessions: 1, busySessions: 0, waitingSessions: 1 });
		await writePresence(root, { id: SUB, parent: sessionId, cwd: process.cwd(), endedAt: Date.now() });
		await runtime.refreshPresence();
		expect(runtime.getHealth().waitingSessions).toBe(0);
	});

	test("at the cap a new session takes the slot of one nothing waits on, never a waiting one; with only those left it's refused", async () => {
		const parent = await persistedSession({ responses: [fauxAssistantMessage("a"), fauxAssistantMessage("b")], runtime: { maxRunningSessions: 2 } });
		const { runtime, root, clientId } = parent;
		const a = parent.sessionId;
		await writePresence(root, { id: SUB, parent: a, cwd: process.cwd() });
		const { sessionId: b } = await runtime.startSession({ cwd: process.cwd(), clientId });
		await prompt(parent, b);
		// a is the older of the two, but its sub still counts
		const { sessionId: c } = await runtime.startSession({ cwd: process.cwd(), clientId });
		expect([runtime.isRunning(a), runtime.isRunning(b), runtime.isRunning(c)]).toEqual([true, false, true]);

		await writePresence(root, { id: SUB2, parent: c, cwd: process.cwd() });
		await expect(runtime.startSession({ cwd: process.cwd(), clientId })).rejects.toThrow("too_many_active_sessions");
		expect([runtime.isRunning(a), runtime.isRunning(c)]).toEqual([true, true]);
	});

	test("after a restart a detached parent its subs count on comes back with no viewer; one without stays down", async () => {
		const lead = await persistedSession({ responses: [fauxAssistantMessage("a"), fauxAssistantMessage("b")] });
		const { runtime, root, modelRuntime, clientId } = lead;
		const waiting = lead.sessionId;
		const { sessionId: idle } = await runtime.startSession({ cwd: process.cwd(), clientId });
		await prompt(lead, idle);
		await runtime.shutdown(5_000);
		const later = Date.now() + HOUR;
		await writePresence(root, { id: SUB, parent: waiting, cwd: process.cwd(), heartbeatAt: later - 60_000 });

		const lines: string[] = [];
		const restarted = new PiWebRuntime({ modelRuntime, log: (line) => lines.push(line), listPiProcesses: async () => [] });
		expect(await restarted.loadDetachedSessions()).toBe(2);
		const report = await restarted.sweep();
		expect(report.reopened).toEqual([waiting]);
		expect([restarted.isRunning(waiting), restarted.isRunning(idle)]).toEqual([true, false]);
		expect(lines).toEqual([`[pi-web] reopened ${waiting} for its subs`]);
		expect(restarted.getSessionRole(waiting, clientId)).toEqual({ role: "viewer", controllerClientId: null });
		expect(restarted.getHealth()).toMatchObject({ runningSessions: 1, waitingSessions: 1, viewers: 0, detachedSessions: 1 });

		// an hour on, idle and unwatched, it stays while its sub counts; nothing brings back the one without subs
		expect(await restarted.sweep(later)).toEqual({ forgotten: [], disposed: [], reopened: [] });
		expect([restarted.isRunning(waiting), restarted.isRunning(idle)]).toEqual([true, false]);
		await restarted.shutdown(5_000);
	});

	test("a restart forgets the re-attach records of a sub and of a session whose folder is gone", async () => {
		const cwd = await folder();
		const gone = await persistedSession({ cwd, responses: [fauxAssistantMessage("a"), fauxAssistantMessage("b")] });
		const { runtime, root, modelRuntime, clientId, agentDir } = gone;
		const { sessionId: sub } = await runtime.startSession({ cwd: process.cwd(), clientId });
		await prompt(gone, sub);
		await runtime.shutdown(5_000);
		expect((await detachedRecords(agentDir)).sort()).toEqual([gone.sessionId, sub].sort());
		// tonight's mistake: pi-web had resumed a sub; and pfs removed the other's fork
		await writePresence(root, { id: sub, parent: PARENT, cwd: process.cwd(), endedAt: Date.now() });
		await rm(cwd, { recursive: true, force: true });

		const lines: string[] = [];
		const restarted = new PiWebRuntime({ modelRuntime, log: (line) => lines.push(line) });
		expect(await restarted.loadDetachedSessions()).toBe(0);
		expect(lines.sort()).toEqual(
			[`[pi-web] forgot ${gone.sessionId} for re-attach: its folder is gone`, `[pi-web] forgot ${sub} for re-attach: it's a sub, which pi-web only shows`].sort(),
		);
		// shutdown waits for the store's writes
		await restarted.shutdown(1_000);
		expect(await detachedRecords(agentDir)).toEqual([]);
	});

	test("msg mail never reopens a sub or a session whose folder is gone, and forgets its record", async () => {
		const cwd = await folder();
		const gone = await persistedSession({ cwd, responses: [fauxAssistantMessage("a"), fauxAssistantMessage("b")] });
		const { runtime, root, clientId } = gone;
		const { sessionId: sub } = await runtime.startSession({ cwd: process.cwd(), clientId });
		await prompt(gone, sub);
		expect(runtime.evictIdleSessions(Date.now() + HOUR).sort()).toEqual([gone.sessionId, sub].sort());
		await writePresence(root, { id: sub, parent: PARENT, cwd: process.cwd(), endedAt: Date.now() });
		await rm(cwd, { recursive: true, force: true });

		const lines: string[] = [];
		const watch = watchMail(runtime, root, lines);
		await deliver(root, gone.sessionId, "0mv962x7a-111111");
		await deliver(root, sub, "0mv962x7b-222222");
		await watch.sweep();
		await watch.sweep();
		expect([runtime.isRunning(gone.sessionId), runtime.isRunning(sub)]).toEqual([false, false]);
		expect(lines.sort()).toEqual(
			[
				`[pi-web] not reopening ${gone.sessionId} for msg mail: its folder is gone; forgot it for re-attach`,
				`[pi-web] not reopening ${sub} for msg mail: it's a sub, which pi-web only shows; forgot it for re-attach`,
			].sort(),
		);
		expect(runtime.detachedSessions()).toEqual([]);
	});
});
