// Face ID logouts: when each browser (its client id) last logged out. A Face ID check that browser passed at or before
// its cutoff no longer counts, whichever cookie carries it, and the cutoffs outlive restarts (the cookie key does too).
// A cutoff can't matter once every check it covers has run out, a Face ID session length after it, so it's dropped then.
// Stored in PI_WEB_HOME/faceid-logouts.json with atomic writes. A file that can't be read stops the server from starting:
// starting with no logouts would bring logged-out cookies back.
import { lstat } from "node:fs/promises";
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";

/** client id → logout time (ms since epoch). */
export type LogoutCutoffs = ReadonlyMap<string, number>;

export interface LogoutCutoffsFile {
	version: 1;
	cutoffs: Record<string, number>;
}

export interface FaceIdLogouts {
	isLoggedOut(clientId: string, verifiedAt: number): boolean;
	/** Holds at once; resolves when saved. If saving fails it rejects, and the cutoff holds only until a restart. */
	logOut(clientIds: readonly string[], at: number): Promise<void>;
}

export function isLoggedOut(cutoffs: LogoutCutoffs, clientId: string, verifiedAt: number): boolean {
	const cutoff = cutoffs.get(clientId);
	return cutoff !== undefined && verifiedAt <= cutoff;
}

/** A cutoff only moves forward: a logout never revives a check an earlier logout ended. */
export function withLogout(cutoffs: LogoutCutoffs, clientIds: readonly string[], at: number): LogoutCutoffs {
	const next = new Map(cutoffs);
	for (const clientId of clientIds) next.set(clientId, Math.max(next.get(clientId) ?? at, at));
	return next;
}

/** Drops cutoffs whose checks have all run out: each covers checks from at or before it, which last `sessionTtlMs`. */
export function pruneCutoffs(cutoffs: LogoutCutoffs, now: number, sessionTtlMs: number): LogoutCutoffs {
	return new Map([...cutoffs].filter(([, at]) => at + sessionTtlMs > now));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCutoffsFile(raw: unknown): LogoutCutoffs {
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.cutoffs)) throw new Error("not a version 1 Face ID logouts file");
	const entries = Object.entries(raw.cutoffs);
	const bad = entries.find(([clientId, at]) => clientId.length === 0 || typeof at !== "number" || !Number.isFinite(at));
	if (bad) throw new Error(`bad cutoff for client ${JSON.stringify(bad[0])}`);
	return new Map(entries as [string, number][]);
}

export function cutoffsFile(cutoffs: LogoutCutoffs): LogoutCutoffsFile {
	return { version: 1, cutoffs: Object.fromEntries(cutoffs) };
}

async function isMissing(path: string): Promise<boolean> {
	return lstat(path).then(
		() => false,
		(error: unknown) => isMissingFileError(error),
	);
}

/**
 * No file yet means no logouts; anything else unreadable throws, saying what to do about it. Missing is checked first:
 * the private-state reader refuses symlinked ancestors before it gets to ENOENT, and a dev home under one (macOS's
 * /var/folders temp dirs) has never saved a logout anyway, since the writer refuses them too.
 */
export async function loadCutoffs(path: string): Promise<LogoutCutoffs> {
	if (await isMissing(path)) return new Map();
	try {
		return parseCutoffsFile(await readPrivateJsonFile(path));
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Can't read the Face ID logouts in ${path} (${cause}). pi-web won't start without them, or logged-out Face ID ` +
				"cookies would work again. Repair the file, or delete it together with the cookie-key file next to it, which signs every browser out.",
			{ cause: error },
		);
	}
}

/** Loads the cutoffs and keeps them saved; saves run one at a time, each writing everything recorded so far. */
export async function openFaceIdLogouts(path: string, sessionTtlMs: number, now = Date.now()): Promise<FaceIdLogouts> {
	let cutoffs = pruneCutoffs(await loadCutoffs(path), now, sessionTtlMs);
	let saving: Promise<void> = Promise.resolve();
	return {
		isLoggedOut: (clientId, verifiedAt) => isLoggedOut(cutoffs, clientId, verifiedAt),
		logOut(clientIds, at) {
			if (clientIds.length === 0) return Promise.resolve();
			cutoffs = pruneCutoffs(withLogout(cutoffs, clientIds, at), at, sessionTtlMs);
			const save = saving.catch(() => undefined).then(() => writePrivateJsonFile(path, cutoffsFile(cutoffs)));
			saving = save;
			return save;
		},
	};
}
