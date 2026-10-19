// msg's lineage, read from its on-disk store: who started a session (its parent), the sessions it started (its
// children) and how each of them stands. The store is msg's contract (~/Desktop/cc/msg-cli, README "Store" and
// "Lineage", src/core/paths.ts and registry.ts); pi-web only ever reads it, and imports nothing from msg.
//
//   <root>/sessions/<session id>.json   presence: name, parent, cwd, pid, mode, activity, startedAt, heartbeatAt, endedAt
//
// root: $PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg. Every live session rewrites its record at
// least every 10s, through a temp file renamed into place, and the store can hold hundreds of records: one index keeps
// them, refreshed from a readdir and the files' mtimes, and reads only the records that changed. A feed refreshes it on
// a timer while someone looks at a session, works out each watched session's lineage and says when one changes.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { sessionDirForCwd } from "./session-index.ts";
import type { ApiLineage, ApiLineageParty, ApiLineageState } from "./types.ts";

export const PRESENCE_VERSION = 1;
/** A record whose heartbeat is older than this is offline, whatever it claims (msg's STALE_AFTER_MS). */
export const STALE_AFTER_MS = 45_000;
/** How many children the header lists; the count covers the rest. */
export const LISTED_CHILDREN = 8;
export const DEFAULT_LINEAGE_REFRESH_MS = 2_000;
/** Records change by rename, which the folder's mtime shows; a full look at every file's mtime this often anyway. */
const FULL_SCAN_MS = 30_000;
/** A session nobody watched for this long is forgotten. */
const FORGET_AFTER_MS = 10 * 60_000;
/** How long a session file found nowhere (a parent without a record) stays not found before the next look. */
const NOWHERE_RETRY_MS = 60_000;
const STAT_CONCURRENCY = 16;
const MAX_NAME_LENGTH = 64;

export type PresenceMode = "tui" | "rpc" | "json" | "print" | "web" | "cli";

export interface Presence {
	id: string;
	name?: string;
	/** The session whose bash started this one. */
	parent?: string;
	cwd: string;
	pid: number;
	mode: PresenceMode;
	activity: "idle" | "busy";
	startedAt: number;
	heartbeatAt: number;
	endedAt?: number;
}

export type PidProbe = (pid: number) => boolean;

type Env = Readonly<Record<string, string | undefined>>;

const MODES: readonly PresenceMode[] = ["tui", "rpc", "json", "print", "web", "cli"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** How each mode reads in a "where it runs" line. */
const MODE_LABELS: Readonly<Record<PresenceMode, string>> = {
	tui: "pi",
	rpc: "pi rpc",
	json: "pi json",
	print: "pi -p",
	web: "pi-web",
	cli: "msg cli",
};

export const isValidId = (id: string): boolean => ID_PATTERN.test(id) && !id.includes("..");

const expandHome = (path: string, home: string): string => {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
};

const nonEmpty = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** Where msg keeps its store: $PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg. */
export function msgStoreRoot(env: Env = process.env, home: string = homedir()): string {
	const configured = nonEmpty(env.PI_MSG_DIR);
	if (configured) return expandHome(configured, home);
	const agentDir = nonEmpty(env.PI_CODING_AGENT_DIR);
	return join(agentDir ? expandHome(agentDir, home) : join(home, ".pi", "agent"), "msg");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const normalizeName = (value: unknown): string | undefined => {
	const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	return name ? name.slice(0, MAX_NAME_LENGTH) : undefined;
};

/** A presence record the way msg reads one (registry.ts parsePresence), or null when it isn't one. */
export function parsePresence(value: unknown): Presence | null {
	if (!isRecord(value) || value.v !== PRESENCE_VERSION) return null;
	const id = typeof value.id === "string" ? value.id : "";
	const pid = finite(value.pid);
	const startedAt = finite(value.startedAt);
	const heartbeatAt = finite(value.heartbeatAt);
	if (!isValidId(id) || pid === undefined || startedAt === undefined || heartbeatAt === undefined) return null;
	const name = normalizeName(value.name);
	const parent = typeof value.parent === "string" && isValidId(value.parent) && value.parent !== id ? value.parent : undefined;
	const endedAt = finite(value.endedAt);
	return {
		id,
		...(name ? { name } : {}),
		...(parent ? { parent } : {}),
		cwd: typeof value.cwd === "string" ? value.cwd : "",
		pid,
		mode: MODES.find((mode) => mode === value.mode) ?? "rpc",
		activity: value.activity === "busy" ? "busy" : "idle",
		startedAt,
		heartbeatAt,
		...(endedAt !== undefined ? { endedAt } : {}),
	};
}

/** `kill(pid, 0)` checks the process exists without signalling it; EPERM still means it does. */
export const pidAlive: PidProbe = (pid) => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
};

/**
 * ended: it said so. died: its process is gone and it never ended (killed, crashed; msg tells its parent). live: a
 * heartbeat under 45s old from a running process. offline: no heartbeat for 45s while its process is still there
 * (hung, the machine asleep, or its pid went to another process).
 */
export function presenceState(record: Presence, now: number, probe: PidProbe = pidAlive): ApiLineageState {
	if (record.endedAt !== undefined) return "ended";
	if (!probe(record.pid)) return "died";
	return now - record.heartbeatAt <= STALE_AFTER_MS ? "live" : "offline";
}

export interface JudgedPresence {
	record: Presence;
	state: ApiLineageState;
}

const byStart = (a: JudgedPresence, b: JudgedPresence): number => a.record.startedAt - b.record.startedAt || a.record.id.localeCompare(b.record.id);

const byLatestEnd = (a: JudgedPresence, b: JudgedPresence): number =>
	(b.record.endedAt ?? 0) - (a.record.endedAt ?? 0) || a.record.id.localeCompare(b.record.id);

/** Children the way the header lists them: the ones still around in the order they started, then the ended ones, latest first. */
export function orderChildren(children: readonly JudgedPresence[]): JudgedPresence[] {
	const around = children.filter((child) => child.state !== "ended").sort(byStart);
	const ended = children.filter((child) => child.state === "ended").sort(byLatestEnd);
	return [...around, ...ended];
}

export const tildify = (path: string, home: string): string => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

/** "pi -p · ~/repo/.forks/3": how and where a session runs, for one pi-web can't open. */
export const whereOf = (record: Presence, home: string): string => [MODE_LABELS[record.mode], tildify(record.cwd, home)].filter(Boolean).join(" · ");

const shortId = (id: string): string => id.slice(0, 8);

/** A child as the header lists it: its name, else the first 8 characters of its id (msg's partyLabel). */
export function childParty({ record, state }: JudgedPresence, openable: boolean, home: string): ApiLineageParty {
	return { id: record.id, label: record.name ?? shortId(record.id), state, openable, where: whereOf(record, home) };
}

/** The parent: its name, else its folder, else the first 8 characters of its id; `record` is missing when it never ran msg. */
export function parentParty(id: string, record: Presence | undefined, state: ApiLineageState | null, openable: boolean, home: string): ApiLineageParty {
	const folder = record?.cwd ? basename(record.cwd) : "";
	return { id, label: record?.name ?? (folder || shortId(id)), state, openable, where: record ? whereOf(record, home) : null };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await map(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

const isMissing = (error: unknown): boolean => isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");

interface IndexedFile {
	mtimeMs: number;
	size: number;
	record: Presence | null;
}

/** Every presence record in msg's store, kept in memory: a refresh reads only the files that changed. */
export function createPresenceIndex(root: string, clock: () => number = Date.now) {
	const dir = join(root, "sessions");
	const files = new Map<string, IndexedFile>();
	let folderMtimeMs: number | null = null;
	let fullScanAt = 0;
	let byId = new Map<string, Presence>();
	let byParent = new Map<string, Presence[]>();

	function rebuild(): void {
		byId = new Map();
		byParent = new Map();
		for (const { record } of files.values()) {
			if (!record) continue;
			byId.set(record.id, record);
			if (record.parent === undefined) continue;
			const siblings = byParent.get(record.parent);
			if (siblings) siblings.push(record);
			else byParent.set(record.parent, [record]);
		}
	}

	async function readRecord(path: string): Promise<Presence | null> {
		try {
			return parsePresence(JSON.parse(await readFile(path, "utf8")));
		} catch {
			return null;
		}
	}

	async function refresh(): Promise<void> {
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(dir)).mtimeMs;
		} catch (error) {
			if (!isMissing(error)) throw error;
			if (files.size > 0) {
				files.clear();
				rebuild();
			}
			folderMtimeMs = null;
			return;
		}
		const now = clock();
		if (mtimeMs === folderMtimeMs && now - fullScanAt < FULL_SCAN_MS) return;
		const names = (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
		const present = new Set(names);
		let changed = false;
		for (const name of [...files.keys()].filter((known) => !present.has(known))) {
			files.delete(name);
			changed = true;
		}
		await mapLimited(names, STAT_CONCURRENCY, async (name) => {
			const path = join(dir, name);
			try {
				const info = await stat(path);
				const known = files.get(name);
				if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return;
				files.set(name, { mtimeMs: info.mtimeMs, size: info.size, record: await readRecord(path) });
				changed = true;
			} catch (error) {
				if (!isMissing(error)) throw error;
				changed = files.delete(name) || changed;
			}
		});
		// the folder's mtime from before the scan: a rename during it shows as a change next time
		folderMtimeMs = mtimeMs;
		fullScanAt = now;
		if (changed) rebuild();
	}

	return {
		refresh,
		record: (id: string): Presence | undefined => byId.get(id),
		childrenOf: (id: string): readonly Presence[] => byParent.get(id) ?? [],
		size: (): number => byId.size,
	};
}

export type PresenceIndex = ReturnType<typeof createPresenceIndex>;

/**
 * Whether pi-web's sessions folder holds a session's file: pi names them `<time>_<session id>.jsonl` in the folder for
 * the session's cwd. A folder is listed again only when its mtime moves (a new file), and a file once found stays found.
 */
export function createSessionFiles(sessionsDir: string, clock: () => number = Date.now) {
	const found = new Set<string>();
	const listings = new Map<string, { mtimeMs: number; names: string[] }>();
	const nowhere = new Map<string, number>();

	async function namesIn(dir: string): Promise<string[]> {
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(dir)).mtimeMs;
		} catch {
			listings.delete(dir);
			return [];
		}
		const listed = listings.get(dir);
		if (listed && listed.mtimeMs === mtimeMs) return listed.names;
		const names = (await readdir(dir).catch((): string[] => [])).filter((name) => name.endsWith(".jsonl"));
		listings.set(dir, { mtimeMs, names });
		return names;
	}

	const holds = (names: readonly string[], id: string): boolean => names.some((name) => name.endsWith(`_${id}.jsonl`));

	/** In the folder pi keeps `cwd`'s sessions in. */
	async function has(cwd: string, id: string): Promise<boolean> {
		if (found.has(id)) return true;
		if (!cwd || !holds(await namesIn(sessionDirForCwd(sessionsDir, cwd)), id)) return false;
		found.add(id);
		return true;
	}

	/** In any folder, for a session whose cwd nobody recorded (a parent that never ran msg); a miss is remembered a while. */
	async function anywhere(id: string): Promise<boolean> {
		if (found.has(id)) return true;
		const missedAt = nowhere.get(id);
		if (missedAt !== undefined && clock() - missedAt < NOWHERE_RETRY_MS) return false;
		const dirs = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
		for (const dir of dirs) {
			if (!dir.isDirectory() || !holds(await namesIn(join(sessionsDir, dir.name)), id)) continue;
			found.add(id);
			nowhere.delete(id);
			return true;
		}
		nowhere.set(id, clock());
		return false;
	}

	return { has, anywhere };
}

export interface LineageFeedOptions {
	/** msg's store (msgStoreRoot). */
	root: string;
	/** pi's sessions folder, where the files pi-web can open live. */
	sessionsDir: string;
	/** pi-web hosts it: it opens, and has no parent (its process is pi-web's). */
	isHosted: (id: string) => boolean;
	/** The sessions someone is looking at; the feed stops while there are none. */
	watched: () => Iterable<string>;
	/** A watched session's lineage changed (null: it has no family any more). */
	onChange: (id: string, lineage: ApiLineage | null) => void;
	intervalMs?: number;
	probe?: PidProbe;
	clock?: () => number;
	home?: string;
}

/**
 * Keeps the lineage of the sessions someone is looking at: refreshes the index on a timer while there are any (and
 * right away on kick), works out each one's parent and children, and calls onChange for the ones that changed.
 */
export function createLineageFeed(options: LineageFeedOptions) {
	const clock = options.clock ?? Date.now;
	const probe = options.probe ?? pidAlive;
	const home = options.home ?? homedir();
	const intervalMs = options.intervalMs ?? DEFAULT_LINEAGE_REFRESH_MS;
	const index = createPresenceIndex(options.root, clock);
	const files = createSessionFiles(options.sessionsDir, clock);
	const views = new Map<string, { view: ApiLineage | null; key: string; watchedAt: number }>();
	let timer: ReturnType<typeof setInterval> | null = null;
	let running: Promise<void> | null = null;
	let again = false;
	let reported = false;

	async function openable(id: string, record: Presence | undefined): Promise<boolean> {
		if (options.isHosted(id)) return true;
		return record ? files.has(record.cwd, id) : files.anywhere(id);
	}

	async function lineageOf(id: string, now: number): Promise<ApiLineage | null> {
		const parentId = options.isHosted(id) ? undefined : index.record(id)?.parent;
		const children = index.childrenOf(id).map((record) => ({ record, state: presenceState(record, now, probe) }));
		if (parentId === undefined && children.length === 0) return null;
		const parentRecord = parentId === undefined ? undefined : index.record(parentId);
		const parent =
			parentId === undefined
				? null
				: parentParty(parentId, parentRecord, parentRecord ? presenceState(parentRecord, now, probe) : null, await openable(parentId, parentRecord), home);
		const listed = await Promise.all(
			orderChildren(children)
				.slice(0, LISTED_CHILDREN)
				.map(async (child) => childParty(child, await openable(child.record.id, child.record), home)),
		);
		return { parent, children: listed, childCount: children.length };
	}

	function stopTimer(): void {
		if (timer) clearInterval(timer);
		timer = null;
	}

	async function tick(): Promise<void> {
		const ids = [...new Set(options.watched())];
		if (ids.length === 0) {
			stopTimer();
			return;
		}
		await index.refresh();
		const now = clock();
		for (const id of ids) {
			const view = await lineageOf(id, now);
			const key = JSON.stringify(view);
			const previous = views.get(id);
			views.set(id, { view, key, watchedAt: now });
			if (previous ? previous.key === key : view === null) continue;
			try {
				options.onChange(id, view);
			} catch (error) {
				console.error(`[pi-web] lineage update for ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const [id, entry] of views) if (now - entry.watchedAt > FORGET_AFTER_MS) views.delete(id);
	}

	function run(): Promise<void> {
		if (running) {
			again = true;
			return running;
		}
		running = tick()
			.then(
				() => {
					reported = false;
				},
				(error: unknown) => {
					// a broken store mustn't break sessions; say so once until it reads again
					if (!reported) console.error(`[pi-web] can't read msg's store at ${options.root}: ${error instanceof Error ? error.message : String(error)}`);
					reported = true;
				},
			)
			.finally(() => {
				running = null;
				if (!again) return;
				again = false;
				void run();
			});
		return running;
	}

	function kick(): void {
		if (!timer) {
			timer = setInterval(() => void run(), intervalMs);
			timer.unref?.();
		}
		void run();
	}

	return {
		/** The lineage last worked out for a session: null without family, undefined before the feed looked. */
		current: (id: string): ApiLineage | null | undefined => views.get(id)?.view,
		/** Someone started looking at a session: look now, and keep looking while anyone does. */
		kick,
		/** Looks now and waits until nothing is left to look at (tests). */
		async refresh(): Promise<void> {
			await run();
			while (running) await running;
		},
		stop(): void {
			stopTimer();
		},
	};
}

export type LineageFeed = ReturnType<typeof createLineageFeed>;
