import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLineageFeed,
	createPresenceIndex,
	createSessionFiles,
	orderChildren,
	parentParty,
	presenceState,
	whereOf,
	type JudgedPresence,
} from "../src/msg-lineage.ts";
import { STALE_AFTER_MS, type Presence } from "../src/msg-store.ts";
import type { ApiLineage } from "../src/types.ts";

const NOW = 1_792_395_160_000;
const LEAD = "01a152a0-f00d-72aa-a896-d904c458282b";
const DIED = "01a15313-9bae-71f9-ad24-c0699b0485dc";
const MAIL = "01a15313-9d00-763a-b50b-903716d1698d";
const PILL = "01a15313-9e4e-72d8-9b42-450d6296524e";

const presence = (fields: Partial<Presence> & { id: string }): Presence => ({
	cwd: "/repo",
	pid: 100,
	mode: "print",
	activity: "busy",
	startedAt: NOW - 60_000,
	heartbeatAt: NOW - 1_000,
	...fields,
});

describe("msg's lineage", () => {
	test("a session is live, ended, died or offline", () => {
		const alive = (pid: number) => pid === 100;
		expect(presenceState(presence({ id: PILL }), NOW, alive)).toBe("live");
		expect(presenceState(presence({ id: PILL, endedAt: NOW - 5 }), NOW, alive)).toBe("ended");
		expect(presenceState(presence({ id: PILL, pid: 101 }), NOW, alive)).toBe("died");
		expect(presenceState(presence({ id: PILL, heartbeatAt: NOW - STALE_AFTER_MS - 1 }), NOW, alive)).toBe("offline");
		expect(presenceState(presence({ id: PILL, heartbeatAt: NOW - STALE_AFTER_MS }), NOW, alive)).toBe("live");
		// an ended session says so even if its pid runs on (pi-web's own sessions share its pid)
		expect(presenceState(presence({ id: PILL, endedAt: NOW, heartbeatAt: NOW - 999_999 }), NOW, alive)).toBe("ended");
	});

	test("children list the ones still around in the order they started, then the ended ones, latest first", () => {
		const judged = (id: string, state: JudgedPresence["state"], startedAt: number, endedAt?: number): JudgedPresence => ({
			record: presence({ id, startedAt, ...(endedAt === undefined ? {} : { endedAt }) }),
			state,
		});
		const order = orderChildren([
			judged("e-old", "ended", 1, 10),
			judged("c", "live", 30),
			judged("e-new", "ended", 2, 20),
			judged("a", "died", 10),
			judged("b", "offline", 20),
		]).map((child) => child.record.id);
		expect(order).toEqual(["a", "b", "c", "e-new", "e-old"]);
	});

	test("say where a session runs, and name a parent by its folder when it has no name", () => {
		expect(whereOf(presence({ id: PILL, cwd: "/Users/me/.pfs/forks/pi-web/2" }), "/Users/me")).toBe("pi -p · ~/.pfs/forks/pi-web/2");
		expect(whereOf(presence({ id: PILL, mode: "tui", cwd: "/elsewhere" }), "/Users/me")).toBe("pi · /elsewhere");
		expect(parentParty(LEAD, presence({ id: LEAD, cwd: "/Users/me/Desktop/cc", mode: "web" }), "live", true, "/Users/me")).toEqual({
			id: LEAD,
			label: "cc",
			state: "live",
			openable: true,
			where: "pi-web · ~/Desktop/cc",
		});
		expect(parentParty(LEAD, presence({ id: LEAD, name: "main" }), "live", true, "/h").label).toBe("main");
		expect(parentParty(LEAD, undefined, null, false, "/h")).toEqual({ id: LEAD, label: "01a152a0", state: null, openable: false, where: null });
	});
});

let root = "";
beforeEach(async () => {
	root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-lineage-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Writes a record the way msg does: a temp file renamed into place. */
async function writeRecord(store: string, record: Presence): Promise<void> {
	const dir = join(store, "sessions");
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `.${record.id}.json.${process.pid}.tmp`);
	await writeFile(temp, JSON.stringify({ v: 1, ...record }));
	await rename(temp, join(dir, `${record.id}.json`));
}

async function writeSessionFile(sessionsDir: string, cwd: string, id: string): Promise<void> {
	const dir = join(sessionsDir, `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `2026-10-19T06-00-00-000Z_${id}.jsonl`), "{}\n");
}

describe("the presence index", () => {
	test("reads every record once, then only the ones that change, and forgets removed ones", async () => {
		const store = join(root, "msg");
		const index = createPresenceIndex(store);
		await index.refresh();
		expect(index.size()).toBe(0);

		await writeRecord(store, presence({ id: LEAD, mode: "web" }));
		await writeRecord(store, presence({ id: DIED, parent: LEAD, name: "died" }));
		await writeRecord(store, presence({ id: MAIL, parent: LEAD, name: "mail-wakes" }));
		await writeFile(join(store, "sessions", "broken.json"), "{not json");
		await index.refresh();
		expect(index.size()).toBe(3);
		expect(index.record(MAIL)?.name).toBe("mail-wakes");
		expect(index.childrenOf(LEAD).map((child) => child.id).sort()).toEqual([DIED, MAIL].sort());

		await writeRecord(store, presence({ id: MAIL, parent: LEAD, name: "mail-wakes", endedAt: NOW }));
		await rm(join(store, "sessions", `${DIED}.json`));
		await index.refresh();
		expect(index.record(MAIL)?.endedAt).toBe(NOW);
		expect(index.record(DIED)).toBeUndefined();
		expect(index.childrenOf(LEAD).map((child) => child.id)).toEqual([MAIL]);

		await rm(join(store, "sessions"), { recursive: true });
		await index.refresh();
		expect(index.size()).toBe(0);
	});

	test("looks no further than the folder while nothing was renamed into it, and at every file's mtime every 30s anyway", async () => {
		const store = join(root, "msg");
		let now = NOW;
		const index = createPresenceIndex(store, () => now);
		await writeRecord(store, presence({ id: MAIL, name: "mail-wakes" }));
		await index.refresh();
		// written in place, not the way msg writes: the folder doesn't change, so the index doesn't look
		await writeFile(join(store, "sessions", `${MAIL}.json`), JSON.stringify({ v: 1, ...presence({ id: MAIL, name: "renamed" }) }));
		await index.refresh();
		expect(index.record(MAIL)?.name).toBe("mail-wakes");
		now += 30_000;
		await index.refresh();
		expect(index.record(MAIL)?.name).toBe("renamed");
	});
});

describe("session files", () => {
	test("found in the folder pi keeps the session's cwd in, or anywhere for a session nobody recorded", async () => {
		const sessionsDir = join(root, "sessions");
		const files = createSessionFiles(sessionsDir);
		expect(await files.has("/repo", LEAD)).toBe(false);
		await writeSessionFile(sessionsDir, "/repo", LEAD);
		expect(await files.has("/repo", LEAD)).toBe(true);
		expect(await files.has("/repo", MAIL)).toBe(false);
		await writeSessionFile(sessionsDir, "/repo/.forks/1", MAIL);
		expect(await files.has("/elsewhere", MAIL)).toBe(false);
		expect(await files.anywhere(MAIL)).toBe(true);
		expect(await files.anywhere(PILL)).toBe(false);
	});
});

describe("the lineage feed", () => {
	async function setup(alive: Set<number>, hosted = new Set<string>()) {
		const store = join(root, "msg");
		const sessionsDir = join(root, "sessions");
		const changes: Array<[string, ApiLineage | null]> = [];
		const watched = new Set<string>();
		let now = NOW;
		const feed = createLineageFeed({
			root: store,
			sessionsDir,
			isHosted: (id) => hosted.has(id),
			watched: () => watched,
			onChange: (id, lineage) => changes.push([id, lineage]),
			probe: (pid) => alive.has(pid),
			clock: () => now,
			home: root,
			intervalMs: 60_000,
		});
		return { store, sessionsDir, changes, watched, feed, now: () => now, advance: (ms: number) => (now += ms) };
	}

	test("a hosted session's children with their states, links where pi-web has the file, and changes as they happen", async () => {
		const { store, sessionsDir, changes, watched, feed } = await setup(new Set([100, 200]), new Set([LEAD]));
		await writeRecord(store, presence({ id: LEAD, mode: "web", cwd: join(root, "cc"), parent: "01a1527c-6933-72aa-a896-d903640a3fa2" }));
		await writeRecord(store, presence({ id: DIED, parent: LEAD, name: "died", cwd: join(root, "msg-cli"), pid: 100, startedAt: NOW - 3_000 }));
		await writeRecord(store, presence({ id: MAIL, parent: LEAD, name: "mail-wakes", cwd: join(root, "f1"), pid: 999, startedAt: NOW - 2_000 }));
		await writeSessionFile(sessionsDir, join(root, "msg-cli"), DIED);

		watched.add(LEAD);
		await feed.refresh();
		const first = feed.current(LEAD);
		// pi-web hosts it: its process is pi-web's, so it has no parent whatever its record says
		expect(first).toEqual({
			parent: null,
			children: [
				{ id: DIED, label: "died", state: "live", openable: true, where: "pi -p · ~/msg-cli" },
				{ id: MAIL, label: "mail-wakes", state: "died", openable: false, where: "pi -p · ~/f1" },
			],
			childCount: 2,
		});
		expect(changes).toEqual([[LEAD, first ?? null]]);

		await feed.refresh();
		expect(changes).toHaveLength(1);

		await writeRecord(store, presence({ id: PILL, parent: LEAD, name: "lineage-pill", cwd: join(root, "f2"), pid: 200, startedAt: NOW - 1_000 }));
		await writeRecord(store, presence({ id: DIED, parent: LEAD, name: "died", cwd: join(root, "msg-cli"), pid: 100, startedAt: NOW - 3_000, endedAt: NOW }));
		await feed.refresh();
		expect(changes).toHaveLength(2);
		expect(feed.current(LEAD)?.children.map((child) => `${child.label}:${child.state}`)).toEqual(["mail-wakes:died", "lineage-pill:live", "died:ended"]);
		expect(feed.current(LEAD)?.childCount).toBe(3);
		feed.stop();
	});

	test("a followed child says whose child it is, a parent without a record still shows, and sessions nobody watches aren't read", async () => {
		const { store, sessionsDir, changes, watched, feed, now, advance } = await setup(new Set([100]));
		await writeRecord(store, presence({ id: PILL, parent: LEAD, name: "lineage-pill", pid: 100 }));
		await feed.refresh();
		expect(feed.current(PILL)).toBeUndefined();
		expect(changes).toEqual([]);

		watched.add(PILL);
		await feed.refresh();
		expect(feed.current(PILL)).toEqual({
			parent: { id: LEAD, label: "01a152a0", state: null, openable: false, where: null },
			children: [],
			childCount: 0,
		});

		// the parent's file shows up in some folder: once the miss is old enough, it's looked for again
		await writeSessionFile(sessionsDir, "/somewhere", LEAD);
		await feed.refresh();
		expect(feed.current(PILL)?.parent?.openable).toBe(false);
		advance(61_000);
		await feed.refresh();
		expect(feed.current(PILL)?.parent?.openable).toBe(true);

		await writeRecord(store, presence({ id: LEAD, mode: "web", name: "main", pid: 100, heartbeatAt: now() }));
		await feed.refresh();
		expect(feed.current(PILL)?.parent).toMatchObject({ label: "main", state: "live", where: "pi-web · /repo" });

		// its heartbeat goes stale while the process lives on: offline
		advance(STALE_AFTER_MS + 1);
		await feed.refresh();
		expect(feed.current(PILL)?.parent?.state).toBe("offline");
		feed.stop();
	});

	test("lists the first few children and counts them all; no family is null", async () => {
		const { store, watched, feed } = await setup(new Set([100]));
		watched.add(LEAD);
		await feed.refresh();
		expect(feed.current(LEAD)).toBeNull();
		for (let n = 0; n < 11; n += 1) {
			await writeRecord(store, presence({ id: `child-${String(n).padStart(2, "0")}`, parent: LEAD, pid: 100, startedAt: NOW - 100 + n }));
		}
		await feed.refresh();
		const lineage = feed.current(LEAD);
		expect(lineage?.childCount).toBe(11);
		expect(lineage?.children.map((child) => child.label)).toEqual(["child-00", "child-01", "child-02", "child-03", "child-04", "child-05", "child-06", "child-07"]);
		feed.stop();
	});
});
