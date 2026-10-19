// msg mail for a session pi-web disposed brings it back (src/msg-mail.ts), on a real runtime with faux sessions and a
// real msg store on disk. The idle sweep runs on an injected clock: PI_WEB_IDLE_SESSION_MINUTES can't go under a minute.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { watchMsgMail, type MailWatch } from "../src/msg-mail.ts";
import { PiWebRuntime } from "../src/session-runtime.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor, type FauxSession } from "./support/faux_runtime.ts";

const HOUR = 60 * 60_000;
const M1 = "0mv962x7a-111111";
const M2 = "0mv962x7b-222222";

const watches: MailWatch[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const watch of watches.splice(0)) watch.stop();
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await cleanupAgentDirs();
});

/**
 * msg in miniature: at session start it claims what waits in the session's inbox (new/ to cur/) and wakes the session
 * with it, the way msg's extension delivers an offline inbox.
 */
const MAIL_TAKER = `
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		const box = join(process.env.PI_CODING_AGENT_DIR, "msg", "inbox", ctx.sessionManager.getSessionId());
		let names = [];
		try {
			names = readdirSync(join(box, "new")).filter((name) => name.endsWith(".json")).sort();
		} catch {
			return;
		}
		if (names.length === 0) return;
		mkdirSync(join(box, "cur"), { recursive: true });
		for (const name of names) renameSync(join(box, "new", name), join(box, "cur", name));
		setTimeout(() => pi.sendMessage({ customType: "msg", content: "mail: " + names.join(", "), display: true, details: { ids: names } }, { triggerTurn: true }), 10);
	});
}
`;

type Session = FauxSession & { sessionFile: string; root: string };

async function persistedSession(
	options: { responses?: FauxResponseStep[]; runtime?: { maxRunningSessions?: number }; extensions?: Record<string, string> } = {},
): Promise<Session> {
	const session = await startFauxSession(options.responses ?? [fauxAssistantMessage("reply")], { runtime: options.runtime, extensions: options.extensions });
	await session.runtime.handleCommand(session.sessionId, { type: "prompt", clientId: session.clientId, text: "hi" });
	await waitFor(() => agentEventTypes(session.events).includes("agent_settled"));
	const sessionFile = session.runtime.getSessionState(session.sessionId).sessionFile;
	if (!sessionFile) throw new Error("the session was never saved");
	session.runtime.removeClient(session.sessionId, "connection-1");
	return { ...session, sessionFile, root: join(session.agentDir, "msg") };
}

/** The idle sweep an hour from now: nobody watched the session, so pi-web disposes it and records it for re-attach. */
function idleOut(runtime: PiWebRuntime, sessionId: string): void {
	expect(runtime.evictIdleSessions(Date.now() + HOUR)).toContain(sessionId);
	expect(runtime.isRunning(sessionId)).toBe(false);
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
	await writeFile(tmp, `${JSON.stringify({ v: 1, id, ts: Date.now(), from: { id: "child-1", name: "scout" }, to: sessionId, text: "done", delivery: "steer", kind: "ended" })}\n`);
	await rename(tmp, join(box, "new", `${id}.json`));
}

/** What msg does when it takes a message: new/ to cur/. */
async function claim(root: string, sessionId: string): Promise<void> {
	const box = join(root, "inbox", sessionId);
	await mkdir(join(box, "cur"), { recursive: true });
	for (const name of await readdir(join(box, "new"))) await rename(join(box, "new", name), join(box, "cur", name));
}

async function writePresence(root: string, sessionId: string, fields: { pid: number; endedAt?: number }): Promise<void> {
	await mkdir(join(root, "sessions"), { recursive: true });
	const now = Date.now();
	const record = { v: 1, id: sessionId, cwd: process.cwd(), mode: "tui", activity: "idle", startedAt: now - 60_000, heartbeatAt: now, ...fields };
	await writeFile(join(root, "sessions", `${sessionId}.json`), `${JSON.stringify(record)}\n`);
}

const reopened = (sessionId: string) => `[pi-web] reopened ${sessionId} for msg mail`;

describe("msg mail for a session pi-web disposed", () => {
	test("brings it back running, with nobody watching, when a message lands in its inbox", async () => {
		const { runtime, sessionId, sessionFile, root } = await persistedSession();
		idleOut(runtime, sessionId);
		// msg's record still says this server runs it (msg ends it on its next tick): that's no other owner
		await writePresence(root, sessionId, { pid: process.pid });
		const lines: string[] = [];
		const watch = watchMail(runtime, root, lines);
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(false);

		await deliver(root, sessionId, M1);
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(true);
		expect(lines).toEqual([reopened(sessionId)]);
		expect(runtime.canvasStatus()).toEqual([{ id: sessionId, path: sessionFile, working: false, waiting: false, viewers: 0 }]);
		expect(runtime.getSessionRole(sessionId, "client-1")).toEqual({ role: "viewer", controllerClientId: null });
		expect(runtime.getHealth().detachedSessions).toBe(0);
		expect(runtime.getSessionState(sessionId).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(await readdir(join(root, "inbox", sessionId, "new"))).toEqual([`${M1}.json`]);

		// the first viewer to open it takes control
		runtime.addClient(sessionId, { connectionId: "phone-1", clientId: "phone", send() {}, close() {} });
		expect(runtime.getSessionRole(sessionId, "phone").role).toBe("controller");
		await runtime.release(sessionId, { clientId: "phone" });
	});

	test("msg in the reopened session takes the mail and wakes it; taken mail doesn't bring it back again", async () => {
		const { runtime, sessionId, root } = await persistedSession({
			responses: [fauxAssistantMessage("reply"), fauxAssistantMessage("on it")],
			extensions: { "mail-taker.ts": MAIL_TAKER },
		});
		idleOut(runtime, sessionId);
		const lines: string[] = [];
		const watch = watchMail(runtime, root, lines);
		await deliver(root, sessionId, M1);
		await watch.sweep();
		await waitFor(() => {
			const state = runtime.getSessionState(sessionId);
			return !state.isStreaming && state.messages.length === 4;
		});
		const messages = runtime.getSessionState(sessionId).messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "custom", "assistant"]);
		expect(messages[2]).toMatchObject({ customType: "msg", details: { ids: [`${M1}.json`] } });
		expect(await readdir(join(root, "inbox", sessionId, "new"))).toEqual([]);
		expect(await readdir(join(root, "inbox", sessionId, "cur"))).toEqual([`${M1}.json`]);

		await waitFor(() => runtime.sessionRoom().running.every((slot) => slot.evictable));
		idleOut(runtime, sessionId);
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(false);
		expect(lines).toEqual([reopened(sessionId)]);
	});

	test("stays down when its file changed since pi-web disposed it", async () => {
		const { runtime, sessionId, sessionFile, root, clientId } = await persistedSession();
		idleOut(runtime, sessionId);
		const label = { type: "label", id: "cli00001", parentId: null, timestamp: new Date().toISOString(), targetId: "x", label: "cli" };
		await appendFile(sessionFile, `${JSON.stringify(label)}\n`);
		const lines: string[] = [];
		const watch = watchMail(runtime, root, lines);
		await deliver(root, sessionId, M1);
		await watch.sweep();
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(false);
		expect(lines).toEqual([`[pi-web] not reopening ${sessionId} for msg mail: its file changed since pi-web disposed it`]);

		// reopening it by hand still works, like the page's reopen
		await runtime.startSession({ resumeSessionPath: sessionFile, clientId });
		expect(runtime.isRunning(sessionId)).toBe(true);
		await runtime.release(sessionId, { clientId });
	});

	test("stays down once released (/quit)", async () => {
		const { runtime, sessionId, root, clientId } = await persistedSession();
		await runtime.release(sessionId, { clientId });
		const lines: string[] = [];
		const watch = watchMail(runtime, root, lines);
		await deliver(root, sessionId, M1);
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(false);
		expect(lines).toEqual([]);
	});

	test("stays down while another live process runs it, and comes back once that process is gone", async () => {
		const { runtime, sessionId, root } = await persistedSession();
		idleOut(runtime, sessionId);
		const other = Bun.spawn({ cmd: ["sleep", "30"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		children.push(other);
		await writePresence(root, sessionId, { pid: other.pid });
		const lines: string[] = [];
		const watch = watchMail(runtime, root, lines);
		await deliver(root, sessionId, M1);
		await watch.sweep();
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(false);
		expect(lines).toEqual([`[pi-web] not reopening ${sessionId} for msg mail: pid ${String(other.pid)} runs it`]);

		other.kill("SIGKILL");
		await other.exited;
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(true);
		expect(lines.at(-1)).toBe(reopened(sessionId));
	});

	test("without msg to take it, the same mail brings a session back once, and newer mail once more", async () => {
		const { runtime, sessionId, root } = await persistedSession();
		idleOut(runtime, sessionId);
		const lines: string[] = [];
		const watch = watchMail(runtime, root, lines);
		await deliver(root, sessionId, M1);
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(true);

		idleOut(runtime, sessionId);
		await watch.sweep();
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(false);

		await deliver(root, sessionId, M2);
		await watch.sweep();
		expect(runtime.isRunning(sessionId)).toBe(true);
		expect(lines).toEqual([reopened(sessionId), reopened(sessionId)]);
	});

	test("at the cap it takes the slot of an idle unwatched session without mail, never of one with mail waiting", async () => {
		const first = await persistedSession({ responses: [fauxAssistantMessage("a reply"), fauxAssistantMessage("b reply")], runtime: { maxRunningSessions: 1 } });
		const { runtime, clientId, root } = first;
		const a = first.sessionId;
		const { sessionId: b } = await runtime.startSession({ cwd: process.cwd(), clientId });
		expect(runtime.isRunning(a)).toBe(false);
		await runtime.handleCommand(b, { type: "prompt", clientId, text: "hi b" });
		await waitFor(() => runtime.getSessionState(b).messages.length === 2 && runtime.sessionRoom().running.every((slot) => slot.evictable));

		const lines: string[] = [];
		const watch = watchMail(runtime, root, lines);
		await deliver(root, a, M1);
		await watch.sweep();
		expect([runtime.isRunning(a), runtime.isRunning(b)]).toEqual([true, false]);
		expect(lines).toEqual([`[pi-web] disposed idle session ${b} to make room for msg mail`, reopened(a)]);

		// nothing here runs msg, so a's mail still waits: b's mail finds no room, says so once, and waits too
		await deliver(root, b, M2);
		await watch.sweep();
		await watch.sweep();
		expect([runtime.isRunning(a), runtime.isRunning(b)]).toEqual([true, false]);
		expect(lines.slice(2)).toEqual([
			`[pi-web] no room to reopen ${b} for msg mail: 1 of 1 sessions running, none idle, unwatched and without mail of its own; the mail waits`,
		]);

		// a's msg took its mail: a gives its slot to b, and nothing sends it back a's way
		await claim(root, a);
		await watch.sweep();
		await watch.sweep();
		expect([runtime.isRunning(a), runtime.isRunning(b)]).toEqual([false, true]);
		expect(lines.slice(3)).toEqual([`[pi-web] disposed idle session ${a} to make room for msg mail`, reopened(b)]);
		await runtime.release(b, { clientId });
	});

	test("a restart while one is coming back records it for re-attach like the rest, and nothing comes back once stopping", async () => {
		const { runtime, sessionId, sessionFile, modelRuntime } = await persistedSession();
		idleOut(runtime, sessionId);
		const reopen = runtime.reopenForMail(sessionId, sessionFile, null);
		expect(reopen).not.toBeNull();
		await runtime.shutdown(5_000);
		await reopen?.running;
		expect(runtime.isRunning(sessionId)).toBe(false);
		expect(runtime.reopenForMail(sessionId, sessionFile, null)).toBeNull();

		const restarted = new PiWebRuntime({ modelRuntime });
		expect(await restarted.loadDetachedSessions()).toBe(1);
		expect(restarted.detachedSessions()).toEqual([{ sessionId, path: sessionFile, cwd: process.cwd() }]);
	});

	test("mail that came while pi-web was down brings its session back at the start", async () => {
		const { runtime, sessionId, root, modelRuntime } = await persistedSession();
		await runtime.shutdown(1_000);
		await deliver(root, sessionId, M1);

		const restarted = new PiWebRuntime({ modelRuntime });
		expect(await restarted.loadDetachedSessions()).toBe(1);
		const lines: string[] = [];
		const watch = watchMail(restarted, root, lines);
		await watch.sweep();
		expect(restarted.isRunning(sessionId)).toBe(true);
		expect(lines).toEqual([reopened(sessionId)]);
		await restarted.shutdown(1_000);
	});
});
