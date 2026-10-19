// msg's subs as pi-web treats them (src/msg-subs.ts): which sessions open read-only, which wait on their subs, and which
// detached ones a sweep brings back for them. Pure decisions.
import { describe, expect, test } from "bun:test";
import type { Presence } from "../src/msg-store.ts";
import { isSub, isWaiting, planWaitingReopens, readOnlyOf, readOnlyWords, SUB_GRACE_MS, subCounts, type WaitingInput } from "../src/msg-subs.ts";

const NOW = 1_800_000_000_000;
const LEAD = "01a152a0-0000-7000-8000-00000000000a";
// above any pid macOS hands out: whether its process lives is no part of the waiting rule
const DEAD_PID = 999_999;

const record = (id: string, fields: Partial<Presence> = {}): Presence => ({
	id,
	cwd: "/repo/.forks/1",
	pid: DEAD_PID,
	mode: "print",
	activity: "busy",
	startedAt: NOW - 60_000,
	heartbeatAt: NOW - 10_000,
	...fields,
});

describe("read-only sessions", () => {
	test("a sub (its record names a parent) is read-only wherever its folder is; anything else only once its folder is gone", () => {
		const sub = record("sub-1", { parent: LEAD });
		expect(isSub(sub)).toBe(true);
		expect(readOnlyOf(sub, true)).toEqual({ reason: "sub", parent: LEAD });
		expect(readOnlyOf(sub, false)).toEqual({ reason: "sub", parent: LEAD });

		const top = record(LEAD, { mode: "web" });
		expect(isSub(top)).toBe(false);
		expect(readOnlyOf(top, true)).toBeNull();
		expect(readOnlyOf(top, false)).toEqual({ reason: "folder" });
		// msg never ran in it: no record, only its folder counts
		expect(isSub(undefined)).toBe(false);
		expect(readOnlyOf(undefined, true)).toBeNull();
		expect(readOnlyOf(undefined, false)).toEqual({ reason: "folder" });
	});

	test("says why in words for the log", () => {
		expect(readOnlyWords({ reason: "sub", parent: LEAD })).toBe("it's a sub, which pi-web only shows");
		expect(readOnlyWords({ reason: "folder" })).toBe("its folder is gone");
	});
});

describe("waiting on subs", () => {
	test("a sub counts until it ends, or for 5 minutes past its last heartbeat, whether its process lives or not", () => {
		expect(subCounts(record("s", { parent: LEAD }), NOW)).toBe(true);
		expect(subCounts(record("s", { parent: LEAD, endedAt: NOW - 1 }), NOW)).toBe(false);
		// crashed or hung: still counted long enough for the parent's msg to say it died
		expect(subCounts(record("s", { parent: LEAD, heartbeatAt: NOW - SUB_GRACE_MS + 1 }), NOW)).toBe(true);
		expect(subCounts(record("s", { parent: LEAD, heartbeatAt: NOW - SUB_GRACE_MS }), NOW)).toBe(false);
		expect(SUB_GRACE_MS).toBe(5 * 60_000);
	});

	test("a session waits while any sub of its counts", () => {
		const ended = record("a", { parent: LEAD, endedAt: NOW - 1_000 });
		const stale = record("b", { parent: LEAD, heartbeatAt: NOW - 6 * 60_000 });
		const live = record("c", { parent: LEAD });
		expect(isWaiting([], NOW)).toBe(false);
		expect(isWaiting([ended, stale], NOW)).toBe(false);
		expect(isWaiting([ended, stale, live], NOW)).toBe(true);
		// the same live sub stops counting 5 minutes after its last heartbeat
		expect(isWaiting([live], live.heartbeatAt + SUB_GRACE_MS)).toBe(false);
	});
});

describe("bringing waiting sessions back", () => {
	const ref = (sessionId: string) => ({ sessionId, path: `/sessions/${sessionId}.jsonl` });
	const input = (fields: Partial<WaitingInput<ReturnType<typeof ref>>> = {}): WaitingInput<ReturnType<typeof ref>> => ({
		detached: [ref("a"), ref("b"), ref("c")],
		waiting: new Set(["a", "b", "c"]),
		readOnly: new Set(),
		unchanged: new Set(["a", "b", "c"]),
		owned: new Set(),
		hostedIds: new Set(),
		hostedPaths: new Set(),
		limit: 4,
		...fields,
	});

	test("reopens the detached sessions that wait, as pi-web left them, nobody else running them", () => {
		expect(planWaitingReopens(input())).toEqual({ reopen: [ref("a"), ref("b"), ref("c")], skipped: [], later: [] });
		expect(planWaitingReopens(input({ waiting: new Set(["b"]) }))).toEqual({ reopen: [ref("b")], skipped: [], later: [] });
	});

	test("skips a read-only one, one whose file changed and one another live process runs, saying why", () => {
		const plan = planWaitingReopens(input({ readOnly: new Set(["a"]), unchanged: new Set(["a", "c"]), owned: new Set(["c"]) }));
		expect(plan.reopen).toEqual([]);
		expect(plan.skipped).toEqual([
			{ ...ref("a"), reason: "read_only" },
			{ ...ref("b"), reason: "changed" },
			{ ...ref("c"), reason: "owned" },
		]);
	});

	test("leaves one running or resuming here alone, takes each once, and keeps what's past the limit for later", () => {
		expect(planWaitingReopens(input({ hostedIds: new Set(["a"]), hostedPaths: new Set([ref("b").path]) })).reopen).toEqual([ref("c")]);
		expect(planWaitingReopens(input({ detached: [ref("a"), ref("a"), ref("b")] })).reopen).toEqual([ref("a"), ref("b")]);
		expect(planWaitingReopens(input({ limit: 2 }))).toEqual({ reopen: [ref("a"), ref("b")], skipped: [], later: [ref("c")] });
		expect(planWaitingReopens(input({ limit: 0 })).later).toEqual([ref("a"), ref("b"), ref("c")]);
	});
});
