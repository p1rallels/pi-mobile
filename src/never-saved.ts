// A session nobody sent a message to was never saved: pi writes a session's file with its first message, like
// the cli (open pi, type nothing, quit: nothing is logged). Once such a session stops running (a restart, an
// eviction at the cap), its path has nothing behind it, so there is nothing to resume: the page that had it open
// starts a new session in the same folder instead. A deleted file reads the same, which ends the same way.
import { basename, dirname, extname } from "node:path";
import { sessionDirForCwd } from "./session-index.ts";
import type { ApiNeverSaved } from "./types.ts";

export interface NeverSavedCheck {
	/** The resolved sessions root; session files sit one folder below it. */
	sessionsDir: string;
	/** Folders sessions may start in: the one whose session folder holds the path is where it ran. */
	folders: Iterable<string>;
	exists: (path: string) => boolean;
	/** When given, the file name must be pi's for this session (`<time>_<id>.jsonl`). */
	sessionId?: string;
}

/** A resolved session path with no file behind it, and the folder it ran in when exactly one folder maps to its session folder. */
export function classifyNeverSaved(path: string, check: NeverSavedCheck): ApiNeverSaved | null {
	const dir = dirname(path);
	if (dirname(dir) !== check.sessionsDir || extname(path) !== ".jsonl") return null;
	if (check.sessionId !== undefined && !basename(path).endsWith(`_${check.sessionId}.jsonl`)) return null;
	if (check.exists(path)) return null;
	const matches = [...new Set(check.folders)].filter((folder) => sessionDirForCwd(check.sessionsDir, folder) === dir);
	return { neverSaved: true, cwd: matches.length === 1 ? (matches[0] ?? null) : null };
}
