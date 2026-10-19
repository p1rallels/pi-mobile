// Who gives up a session slot (session-runtime.ts): the idle sweep disposes sessions nobody watches that sat idle for
// the ttl, and at the cap a new session takes the slot of the least recently active one of those. A session some sub
// still counts on (msg-subs.ts) is waiting, not idle: neither ever takes it, and when nothing else can go the new session
// is refused, as when every slot is busy. Pure decisions over the runtime's slots.

export interface Slot {
	sessionId: string;
	/** Viewers connected to it. */
	viewers: number;
	/** No turn, no compaction. */
	idle: boolean;
	/** Some sub still counts on it (msg-subs.ts isWaiting). */
	waiting: boolean;
	lastActivityAtMs: number;
}

/** Nobody watches it, it isn't working, and no sub counts on it. */
export const isEvictable = (slot: Slot): boolean => slot.viewers === 0 && slot.idle && !slot.waiting;

const byActivity = (a: Slot, b: Slot): number =>
	a.lastActivityAtMs - b.lastActivityAtMs || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

/** The session a full house gives up for a new one: the least recently active evictable one; null when none can go. */
export function capacityVictim(slots: readonly Slot[]): string | null {
	return slots.filter(isEvictable).sort(byActivity)[0]?.sessionId ?? null;
}

/** What the idle sweep disposes: evictable, saved (one never saved has no file to come back from), idle for the ttl. */
export function idleVictims(slots: readonly (Slot & { saved: boolean })[], now: number, ttlMs: number): string[] {
	return slots.filter((slot) => isEvictable(slot) && slot.saved && now - slot.lastActivityAtMs >= ttlMs).map((slot) => slot.sessionId);
}
