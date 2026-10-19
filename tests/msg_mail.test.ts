import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	freeSlots,
	isMailboxId,
	MAX_REOPENS_PER_LOOK,
	msgStoreRoot,
	newestMessage,
	newMailDir,
	ownedElsewhere,
	parsePresence,
	planMailReopens,
	presencePath,
	PRESENCE_STALE_MS,
	waitingMail,
	watchMsgMail,
	type DetachedRef,
	type MailHost,
	type MailInput,
	type MailReopen,
	type ProbedPresence,
	type Room,
	type RunningRef,
} from "../src/msg-mail.ts";

const NOW = Date.parse("2026-10-19T08:00:00.000Z");
const SELF = 4242;
const OTHER = 5151;
const [A, B, C, D, E, F] = ["a", "b", "c", "d", "e", "f"].map((tag) => `01a1a000-0000-7000-8000-00000000000${tag}`) as [string, string, string, string, string, string];
const M1 = "0mv962x7a-111111";
const M2 = "0mv962x7b-222222";
const M3 = "0mv962x7c-333333";

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const pathOf = (sessionId: string) => `/agent/sessions/--repo--/2026-10-19T07-00-00-000Z_${sessionId}.jsonl`;
const ref = (sessionId: string): DetachedRef => ({ sessionId, path: pathOf(sessionId) });
const files = (...ids: string[]) => ids.map((id) => `${id}.json`);
const slot = (sessionId: string, fields: Partial<RunningRef> = {}): RunningRef => ({ sessionId, path: pathOf(sessionId), evictable: true, lastActivityAtMs: NOW, ...fields });
const live = (fields: Partial<ProbedPresence> = {}): ProbedPresence => ({ pid: OTHER, heartbeatAt: NOW - 1_000, pidAlive: true, ...fields });

function input(fields: Partial<MailInput> & { detached: DetachedRef[] }): MailInput {
	return {
		inbox: new Map(),
		reopenedFor: new Map(),
		unchanged: new Set(fields.detached.map((item) => item.sessionId)),
		presence: new Map(),
		room: { max: 24, running: [], resuming: [] },
		selfPid: SELF,
		now: NOW,
		...fields,
	};
}

describe("msg's store as pi-web reads it", () => {
	test("the root is msg's: PI_MSG_DIR, else PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg", () => {
		expect(msgStoreRoot({}, "/home/me")).toBe("/home/me/.pi/agent/msg");
		expect(msgStoreRoot({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/me")).toBe("/tmp/agent/msg");
		expect(msgStoreRoot({ PI_CODING_AGENT_DIR: " ~/agent " }, "/home/me")).toBe("/home/me/agent/msg");
		expect(msgStoreRoot({ PI_MSG_DIR: "~/mail", PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/me")).toBe("/home/me/mail");
		expect(msgStoreRoot({ PI_MSG_DIR: "  ", PI_CODING_AGENT_DIR: "~" }, "/home/me")).toBe("/home/me/msg");
	});

	test("inboxes and presence records sit under the root by session id, and ids msg wouldn't take name none", () => {
		expect(newMailDir("/r", A)).toBe(`/r/inbox/${A}/new`);
		expect(presencePath("/r", A)).toBe(`/r/sessions/${A}.json`);
		expect(isMailboxId(A)).toBe(true);
		for (const id of ["", "../x", "a/b", ".hidden", "a..b", "x".repeat(129)]) expect(isMailboxId(id)).toBe(false);
	});

	test("the newest message is the last id in new/, with temp files and other names aside", () => {
		expect(newestMessage(undefined)).toBeNull();
		expect(newestMessage([])).toBeNull();
		expect(newestMessage([`.${M3}.json.123.abcd1234.tmp`, "notes.txt"])).toBeNull();
		expect(newestMessage([...files(M2, M1), `.${M3}.json.123.abcd1234.tmp`, "notes.txt"])).toBe(M2);
	});

	test("a presence record counts only as msg's parser takes it, and only for its own session", () => {
		const record = { v: 1, id: A, cwd: "/repo", pid: OTHER, mode: "web", activity: "idle", startedAt: NOW - 60_000, heartbeatAt: NOW - 1_000 };
		expect(parsePresence(record, A)).toEqual({ pid: OTHER, heartbeatAt: NOW - 1_000 });
		expect(parsePresence({ ...record, endedAt: NOW }, A)).toEqual({ pid: OTHER, heartbeatAt: NOW - 1_000, endedAt: NOW });
		expect(parsePresence(record, B)).toBeNull();
		for (const broken of [{ ...record, v: 2 }, { ...record, heartbeatAt: "now" }, { ...record, startedAt: undefined }, { ...record, pid: null }, [record], null, "x"]) {
			expect(parsePresence(broken, A)).toBeNull();
		}
	});

	test("another process runs a session while its record is live there: not ended, a fresh heartbeat, a running pid that isn't this server", () => {
		expect(ownedElsewhere(live(), SELF, NOW)).toBe(true);
		expect(ownedElsewhere(live({ heartbeatAt: NOW - PRESENCE_STALE_MS }), SELF, NOW)).toBe(true);
		expect(ownedElsewhere(undefined, SELF, NOW)).toBe(false);
		expect(ownedElsewhere(live({ endedAt: NOW - 500 }), SELF, NOW)).toBe(false);
		expect(ownedElsewhere(live({ heartbeatAt: NOW - PRESENCE_STALE_MS - 1 }), SELF, NOW)).toBe(false);
		expect(ownedElsewhere(live({ pidAlive: false }), SELF, NOW)).toBe(false);
		expect(ownedElsewhere(live({ pid: SELF }), SELF, NOW)).toBe(false);
	});
});

describe("which detached sessions mail brings back", () => {
	test("mail newer than the last reopen counts, oldest first, each session once", () => {
		const detached = [ref(A), ref(B), ref(C), ref(D), { sessionId: A, path: "/elsewhere/a.jsonl" }];
		const inbox = new Map([
			[A, files(M1, M3)],
			[B, files(M2)],
			[C, []],
		]);
		expect(waitingMail(detached, inbox, new Map())).toEqual([
			{ ...ref(B), newest: M2 },
			{ ...ref(A), newest: M3 },
		]);
		expect(waitingMail(detached, inbox, new Map([[A, M3]]))).toEqual([{ ...ref(B), newest: M2 }]);
		expect(waitingMail(detached, inbox, new Map([[A, M1]]))).toEqual([
			{ ...ref(B), newest: M2 },
			{ ...ref(A), newest: M3 },
		]);
	});

	test("a detached session with mail comes back into a free slot", () => {
		const plan = planMailReopens(input({ detached: [ref(A), ref(B)], inbox: new Map([[A, files(M1)], [B, []]]) }));
		expect(plan).toEqual({ reopen: [{ ...ref(A), newest: M1, evict: null }], noRoom: [], skipped: [] });
	});

	test("never one running or resuming here, one whose file changed since it was disposed, or one another live process runs", () => {
		const detached = [A, B, C, D, E, F].map(ref);
		const plan = planMailReopens(
			input({
				detached,
				inbox: new Map(detached.map((item) => [item.sessionId, files(M1)])),
				unchanged: new Set([A, B, D, E, F]),
				presence: new Map([
					[D, live()],
					[E, live({ pid: SELF })],
					[F, live({ endedAt: NOW - 10 })],
				]),
				room: { max: 24, running: [slot(A, { path: "/moved/a.jsonl" })], resuming: [pathOf(B)] },
			}),
		);
		expect(plan.skipped.map((item) => [item.sessionId, item.reason])).toEqual([
			[A, "hosted"],
			[B, "hosted"],
			[C, "changed"],
			[D, "owned"],
		]);
		expect(plan.reopen.map((item) => item.sessionId)).toEqual([E, F]);
	});

	test("at the cap, an idle unwatched session without mail gives up its slot, least recently active first; the rest waits", () => {
		const room: Room = {
			max: 5,
			running: [
				slot("v-recent", { lastActivityAtMs: NOW - 100 }),
				slot("v-old", { lastActivityAtMs: NOW - 900 }),
				slot("watched", { evictable: false, lastActivityAtMs: NOW - 5_000 }),
				slot("has-mail", { lastActivityAtMs: NOW - 5_000 }),
				slot("unlisted", { lastActivityAtMs: NOW - 5_000 }),
			],
			resuming: [],
		};
		const inbox = new Map([
			[A, files(M1)],
			[B, files(M2)],
			[C, files(M3)],
			["v-recent", []],
			["v-old", ["notes.txt"]],
			["watched", []],
			["has-mail", files(M1)],
		]);
		const plan = planMailReopens(input({ detached: [ref(C), ref(B), ref(A)], inbox, room }));
		expect(plan.reopen.map((item) => [item.sessionId, item.evict])).toEqual([
			[A, "v-old"],
			[B, "v-recent"],
		]);
		expect(plan.noRoom.map((item) => item.sessionId)).toEqual([C]);
	});

	test("two sessions with mail never take each other's slot", () => {
		const plan = planMailReopens(
			input({
				detached: [ref(A)],
				inbox: new Map([
					[A, files(M2)],
					[B, files(M1)],
				]),
				room: { max: 1, running: [slot(B)], resuming: [] },
			}),
		);
		expect(plan.reopen).toEqual([]);
		expect(plan.noRoom).toEqual([{ ...ref(A), newest: M2 }]);
	});

	test("free slots leave room for resumes under way, and run out before the evictions start", () => {
		expect(freeSlots({ max: 2, running: [slot(C)], resuming: ["/x.jsonl"] })).toBe(0);
		expect(freeSlots({ max: 1, running: [slot(C), slot(D)], resuming: [] })).toBe(0);
		const plan = planMailReopens(
			input({
				detached: [ref(A), ref(B)],
				inbox: new Map([
					[A, files(M1)],
					[B, files(M2)],
					[C, []],
				]),
				room: { max: 3, running: [slot(C)], resuming: ["/x.jsonl"] },
			}),
		);
		expect(plan.reopen.map((item) => [item.sessionId, item.evict])).toEqual([
			[A, null],
			[B, C],
		]);
	});
});

/** A message dropped into a session's inbox the way msg delivers it: written to tmp/, renamed into new/. */
async function deliver(root: string, sessionId: string, id: string): Promise<void> {
	const box = join(root, "inbox", sessionId);
	await mkdir(join(box, "tmp"), { recursive: true });
	await mkdir(join(box, "new"), { recursive: true });
	const tmp = join(box, "tmp", `.${id}.json.${String(process.pid)}.abcd1234.tmp`);
	await writeFile(tmp, `${JSON.stringify({ v: 1, id, ts: NOW, from: { id: "sender" }, to: sessionId, text: "hello", delivery: "steer" })}\n`);
	await rename(tmp, join(box, "new", `${id}.json`));
}

/** A runtime stand-in: sessions move between detached and running, and reopens take a slot like resumeSession does. */
function fakeHost(options: { max?: number; decline?: number; fail?: string } = {}) {
	const detached = new Map<string, DetachedRef>();
	const running = new Map<string, RunningRef>();
	const changed = new Set<string>();
	const calls: Array<[string, string | null]> = [];
	let declines = options.decline ?? 0;
	const host: MailHost = {
		detachedSessions: () => [...detached.values()],
		sessionRoom: () => ({ max: options.max ?? 24, running: [...running.values()], resuming: [] }),
		isUnchangedSinceDetach: (_path, sessionId) => !changed.has(sessionId),
		reopenForMail(sessionId, path, evict): MailReopen | null {
			calls.push([sessionId, evict]);
			if (declines > 0) {
				declines -= 1;
				return null;
			}
			if (options.fail) return { evicted: null, running: Promise.reject(new Error(options.fail)) };
			if (evict) {
				running.delete(evict);
				detached.set(evict, ref(evict));
			}
			detached.delete(sessionId);
			running.set(sessionId, { sessionId, path, evictable: true, lastActivityAtMs: NOW });
			return { evicted: evict, running: Promise.resolve() };
		},
	};
	const dispose = (sessionId: string) => {
		running.delete(sessionId);
		detached.set(sessionId, ref(sessionId));
	};
	return { host, detached, running, changed, calls, dispose };
}

async function storeRoot(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-msg-mail-"));
	tempDirs.push(dir);
	return join(dir, "msg");
}

describe("the msg mail watch", () => {
	test("reopens a disposed session once per newest message and says so, and only ever lists the store", async () => {
		const root = await storeRoot();
		const { host, detached, running, calls, dispose } = fakeHost();
		detached.set(A, ref(A));
		const lines: string[] = [];
		const watch = watchMsgMail(host, { root, intervalMs: 60_000, log: (line) => lines.push(line) });
		try {
			await watch.sweep();
			expect(calls).toEqual([]);

			await deliver(root, A, M1);
			await watch.sweep();
			expect(calls).toEqual([[A, null]]);
			expect(running.has(A)).toBe(true);
			expect(lines).toEqual([`[pi-web] reopened ${A} for msg mail`]);

			// nothing here claims it (no msg), and the session is disposed again: the same mail doesn't bring it back
			dispose(A);
			await watch.sweep();
			await watch.sweep();
			expect(calls).toHaveLength(1);

			await deliver(root, A, M2);
			await watch.sweep();
			expect(calls).toEqual([
				[A, null],
				[A, null],
			]);
			expect((await readdir(join(root, "inbox", A, "new"))).sort()).toEqual(files(M1, M2));
			expect(await readdir(join(root, "inbox", A, "tmp"))).toEqual([]);
			expect((await readdir(join(root, "inbox", A))).sort()).toEqual(["new", "tmp"]);
			expect(JSON.parse(await readFile(join(root, "inbox", A, "new", `${M1}.json`), "utf8"))).toMatchObject({ id: M1, text: "hello" });
		} finally {
			watch.stop();
		}
	});

	test("says once per newest message why mail waits: no room, a file changed since, another process", async () => {
		const root = await storeRoot();
		const { host, detached, running, changed, calls } = fakeHost({ max: 1 });
		running.set(B, slot(B));
		for (const id of [A, C, D]) detached.set(id, ref(id));
		changed.add(C);
		await mkdir(join(root, "sessions"), { recursive: true });
		await writeFile(presencePath(root, D), JSON.stringify({ v: 1, id: D, cwd: "/repo", pid: OTHER, mode: "tui", activity: "idle", startedAt: NOW, heartbeatAt: Date.now() }));
		for (const id of [A, B, C, D]) await deliver(root, id, M1);
		const lines: string[] = [];
		const watch = watchMsgMail(host, { root, intervalMs: 60_000, log: (line) => lines.push(line), pidAlive: (pid) => pid === OTHER });
		try {
			await watch.sweep();
			await watch.sweep();
			expect(calls).toEqual([]);
			expect(lines.sort()).toEqual([
				`[pi-web] no room to reopen ${A} for msg mail: 1 of 1 sessions running, none idle, unwatched and without mail of its own; the mail waits`,
				`[pi-web] not reopening ${C} for msg mail: its file changed since pi-web disposed it`,
				`[pi-web] not reopening ${D} for msg mail: pid ${String(OTHER)} runs it`,
			]);

			// B's mail is taken (its msg claimed it): its slot goes to A
			await rm(join(root, "inbox", B, "new", `${M1}.json`));
			await watch.sweep();
			expect(calls).toEqual([[A, B]]);
			expect(lines.slice(-2)).toEqual([`[pi-web] disposed idle session ${B} to make room for msg mail`, `[pi-web] reopened ${A} for msg mail`]);
		} finally {
			watch.stop();
		}
	});

	test("a reopen the runtime turns down comes back on the next look; a failed one is said once and not retried for that mail", async () => {
		const root = await storeRoot();
		const declined = fakeHost({ decline: 1 });
		declined.detached.set(A, ref(A));
		await deliver(root, A, M1);
		const lines: string[] = [];
		const first = watchMsgMail(declined.host, { root, intervalMs: 60_000, log: (line) => lines.push(line) });
		await first.sweep();
		await first.sweep();
		first.stop();
		expect(declined.calls).toEqual([
			[A, null],
			[A, null],
		]);
		expect(lines).toEqual([`[pi-web] reopened ${A} for msg mail`]);

		const failing = fakeHost({ fail: "Project trust required" });
		failing.detached.set(A, ref(A));
		lines.length = 0;
		const second = watchMsgMail(failing.host, { root, intervalMs: 60_000, log: (line) => lines.push(line) });
		await second.sweep();
		await second.sweep();
		second.stop();
		expect(failing.calls).toEqual([[A, null]]);
		expect(lines).toEqual([`[pi-web] could not reopen ${A} for msg mail: Project trust required`]);
	});

	test("a look starts a few reopens at most, and the next look the rest", async () => {
		const root = await storeRoot();
		const { host, detached, calls } = fakeHost();
		const ids = Array.from({ length: MAX_REOPENS_PER_LOOK + 2 }, (_, index) => `01a1a000-0000-7000-8000-1000000000${String(index).padStart(2, "0")}`);
		for (const id of ids) detached.set(id, ref(id));
		const watch = watchMsgMail(host, { root, intervalMs: 60_000, log: () => {} });
		try {
			await watch.sweep();
			for (const id of ids) await deliver(root, id, M1);
			await watch.sweep();
			expect(calls.map(([id]) => id)).toEqual(ids.slice(0, MAX_REOPENS_PER_LOOK));
			await watch.sweep();
			expect(calls.map(([id]) => id)).toEqual(ids);
		} finally {
			watch.stop();
		}
	});

	test("looks right away, then every interval, and not after stop", async () => {
		const root = await storeRoot();
		const { host, detached, calls } = fakeHost();
		detached.set(A, ref(A));
		await deliver(root, A, M1);
		const watch = watchMsgMail(host, { root, intervalMs: 20, log: () => {} });
		const deadline = Date.now() + 2_000;
		while (calls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toEqual([[A, null]]);

		detached.set(B, ref(B));
		await deliver(root, B, M2);
		while (calls.length === 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toEqual([
			[A, null],
			[B, null],
		]);

		watch.stop();
		detached.set(C, ref(C));
		await deliver(root, C, M3);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await watch.sweep();
		expect(calls).toHaveLength(2);
	});
});
