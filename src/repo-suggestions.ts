import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isInsideFolder } from "./directories.ts";
import type { SessionFolder } from "./session-index.ts";

/**
 * Folders pi has been used in that aren't saved repos, for the canvas launcher to offer. Scratch folders don't count: temp
 * dirs (test runs leave hundreds) and pi-web's own test folders wherever TMPDIR points. pfs forks (~/.pfs/forks/<repo>/<n>) do:
 * they're removed when done with, so the ones still there are in use.
 */

export const REPO_SUGGESTION_LIMIT = 100;

const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"];
const TEST_FOLDER = /(^|\/)pi-web-[^/]*(e2e|test)[^/]*(\/|$)/;

/** The system temp roots plus this process's temp dir, as given and with symlinks resolved. */
export function defaultScratchRoots(): string[] {
	const temp = tmpdir();
	let real = temp;
	try {
		real = realpathSync(temp);
	} catch {
		// keep the path as given
	}
	return [...new Set([...TEMP_ROOTS, temp, real])];
}

export function isScratchFolder(cwd: string, scratchRoots: readonly string[]): boolean {
	return scratchRoots.some((root) => isInsideFolder(cwd, root)) || TEST_FOLDER.test(cwd);
}

/** Absolute, not saved, not scratch; newest session first. Whether each still exists is the caller's check. */
export function pickRepoSuggestions(folders: readonly SessionFolder[], saved: ReadonlySet<string>, scratchRoots: readonly string[]): SessionFolder[] {
	return folders
		.filter((folder) => folder.cwd.startsWith("/") && !saved.has(folder.cwd) && !isScratchFolder(folder.cwd, scratchRoots))
		.sort((a, b) => b.lastWriteMs - a.lastWriteMs);
}
