import { afterEach, describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiProcess } from "../src/outside-writers.ts";
import { sessionDirForCwd } from "../src/session-index.ts";
import { AmbiguousWritersError, PiWebRuntime, RunningElsewhereError } from "../src/session-runtime.ts";
import type { FollowSseEvent } from "../src/types.ts";
import { cleanupAgentDirs, makeAgentDir, waitFor } from "./support/faux_runtime.ts";

const tempDirs: string[] = [];
const runtimes: PiWebRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown(500)));
	await cleanupAgentDirs();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const HOUR = 60 * 60_000;

function user(id: string, parentId: string | null, text: string) {
	return line({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
}

function assistant(id: string, parentId: string, stopReason: string, text = "") {
	const content = stopReason === "toolUse" ? [{ type: "toolCall", id: `call-${id}`, name: "bash", arguments: { command: "sleep 20" } }] : [{ type: "text", text }];
	return line({
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "assistant", content, api: "faux", provider: "faux", model: "faux-1", usage, stopReason, timestamp: Date.now() },
	});
}

function toolResult(id: string, parentId: string, callId: string) {
	return line({
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "Command exited with code 137" }], isError: true, timestamp: Date.now() },
	});
}

async function workDir(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-elsewhere-"));
	tempDirs.push(dir);
	return dir;
}

async function writeSession(agentDir: string, cwd: string, id: string, body: string): Promise<string> {
	const dir = sessionDirForCwd(join(agentDir, "sessions"), cwd);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-15T10-00-00-000Z_${id}.jsonl`);
	await writeFile(path, line({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }) + body);
	return path;
}

const MID_TOOL = user("u1", null, "count to 20 with sleeps") + assistant("a1", "u1", "toolUse");

function writer(pid: number, cwd: string, startedAtMs = Date.now() - HOUR): PiProcess {
	return { pid, pgid: pid, command: "pi", cwd, startedAtMs };
}

async function setup(initial: PiProcess[] | null = []) {
	const agentDir = await makeAgentDir();
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	let processes = initial;
	const stopped: PiProcess[] = [];
	const runtime = new PiWebRuntime({
		modelRuntime,
		followPollMs: 20,
		processCacheMs: 0,
		listPiProcesses: async () => processes,
		listForks: async () => '{"id":2,"label":"2-probe"}\n',
		stopPiProcess: async (proc) => {
			stopped.push(proc);
			processes = (processes ?? []).filter((other) => other.pid !== proc.pid);
			return "stopped";
		},
	});
	runtimes.push(runtime);
	return {
		runtime,
		agentDir,
		stopped,
		setProcesses(next: PiProcess[] | null) {
			processes = next;
		},
	};
}

describe("sessions another process is writing", () => {
	test("labels open turns by who is left to write them", async () => {
		const cwd = await workDir();
		const { runtime, agentDir, setProcesses } = await setup();
		await writeSession(agentDir, cwd, "s-open", MID_TOOL);
		await writeSession(agentDir, cwd, "s-done", user("u1", null, "hi") + assistant("a1", "u1", "stop", "hello"));
		const label = async (id: string) => (await runtime.listSessions({ cwd })).sessions.find((session) => session.id === id)?.elsewhere;

		expect(await label("s-done")).toBeUndefined();
		expect(await label("s-open")).toMatchObject({ state: "stopped", turn: "running_tools", writers: [] });

		setProcesses([writer(4242, cwd), writer(4343, "/somewhere/else")]);
		expect(await label("s-open")).toMatchObject({ state: "running", writers: [4242] });

		setProcesses(null);
		expect(await label("s-open")).toMatchObject({ state: "running", writers: null });
	});

	test("refuses a second copy while another pi writes it, and allows one once it's stopped or quiet", async () => {
		const cwd = await workDir();
		const { runtime, agentDir, setProcesses } = await setup([]);
		const path = await writeSession(agentDir, cwd, "01a13c00-0000-7000-8000-00000000e101", MID_TOOL);
		setProcesses([writer(5151, cwd, Date.now() - 3 * HOUR)]);

		const refused = await runtime.startSession({ resumeSessionPath: path, clientId: "c1" }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(RunningElsewhereError);
		expect((refused as RunningElsewhereError).elsewhere).toMatchObject({ state: "running", writers: [5151] });
		await expect(runtime.startSession({ resumeSessionPath: path, clientId: "c1", takeOver: true })).rejects.toThrow("running_elsewhere");

		const old = (Date.now() - 2 * HOUR) / 1000;
		await utimes(path, old, old);
		await expect(runtime.startSession({ resumeSessionPath: path, clientId: "c1" })).rejects.toThrow("running_elsewhere");
		const { sessionId } = await runtime.startSession({ resumeSessionPath: path, clientId: "c1", takeOver: true });
		expect(runtime.isRunning(sessionId)).toBe(true);
		await runtime.release(sessionId, { clientId: "c1" });

		const fresh = await writeSession(agentDir, cwd, "01a13c00-0000-7000-8000-00000000e102", MID_TOOL);
		setProcesses([]);
		const resumed = await runtime.startSession({ resumeSessionPath: fresh, clientId: "c1" });
		expect(runtime.isRunning(resumed.sessionId)).toBe(true);
		const listed = (await runtime.listSessions({ cwd })).sessions.find((session) => session.id === resumed.sessionId);
		expect(listed?.isRunning).toBe(true);
		expect(listed?.elsewhere).toBeUndefined();
	});

	test("lists what pi processes are in the middle of with the active sessions", async () => {
		const cwd = await workDir();
		const other = await workDir();
		const { runtime, agentDir } = await setup([writer(6161, cwd, Date.now() - 60_000), writer(6262, other, Date.now() - 60_000)]);
		await writeSession(agentDir, cwd, "s-busy", MID_TOOL);
		await writeSession(agentDir, cwd, "s-finished", user("u1", null, "hi") + assistant("a1", "u1", "stop", "done"));
		const stale = await writeSession(agentDir, other, "s-older-than-the-process", MID_TOOL);
		const old = (Date.now() - 2 * HOUR) / 1000;
		await utimes(stale, old, old);

		const active = await runtime.listActiveSessions();
		expect(active.map((session) => [session.id, session.isRunning, session.elsewhere?.state, session.firstMessage])).toEqual([
			["s-busy", false, "running", "count to 20 with sleeps"],
		]);
	});

	test("names the pfs fork a session ran in", async () => {
		const repo = await workDir();
		const fork = join(repo, ".forks", "2");
		await mkdir(fork, { recursive: true });
		const { runtime, agentDir } = await setup([writer(9191, fork, Date.now() - 60_000)]);
		await writeSession(agentDir, fork, "s-fork", MID_TOOL);
		const name = repo.split("/").at(-1);

		expect((await runtime.listActiveSessions()).map((session) => [session.id, session.forkLabel])).toEqual([["s-fork", `${name} · fork 2-probe`]]);
		expect((await runtime.listSessions({ cwd: fork })).sessions[0]?.forkLabel).toBe(`${name} · fork 2-probe`);
		expect((await runtime.listSessions({ cwd: repo })).sessions).toEqual([]);
	});

	test("stops the one pi writing a session and refuses to guess between several", async () => {
		const cwd = await workDir();
		const { runtime, agentDir, stopped, setProcesses } = await setup([writer(7171, cwd)]);
		const path = await writeSession(agentDir, cwd, "s-stop", MID_TOOL);

		await expect(runtime.stopElsewhere("someone-else", path)).rejects.toThrow("session_path_mismatch");
		await expect(runtime.stopElsewhere("s-stop", "/etc/passwd")).rejects.toThrow("session_path_not_allowed");
		expect(await runtime.stopElsewhere("s-stop", path)).toEqual({ stopped: [7171] });
		expect(stopped.map((proc) => proc.pid)).toEqual([7171]);
		expect(await runtime.stopElsewhere("s-stop", path)).toEqual({ stopped: [] });
		expect((await runtime.listSessions({ cwd })).sessions[0]?.elsewhere?.state).toBe("stopped");

		setProcesses([writer(7272, cwd), writer(7373, cwd)]);
		const ambiguous = await runtime.stopElsewhere("s-stop", path).catch((error: unknown) => error);
		expect(ambiguous).toBeInstanceOf(AmbiguousWritersError);
		expect((ambiguous as AmbiguousWritersError).pids).toEqual([7272, 7373]);
	});

	test("follows appended entries and reports when the turn closes or the writer is gone", async () => {
		const cwd = await workDir();
		const { runtime, agentDir, setProcesses } = await setup([writer(8181, cwd)]);
		const id = "s-follow";
		const path = await writeSession(agentDir, cwd, id, MID_TOOL);
		const events: Array<{ event: FollowSseEvent; id?: string }> = [];
		let closed = false;
		const client = { send: (event: FollowSseEvent, eventId?: string) => events.push({ event, id: eventId }), close: () => (closed = true) };

		const { init, cursor, stop } = await runtime.followSession(id, path, client);
		expect(cursor).toBe("a1");
		expect(init).toMatchObject({
			type: "follow_init",
			session: { sessionId: id, path, cwd, model: { provider: "faux", id: "faux-1" } },
			follow: { state: "running", turn: "running_tools", writers: [8181] },
			transcript: { mode: "replace" },
		});
		if (init.type !== "follow_init") throw new Error("expected init");
		expect(init.transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

		await appendFile(path, toolResult("t1", "a1", "call-a1"));
		await waitFor(() => events.some(({ event }) => event.type === "follow_entries"));
		const appended = events.find(({ event }) => event.type === "follow_entries");
		expect(appended?.id).toBe("t1");
		expect(appended?.event.type === "follow_entries" && appended.event.messages.map((message) => [message.role, message.entryId])).toEqual([["toolResult", "t1"]]);
		await waitFor(() => events.some(({ event }) => event.type === "follow_state" && event.follow.turn === "thinking"));

		const closing = assistant("a2", "t1", "stop", "all done");
		await appendFile(path, closing.slice(0, 40));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(events.filter(({ event }) => event.type === "follow_entries")).toHaveLength(1);
		await appendFile(path, closing.slice(40));
		await waitFor(() => events.some(({ id }) => id === "a2"));
		await waitFor(() => events.some(({ event }) => event.type === "follow_state" && event.follow.state === "done"));

		await appendFile(path, user("u2", "a2", "one more") + assistant("a3", "u2", "toolUse"));
		await waitFor(() => events.some(({ event }) => event.type === "follow_state" && event.follow.state === "running" && event.follow.turn === "running_tools" && event.follow.lastWrite !== init.follow.lastWrite));
		setProcesses([]);
		await waitFor(() => events.some(({ event }) => event.type === "follow_state" && event.follow.state === "stopped"), 5_000);
		stop();
		expect(closed).toBe(false);

		const again = await runtime.followSession(id, path, client, "a1");
		if (again.init.type !== "follow_init") throw new Error("expected init");
		expect(again.init.transcript.mode).toBe("append");
		again.stop();
		await expect(runtime.followSession("other-id", path, client)).rejects.toThrow("session_path_mismatch");
	});
});
