// msg's lineage, read from its on-disk store (msg-store.ts): who started a session (its parent), the sessions it
// started (its children) and how each of them stands (msg's README "Lineage").
//
// Every live session rewrites its presence record at least every 10s, through a temp file renamed into place, and the
// store can hold hundreds of records: one index keeps them, refreshed from a readdir and the files' mtimes, and reads
// only the records that changed. The runtime keeps one for everything that reads presence (this feed, the idle sweep's
// waiting rule, which sessions open read-only: msg-subs.ts). A feed refreshes it on a timer while someone looks at a
// session, works out each watched session's lineage and says when one changes.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parsePresence, pidAlive, STALE_AFTER_MS, type PidProbe, type Presence, type PresenceMode } from "./msg-store.ts";
import { isSub } from "./msg-subs.ts";
import { sessionDirForCwd } from "./session-index.ts";
import type { ApiLineage, ApiLineageParty, ApiLineageState } from "./types.ts";

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

/** How each mode reads in a "where it runs" line. */
const MODE_LABELS: Readonly<Record<PresenceMode, string>> = {
	tui: "pi",
	rpc: "pi rpc",
	json: "pi json",
	print: "pi -p",
	web: "pi-web",
	cli: "msg cli",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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

/** A child as the header lists it: its name, else the first 8 characters of its id (msg's partyLabel). Every child is a sub, so it opens read-only. */
export function childParty({ record, state }: JudgedPresence, openable: boolean, home: string): ApiLineageParty {
	return { id: record.id, label: record.name ?? shortId(record.id), state, openable, readOnly: true, where: whereOf(record, home) };
}

/** The parent: its name, else its folder, else the first 8 characters of its id; `record` is missing when it never ran msg. */
export function parentParty(id: string, record: Presence | undefined, state: ApiLineageState | null, openable: boolean, home: string): ApiLineageParty {
	const folder = record?.cwd ? basename(record.cwd) : "";
	return { id, label: record?.name ?? (folder || shortId(id)), state, openable, readOnly: isSub(record), where: record ? whereOf(record, home) : null };
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

	async function scan(): Promise<void> {
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

	let scanning: Promise<void> | null = null;
	let queued: Promise<void> | null = null;

	/** Reads the store again; asked while a read is under way, one more follows it, shared by everyone who asked meanwhile. */
	function refresh(): Promise<void> {
		if (!scanning) {
			scanning = scan().finally(() => {
				scanning = null;
			});
			return scanning;
		}
		queued ??= scanning
			.catch(() => undefined)
			.then(() => {
				queued = null;
				return refresh();
			});
		return queued;
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
	/** The presence index to read and refresh, shared with the rest of the runtime; one of its own by default. */
	index?: PresenceIndex;
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
	const index = options.index ?? createPresenceIndex(options.root, clock);
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
