// Who gives up a session slot (src/session-slots.ts): the idle sweep and the cap never take a session that is watched,
// working or waiting on its subs. Pure decisions.
import { describe, expect, test } from "bun:test";
import { capacityVictim, idleVictims, isEvictable, type Slot } from "../src/session-slots.ts";

const NOW = 1_800_000_000_000;
const TTL = 15 * 60_000;

const slot = (sessionId: string, fields: Partial<Slot> = {}): Slot => ({ sessionId, viewers: 0, idle: true, waiting: false, lastActivityAtMs: NOW - TTL, ...fields });

describe("session slots", () => {
	test("evictable: nobody watches it, it isn't working, and no sub counts on it", () => {
		expect(isEvictable(slot("a"))).toBe(true);
		expect(isEvictable(slot("a", { viewers: 1 }))).toBe(false);
		expect(isEvictable(slot("a", { idle: false }))).toBe(false);
		expect(isEvictable(slot("a", { waiting: true }))).toBe(false);
	});

	test("at the cap, the least recently active evictable session goes, never a waiting one; none when only those are left", () => {
		const parent = slot("parent", { waiting: true, lastActivityAtMs: NOW - 3 * TTL });
		const older = slot("older", { lastActivityAtMs: NOW - 2 * TTL });
		const newer = slot("newer", { lastActivityAtMs: NOW - 60_000 });
		expect(capacityVictim([parent, newer, older])).toBe("older");
		expect(capacityVictim([parent, newer])).toBe("newer");
		expect(capacityVictim([parent, slot("watched", { viewers: 2 }), slot("busy", { idle: false })])).toBeNull();
		// ties go by id, so the choice never depends on the order slots come in
		expect(capacityVictim([slot("b"), slot("a")])).toBe("a");
	});

	test("the idle sweep disposes saved sessions idle for the ttl, never a waiting one or one never saved", () => {
		const slots = [
			{ ...slot("idle"), saved: true },
			{ ...slot("recent", { lastActivityAtMs: NOW - TTL + 1 }), saved: true },
			{ ...slot("waiting", { waiting: true }), saved: true },
			{ ...slot("unsaved"), saved: false },
			{ ...slot("watched", { viewers: 1 }), saved: true },
		];
		expect(idleVictims(slots, NOW, TTL)).toEqual(["idle"]);
		// once its subs stop counting, a waiting session is idle like the rest
		expect(idleVictims([{ ...slot("waiting"), saved: true }], NOW, TTL)).toEqual(["waiting"]);
	});
});
