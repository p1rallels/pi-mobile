import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tildify, type Presence } from "../src/msg-lineage.ts";
import { sessionDirForCwd } from "../src/session-index.ts";
import { PiWebRuntime, type SessionClient } from "../src/session-runtime.ts";
import type { ApiLineage, ApiRelayState, FollowSseEvent, SseEvent } from "../src/types.ts";
import { agentEventTypes, cleanupAgentDirs, makeAgentDir, startFauxSession, waitFor, type SseFrame } from "./support/faux_runtime.ts";

const runtimes: PiWebRuntime[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown(500)));
	await cleanupAgentDirs();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const LEAD = "01a152a0-f00d-72aa-a896-d904c458282b";
const SCOUT = "01a15313-9bae-71f9-ad24-c0699b0485dc";
const FLAKY = "01a15313-9d00-763a-b50b-903716d1698d";
const WORKER = "01a15313-9e4e-72d8-9b42-450d6296524e";

/** Writes a presence record the way msg does: a temp file renamed into place. */
async function writePresence(store: string, record: Partial<Presence> & { id: string }): Promise<void> {
	const dir = join(store, "sessions");
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `.${record.id}.json.${process.pid}.tmp`);
	const now = Date.now();
	await writeFile(temp, JSON.stringify({ v: 1, cwd: "/repo", pid: 100, mode: "print", activity: "busy", startedAt: now - 10_000, heartbeatAt: now, ...record }));
	await rename(temp, join(dir, `${record.id}.json`));
}

/** A relay-like extension: a nudge after the first turn, a reset after the second, and /loop switches its loop on. */
const RELAY_PROBE = `
export default function relayProbe(pi) {
	let turns = 0;
	pi.on("turn_end", () => {
		turns += 1;
		if (turns === 1) {
			return { entries: [{ type: "custom_message", customType: "relay", content: "[relay] you're at 41.5%", display: true, details: { kind: "nudge", percent: 41.5, step: 40 } }] };
		}
		if (turns === 2) {
			return {
				entries: [
					{ type: "compaction", summary: "fresh start", firstKeptEntryId: null, details: { relay: { n: 1, percent: 45, note: "go on" } } },
					{ type: "custom_message", customType: "relay", content: "[relay] context reset #1", display: true, details: { kind: "reset", n: 1, percent: 45, note: "go on" } },
				],
			};
		}
		return undefined;
	});
	pi.registerCommand("loop", { handler: async (args) => pi.appendEntry("relay", { loop: "on", goal: args, by: "user" }) });
}
`;

function viewer(connectionId: string): { client: SessionClient; frames: SseFrame[] } {
	const frames: SseFrame[] = [];
	return { frames, client: { connectionId, clientId: connectionId, send: (event, id) => frames.push({ event, id }), close() {} } };
}

const lineagePatches = (events: SseEvent[]): Array<ApiLineage | null> =>
	events.flatMap((event) => (event.type === "state_patch" && event.patch.lineage !== undefined ? [event.patch.lineage] : []));

const relayPatches = (events: SseEvent[]): Array<ApiRelayState | null> =>
	events.flatMap((event) => (event.type === "state_patch" && event.patch.relay !== undefined ? [event.patch.relay] : []));

const states = (lineage: ApiLineage | null | undefined) => lineage?.children.map((child) => `${child.label}:${child.state}`);

describe("a hosted session's header", () => {
	test("its children from msg's store as they come and go, never a parent, and relay as it nudges, resets and loops", async () => {
		const alive = new Set([100]);
		const { runtime, sessionId, clientId, events, agentDir } = await startFauxSession([fauxAssistantMessage("one"), fauxAssistantMessage("two")], {
			extensions: { "relay-probe.ts": RELAY_PROBE },
			runtime: { lineageRefreshMs: 20, pidAlive: (pid) => alive.has(pid) },
		});
		runtimes.push(runtime);
		const store = join(agentDir, "msg");
		// pi-web hosts it, so it has no parent, whatever an old record of it says
		await writePresence(store, { id: sessionId, mode: "web", parent: LEAD });
		await writePresence(store, { id: SCOUT, parent: sessionId, name: "scout", cwd: join(agentDir, "scout"), startedAt: Date.now() - 5_000 });
		await writePresence(store, { id: FLAKY, parent: sessionId, name: "flaky", pid: 200, startedAt: Date.now() - 4_000 });
		const scoutDir = sessionDirForCwd(join(agentDir, "sessions"), join(agentDir, "scout"));
		await mkdir(scoutDir, { recursive: true });
		await writeFile(join(scoutDir, `2026-10-19T06-00-00-000Z_${SCOUT}.jsonl`), "{}\n");

		const second = viewer("connection-2");
		const { init } = runtime.connectClient(sessionId, second.client);
		expect(init.state.relay).toBeNull();
		await waitFor(() => lineagePatches(events).length > 0);
		const first = lineagePatches(events)[0];
		expect(first).toEqual({
			parent: null,
			children: [
				{ id: SCOUT, label: "scout", state: "live", openable: true, where: `pi -p · ${tildify(join(agentDir, "scout"), homedir())}` },
				{ id: FLAKY, label: "flaky", state: "died", openable: false, where: "pi -p · /repo" },
			],
			childCount: 2,
		});
		// every viewer gets it, and a viewer that connects later starts with it
		expect(lineagePatches(second.frames.map(({ event }) => event))).toEqual([first]);
		expect(runtime.connectClient(sessionId, viewer("connection-3").client).init.state.lineage).toEqual(first);

		await writePresence(store, { id: SCOUT, parent: sessionId, name: "scout", cwd: join(agentDir, "scout"), startedAt: Date.now() - 5_000, endedAt: Date.now() });
		await writePresence(store, { id: WORKER, parent: sessionId, name: "worker", startedAt: Date.now() });
		await waitFor(() => states(lineagePatches(events).at(-1))?.join() === "flaky:died,worker:live,scout:ended");
		const before = lineagePatches(events).length;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(lineagePatches(events)).toHaveLength(before);

		const settled = () => agentEventTypes(events).filter((type) => type === "agent_settled").length;
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "first" });
		await waitFor(() => settled() === 1);
		await waitFor(() => relayPatches(events).length === 1);
		expect(relayPatches(events)).toEqual([{ resets: 0, loop: false, goal: null, nudge: 41.5 }]);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "second" });
		await waitFor(() => settled() === 2);
		await waitFor(() => relayPatches(events).length === 2);
		expect(relayPatches(events)[1]).toEqual({ resets: 1, loop: false, goal: null, nudge: null });

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "/loop ship the lineage pill" });
		await waitFor(() => relayPatches(events).length === 3);
		expect(relayPatches(events)[2]).toEqual({ resets: 1, loop: true, goal: "ship the lineage pill", nudge: null });
		expect(runtime.connectClient(sessionId, viewer("connection-4").client).init.state.relay).toEqual({ resets: 1, loop: true, goal: "ship the lineage pill", nudge: null });
	});
});

describe("a session another pi writes", () => {
	test("says whose child it is and what relay did, and a child it starts shows up without a new entry", async () => {
		const agentDir = await makeAgentDir();
		const work = await mkdtemp(join(await realpath(tmpdir()), "pi-web-lineage-follow-"));
		tempDirs.push(work);
		const store = join(work, "msg");
		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		const runtime = new PiWebRuntime({
			modelRuntime,
			followPollMs: 20,
			processCacheMs: 0,
			listPiProcesses: async () => [{ pid: 300, pgid: 300, command: "pi", cwd: work, startedAtMs: Date.now() - 60_000 }],
			msgDir: store,
			lineageRefreshMs: 20,
			pidAlive: (pid) => pid === 100 || pid === 300,
		});
		runtimes.push(runtime);
		const dir = sessionDirForCwd(join(agentDir, "sessions"), work);
		await mkdir(dir, { recursive: true });
		const path = join(dir, `2026-10-19T06-00-00-000Z_${WORKER}.jsonl`);
		const entries = [
			{ type: "session", version: 3, id: WORKER, timestamp: new Date().toISOString(), cwd: work },
			{ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 } },
			{ type: "compaction", id: "c1", parentId: "u1", timestamp: new Date().toISOString(), summary: "reset", firstKeptEntryId: "c1", tokensBefore: 1, details: { relay: { n: 1, percent: 45 } } },
			{ type: "custom", id: "l1", parentId: "c1", timestamp: new Date().toISOString(), customType: "relay", data: { loop: "on", goal: "finish", by: "launch" } },
			{ type: "message", id: "u2", parentId: "l1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 } },
		];
		await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		await writePresence(store, { id: LEAD, mode: "web", name: "main", cwd: "/Users/me/Desktop/cc" });
		await writePresence(store, { id: WORKER, parent: LEAD, name: "worker", cwd: work, pid: 300 });

		const events: FollowSseEvent[] = [];
		const { init, stop } = await runtime.followSession(WORKER, path, { send: (event) => events.push(event), close() {} });
		expect(init.type === "follow_init" && init.session.relay).toEqual({ resets: 1, loop: true, goal: "finish", nudge: null });
		const described = () => events.flatMap((event) => (event.type === "follow_entries" ? [event] : []));
		await waitFor(() => described().some((event) => event.session.lineage?.parent?.label === "main"));
		const parentFirst = described().find((event) => event.session.lineage?.parent);
		expect(parentFirst?.messages).toEqual([]);
		expect(parentFirst?.session.lineage).toEqual({
			parent: { id: LEAD, label: "main", state: "live", openable: false, where: "pi-web · /Users/me/Desktop/cc" },
			children: [],
			childCount: 0,
		});

		await writePresence(store, { id: FLAKY, parent: WORKER, name: "sub", pid: 999 });
		await waitFor(() => described().some((event) => event.session.lineage?.childCount === 1));
		expect(described().at(-1)?.session.lineage?.children).toEqual([{ id: FLAKY, label: "sub", state: "died", openable: false, where: "pi -p · /repo" }]);
		stop();
	});
});
