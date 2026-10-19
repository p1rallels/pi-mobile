// msg's subs as pi-web treats them. A sub is a session whose msg presence record names a parent: a run started from
// another session's bash (a pfs fork's `pi -p`), which that parent manages through msg (msg's README "Lineage"). Nobody
// types into one or goes back to one, and loading one here would have msg rewrite its record without the parent (msg
// writes a session's record whole at every start), so pi-web never loads a sub: every way in shows it read-only,
// followed while another pi runs it, its transcript once it ended. A session whose folder is gone (pfs deleted its fork)
// opens the same way, sub or not.
//
// A parent hears that a sub crashed or hung from its own msg, which only runs while pi-web has the parent loaded. So a
// session some sub still counts on is waiting, never idle: the idle sweep and the cap leave it be (session-slots.ts),
// and after a restart it comes back by itself, with no viewer. Pure decisions; the runtime (session-runtime.ts) feeds
// them from one presence index (msg-lineage.ts), read once a sweep.
import type { Presence } from "./msg-store.ts";
import type { ApiReadOnly } from "./types.ts";

/** How long a sub keeps its parent waiting after its last heartbeat: a crashed or hung one, long enough for the parent's msg to say it died. */
export const SUB_GRACE_MS = 5 * 60_000;

/** msg's record names a parent: another session's bash started it. */
export const isSub = (record: Presence | undefined): boolean => record?.parent !== undefined;

/** A sub its parent still waits on: it never ended, and its last heartbeat is under 5 minutes old. */
export const subCounts = (sub: Presence, now: number): boolean => sub.endedAt === undefined && now - sub.heartbeatAt < SUB_GRACE_MS;

/** Waiting, never idle: any of a session's subs (the records naming it as their parent) still counts. */
export const isWaiting = (subs: readonly Presence[], now: number): boolean => subs.some((sub) => subCounts(sub, now));

/** Why pi-web only shows a session, from its presence record (if msg ever ran in it) and whether its folder is there; null when it may load it. */
export function readOnlyOf(record: Presence | undefined, folderExists: boolean): ApiReadOnly | null {
	if (record?.parent !== undefined) return { reason: "sub", parent: record.parent };
	return folderExists ? null : { reason: "folder" };
}

/** The reason in words, for the log: "it's a sub", "its folder is gone". */
export const readOnlyWords = (readOnly: ApiReadOnly): string => (readOnly.reason === "sub" ? "it's a sub, which pi-web only shows" : "its folder is gone");

/** A session pi-web disposed (at a restart, mostly) that it may bring back for its subs. */
export interface DetachedParent {
	sessionId: string;
	path: string;
}

/** read_only: a sub or a folder gone; changed: its file changed since pi-web disposed it; owned: another live process runs it. */
export type WaitingSkip = "read_only" | "changed" | "owned";

export interface WaitingInput<T extends DetachedParent> {
	detached: readonly T[];
	/** Sessions some sub still counts on (isWaiting). */
	waiting: ReadonlySet<string>;
	/** Sessions pi-web only shows. */
	readOnly: ReadonlySet<string>;
	/** Sessions whose file is as pi-web left it (attachSession's rule). */
	unchanged: ReadonlySet<string>;
	/** Sessions msg says another live process runs (msg-mail.ts ownedElsewhere). */
	owned: ReadonlySet<string>;
	/** Running or resuming here, by id and by path. */
	hostedIds: ReadonlySet<string>;
	hostedPaths: ReadonlySet<string>;
	/** Reopens one sweep starts at most (each loads extensions and models); the rest wait for the next sweep. */
	limit: number;
}

export interface WaitingPlan<T extends DetachedParent> {
	reopen: T[];
	skipped: Array<T & { reason: WaitingSkip }>;
	/** Reopenable, past this sweep's limit. */
	later: T[];
}

function skipOf<T extends DetachedParent>(ref: T, input: WaitingInput<T>): WaitingSkip | null {
	if (input.readOnly.has(ref.sessionId)) return "read_only";
	if (!input.unchanged.has(ref.sessionId)) return "changed";
	return input.owned.has(ref.sessionId) ? "owned" : null;
}

/**
 * Which detached sessions to bring back because their subs still count: waiting, not running or resuming here, not
 * read-only, unchanged since pi-web disposed them and run by no other live process; each once, at most `limit`.
 */
export function planWaitingReopens<T extends DetachedParent>(input: WaitingInput<T>): WaitingPlan<T> {
	const seen = new Set<string>();
	const candidates = input.detached.filter((ref) => {
		if (seen.has(ref.sessionId) || !input.waiting.has(ref.sessionId)) return false;
		seen.add(ref.sessionId);
		return !input.hostedIds.has(ref.sessionId) && !input.hostedPaths.has(ref.path);
	});
	const judged = candidates.map((ref) => ({ ref, reason: skipOf(ref, input) }));
	const eligible = judged.flatMap(({ ref, reason }) => (reason === null ? [ref] : []));
	const limit = Math.max(0, Math.floor(input.limit));
	return {
		reopen: eligible.slice(0, limit),
		skipped: judged.flatMap(({ ref, reason }) => (reason === null ? [] : [{ ...ref, reason }])),
		later: eligible.slice(limit),
	};
}
