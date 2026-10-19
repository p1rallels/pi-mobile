// msg (~/Desktop/cc/msg-cli) carries mail between pi sessions through a store on disk, and a session takes its mail
// while msg's extension runs in it. pi-web disposes idle sessions nobody watches (session-runtime.ts), so mail for one
// of those used to wait until someone opened its tab: an orchestrator that ended its turn idle never heard from its
// children. This brings such a session back, with no viewer, when mail lands in its inbox, and msg in the resumed
// session delivers what waited and wakes it.
//
// pi-web only reads the store (msg's README, "Store"), and never writes, claims or moves a message:
//   <root>/sessions/<session id>.json        presence: pid, heartbeatAt, endedAt
//   <root>/inbox/<session id>/new/<id>.json  mail nobody claimed yet (written to tmp/, renamed in)
// The decision (planMailReopens) is pure; watchMsgMail feeds it every few seconds and carries it out.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAlive } from "./outside-writers.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** msg's STALE_AFTER_MS: a presence record whose heartbeat is older than this is offline, whatever it claims. */
export const PRESENCE_STALE_MS = 45_000;
/** How often the detached sessions' inboxes are looked at: a readdir each, nothing read. */
export const MAIL_SWEEP_MS = 3_000;

/** msg's ids (src/core/paths.ts): anything else names no mailbox, and never becomes a path. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isMailboxId(id: string): boolean {
	return ID_PATTERN.test(id) && !id.includes("..");
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** msg's store root: $PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg; a leading ~ is home. */
export function msgStoreRoot(env: Env, home = homedir()): string {
	const configured = nonEmpty(env.PI_MSG_DIR);
	if (configured) return expandHome(configured, home);
	const agentDir = nonEmpty(env.PI_CODING_AGENT_DIR);
	return join(agentDir ? expandHome(agentDir, home) : join(home, ".pi", "agent"), "msg");
}

export function newMailDir(root: string, sessionId: string): string {
	return join(root, "inbox", sessionId, "new");
}

export function presencePath(root: string, sessionId: string): string {
	return join(root, "sessions", `${sessionId}.json`);
}

/** The newest message in a new/ listing, as msg lists it (`<id>.json`, temp files aside); ids sort by time. */
export function newestMessage(names: readonly string[] | undefined): string | null {
	const newest = (names ?? [])
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.reduce<string | null>((latest, name) => (latest === null || name > latest ? name : latest), null);
	return newest === null ? null : newest.slice(0, -".json".length);
}

/** What a presence record says about the process running a session. */
export interface Presence {
	pid: number;
	heartbeatAt: number;
	endedAt?: number;
}

export interface ProbedPresence extends Presence {
	pidAlive: boolean;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A presence record as msg's parsePresence accepts it, for this session; null for anything else. */
export function parsePresence(raw: unknown, sessionId: string): Presence | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	if (record.v !== 1 || record.id !== sessionId) return null;
	const pid = finite(record.pid);
	const heartbeatAt = finite(record.heartbeatAt);
	const endedAt = finite(record.endedAt);
	if (pid === undefined || heartbeatAt === undefined || finite(record.startedAt) === undefined) return null;
	return { pid, heartbeatAt, ...(endedAt !== undefined ? { endedAt } : {}) };
}

/** msg's live (no endedAt, a heartbeat under 45s old, a running pid) in a process that isn't this server. */
export function ownedElsewhere(presence: ProbedPresence | undefined, selfPid: number, now: number): boolean {
	if (!presence || presence.endedAt !== undefined || presence.pid === selfPid) return false;
	return now - presence.heartbeatAt <= PRESENCE_STALE_MS && presence.pidAlive;
}

/** A session pi-web disposed (idle, at the cap, at a restart) and may bring back by itself: detachedByPath. */
export interface DetachedRef {
	sessionId: string;
	path: string;
}

export interface RunningRef {
	sessionId: string;
	path: string | null;
	/** Idle with nobody watching: what ensureCapacity may dispose. */
	evictable: boolean;
	lastActivityAtMs: number;
}

/** Who holds the session slots. */
export interface Room {
	max: number;
	running: readonly RunningRef[];
	/** Paths being resumed: each holds a slot. */
	resuming: readonly string[];
}

export interface WaitingMail extends DetachedRef {
	/** The newest message id in new/. */
	newest: string;
}

export type MailSkip = "hosted" | "changed" | "owned";

export interface MailPlan {
	/** Oldest mail first; `evict` gives up its slot first when there's no free one. */
	reopen: Array<WaitingMail & { evict: string | null }>;
	/** No free slot, and no idle unwatched session without mail of its own to give one up: the mail waits. */
	noRoom: WaitingMail[];
	skipped: Array<WaitingMail & { reason: MailSkip }>;
}

export interface MailInput {
	detached: readonly DetachedRef[];
	/** new/ listings by session id: every detached session, and the evictable running ones when slots are short. Missing: unknown. */
	inbox: ReadonlyMap<string, readonly string[]>;
	/** The newest message each session was last reopened for. */
	reopenedFor: ReadonlyMap<string, string>;
	/** Detached sessions whose file is as pi-web left it (attachSession's rule); any other counts as changed. */
	unchanged: ReadonlySet<string>;
	presence: ReadonlyMap<string, ProbedPresence>;
	room: Room;
	selfPid: number;
	now: number;
}

function byText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Detached sessions with mail in new/ newer than what they were last reopened for, oldest mail first, each session once.
 * A session without msg never claims its mail, so the same mail must not bring it back each time it's disposed again.
 */
export function waitingMail(detached: readonly DetachedRef[], inbox: ReadonlyMap<string, readonly string[]>, reopenedFor: ReadonlyMap<string, string>): WaitingMail[] {
	const seen = new Set<string>();
	return detached
		.flatMap((ref): WaitingMail[] => {
			if (seen.has(ref.sessionId)) return [];
			seen.add(ref.sessionId);
			const newest = newestMessage(inbox.get(ref.sessionId));
			return newest !== null && newest !== reopenedFor.get(ref.sessionId) ? [{ ...ref, newest }] : [];
		})
		.sort((a, b) => byText(a.newest, b.newest) || byText(a.sessionId, b.sessionId));
}

export function freeSlots(room: Room): number {
	return Math.max(0, room.max - room.running.length - room.resuming.length);
}

function skipReason(mail: WaitingMail, input: MailInput, hostedIds: ReadonlySet<string>, hostedPaths: ReadonlySet<string>): MailSkip | null {
	if (hostedIds.has(mail.sessionId) || hostedPaths.has(mail.path)) return "hosted";
	if (!input.unchanged.has(mail.sessionId)) return "changed";
	return ownedElsewhere(input.presence.get(mail.sessionId), input.selfPid, input.now) ? "owned" : null;
}

/** A known empty new/: a running session whose listing is missing may have mail. */
function hasNoMail(names: readonly string[] | undefined): boolean {
	return names !== undefined && newestMessage(names) === null;
}

/**
 * Which detached sessions to reopen for their mail: not running or resuming here, unchanged since pi-web disposed them,
 * not run by another live process, and only into a free slot or one given up by an idle unwatched session (least
 * recently active first) that has no mail of its own, so two sessions with mail never take turns evicting each other.
 */
export function planMailReopens(input: MailInput): MailPlan {
	const { room } = input;
	const hostedIds = new Set(room.running.map((slot) => slot.sessionId));
	const hostedPaths = new Set([...room.running.flatMap((slot) => (slot.path === null ? [] : [slot.path])), ...room.resuming]);
	const judged = waitingMail(input.detached, input.inbox, input.reopenedFor).map((mail) => ({ mail, reason: skipReason(mail, input, hostedIds, hostedPaths) }));
	const eligible = judged.flatMap(({ mail, reason }) => (reason === null ? [mail] : []));
	const free = freeSlots(room);
	const victims = room.running
		.filter((slot) => slot.evictable && hasNoMail(input.inbox.get(slot.sessionId)))
		.sort((a, b) => a.lastActivityAtMs - b.lastActivityAtMs || byText(a.sessionId, b.sessionId))
		.map((slot) => slot.sessionId);
	const fits = Math.min(eligible.length, free + victims.length);
	return {
		reopen: eligible.slice(0, fits).map((mail, index) => ({ ...mail, evict: index < free ? null : (victims[index - free] ?? null) })),
		noRoom: eligible.slice(fits),
		skipped: judged.flatMap(({ mail, reason }) => (reason === null ? [] : [{ ...mail, reason }])),
	};
}

/** A reopen under way: the session disposed for its slot, and the resume. */
export interface MailReopen {
	evicted: string | null;
	running: Promise<void>;
}

/** What the watch needs from the runtime (PiWebRuntime). */
export interface MailHost {
	detachedSessions(): DetachedRef[];
	sessionRoom(): Room;
	isUnchangedSinceDetach(path: string, sessionId: string): boolean;
	/** Null when the session can't be reopened right now; checked and started in one synchronous step. */
	reopenForMail(sessionId: string, path: string, evict: string | null): MailReopen | null;
}

export interface MailWatchOptions {
	root: string;
	intervalMs?: number;
	selfPid?: number;
	now?: () => number;
	log?: (line: string) => void;
	pidAlive?: (pid: number) => boolean;
}

export interface MailWatch {
	/** Looks at the inboxes once more, after any look under way, and resolves once every reopen under way settled. */
	sweep(): Promise<void>;
	stop(): void;
}

/** Listings by session id: ENOENT is an empty inbox, any other failure leaves the session out (unknown). */
async function listNewMail(root: string, sessionIds: readonly string[]): Promise<Map<string, string[]>> {
	const listed = await Promise.all(
		sessionIds.map(async (sessionId): Promise<Array<[string, string[]]>> => {
			try {
				return [[sessionId, await readdir(newMailDir(root, sessionId))]];
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "ENOENT" ? [[sessionId, []]] : [];
			}
		}),
	);
	return new Map(listed.flat());
}

async function readPresence(root: string, sessionId: string): Promise<Presence | null> {
	try {
		return parsePresence(JSON.parse(await readFile(presencePath(root, sessionId), "utf8")), sessionId);
	} catch {
		return null;
	}
}

function probePid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 0 && isAlive(pid);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reopens sessions pi-web disposed when msg mail lands for them: one look right away (mail that came while pi-web was
 * down counts), then every intervalMs. Each look lists the detached sessions' new/ folders; only mail no reopen was made
 * for yet costs more (a stat of the session file, its presence record). Reopens are logged, and why one isn't made
 * (no room, the file changed, another process runs it, it failed) once per newest message.
 */
export function watchMsgMail(host: MailHost, options: MailWatchOptions): MailWatch {
	const { root } = options;
	const selfPid = options.selfPid ?? process.pid;
	const now = options.now ?? Date.now;
	const log = options.log ?? ((line: string) => console.log(line));
	const pidAlive = options.pidAlive ?? probePid;
	let reopenedFor = new Map<string, string>();
	/** What was last said about each session's mail, so a reason is logged once per newest message. */
	let told = new Map<string, string>();
	let lastFailure: string | null = null;
	let stopped = false;
	let looking = false;
	let chain: Promise<unknown> = Promise.resolve();
	const reopening = new Set<Promise<void>>();

	function tell(mail: WaitingMail, why: string, line: string): void {
		const key = `${why}:${mail.newest}`;
		if (told.get(mail.sessionId) === key) return;
		told.set(mail.sessionId, key);
		log(line);
	}

	function forget(detached: readonly DetachedRef[], inbox: ReadonlyMap<string, readonly string[]>, room: Room): void {
		const withMail = new Set(detached.filter((ref) => newestMessage(inbox.get(ref.sessionId)) !== null).map((ref) => ref.sessionId));
		const keep = new Set([...withMail, ...room.running.map((slot) => slot.sessionId)]);
		reopenedFor = new Map([...reopenedFor].filter(([sessionId]) => keep.has(sessionId)));
		told = new Map([...told].filter(([sessionId]) => withMail.has(sessionId)));
	}

	function explain(plan: MailPlan, room: Room, presence: ReadonlyMap<string, ProbedPresence>): void {
		for (const mail of plan.noRoom) {
			tell(mail, "room", `[pi-web] no room to reopen ${mail.sessionId} for msg mail: ${String(room.running.length + room.resuming.length)} of ${String(room.max)} sessions running, none idle, unwatched and without mail of its own; the mail waits`);
		}
		for (const mail of plan.skipped) {
			if (mail.reason === "changed") tell(mail, "changed", `[pi-web] not reopening ${mail.sessionId} for msg mail: its file changed since pi-web disposed it`);
			if (mail.reason === "owned") tell(mail, "owned", `[pi-web] not reopening ${mail.sessionId} for msg mail: pid ${String(presence.get(mail.sessionId)?.pid)} runs it`);
		}
	}

	/** Marks the mail as reopened for once the runtime took the reopen (or failed it): a turned-down one is retried next look. */
	function start(item: MailPlan["reopen"][number]): void {
		let reopen: MailReopen | null;
		try {
			reopen = host.reopenForMail(item.sessionId, item.path, item.evict);
		} catch (error) {
			reopenedFor.set(item.sessionId, item.newest);
			tell(item, "failed", `[pi-web] could not reopen ${item.sessionId} for msg mail: ${errorMessage(error)}`);
			return;
		}
		if (!reopen) return;
		reopenedFor.set(item.sessionId, item.newest);
		if (reopen.evicted) log(`[pi-web] disposed idle session ${reopen.evicted} to make room for msg mail`);
		const settled = reopen.running.then(
			() => log(`[pi-web] reopened ${item.sessionId} for msg mail`),
			(error: unknown) => tell(item, "failed", `[pi-web] could not reopen ${item.sessionId} for msg mail: ${errorMessage(error)}`),
		);
		reopening.add(settled);
		void settled.finally(() => reopening.delete(settled));
	}

	async function look(): Promise<void> {
		if (stopped) return;
		const detached = host.detachedSessions().filter((ref) => isMailboxId(ref.sessionId));
		const inbox = await listNewMail(root, detached.map((ref) => ref.sessionId));
		forget(detached, inbox, host.sessionRoom());
		const waiting = waitingMail(detached, inbox, reopenedFor);
		if (waiting.length === 0 || stopped) return;
		const unchanged = new Set(waiting.filter((mail) => host.isUnchangedSinceDetach(mail.path, mail.sessionId)).map((mail) => mail.sessionId));
		const records = await Promise.all(waiting.map(async (mail) => [mail.sessionId, await readPresence(root, mail.sessionId)] as const));
		const presence = new Map(records.flatMap(([sessionId, record]) => (record ? [[sessionId, { ...record, pidAlive: pidAlive(record.pid) }] as const] : [])));
		// a running session gives up its slot only with a known empty inbox, so list the ones that could when slots are short
		const roomNow = host.sessionRoom();
		const short = waiting.length > freeSlots(roomNow);
		const evictable = short ? roomNow.running.filter((slot) => slot.evictable && isMailboxId(slot.sessionId)).map((slot) => slot.sessionId) : [];
		const evictableInbox = await listNewMail(root, evictable);
		if (stopped) return;
		const room = host.sessionRoom();
		const plan = planMailReopens({ detached, inbox: new Map([...inbox, ...evictableInbox]), reopenedFor, unchanged, presence, room, selfPid, now: now() });
		explain(plan, room, presence);
		for (const item of plan.reopen) start(item);
	}

	function queue(): Promise<void> {
		const next = chain.then(look);
		chain = next.catch(() => undefined);
		return next;
	}

	function tick(): void {
		if (looking || stopped) return;
		looking = true;
		queue()
			.then(() => {
				lastFailure = null;
			})
			.catch((error: unknown) => {
				const message = errorMessage(error);
				if (message !== lastFailure) log(`[pi-web] msg mail sweep failed: ${message}`);
				lastFailure = message;
			})
			.finally(() => {
				looking = false;
			});
	}

	const timer = setInterval(tick, options.intervalMs ?? MAIL_SWEEP_MS);
	timer.unref?.();
	tick();

	return {
		async sweep() {
			await queue();
			await Promise.all([...reopening]);
		},
		stop() {
			stopped = true;
			clearInterval(timer);
		},
	};
}
