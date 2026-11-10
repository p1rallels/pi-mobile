import { readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The filesystem calls realTarget makes; both throw when the path can't be resolved or isn't a symlink. */
export interface PathLookup {
	realpath(path: string): string;
	readlink(path: string): string;
}

// .native canonicalizes case on macOS (~/.PI-WEB comes back as ~/.pi-web); node's JS realpath doesn't
const diskLookup: PathLookup = {
	realpath: (path) => realpathSync.native(path),
	readlink: (path) => readlinkSync(path),
};

/** macOS and Windows volumes are case-insensitive by default: ~/.SSH is ~/.ssh there, even before it exists. */
export const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const MAX_RESOLVE_STEPS = 1024;

/**
 * The path the SDK's file tools (read, write, edit, grep, find, ls) open for `raw`: pi-coding-agent's resolveToCwd
 * (dist/utils/paths.js normalizePath with stripAtPrefix and normalizeUnicodeSpaces). Unicode spaces become spaces, one
 * leading `@` goes, then `~` and `~/` expand, or a `file://` URL becomes its path. Throws on a file URL the SDK can't
 * take either.
 */
export function toolPath(cwd: string, raw: string, home = homedir()): string {
	const path = expandTilde(stripAt(raw.replace(UNICODE_SPACES, " ")), home);
	const local = path.startsWith("file://") ? fileURLToPath(path) : path;
	return isAbsolute(local) ? resolve(local) : resolve(expandTilde(cwd, home), local);
}

function stripAt(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** read's fallbacks when the path isn't there (dist/core/tools/path-utils.js resolveReadPath): macOS screenshot AM/PM, NFD, curly quotes. */
export function readVariants(path: string): string[] {
	const nfd = path.normalize("NFD");
	const curly = (text: string) => text.replace(/'/g, "\u2019");
	return [...new Set([path, path.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(path), curly(nfd)])];
}

/**
 * Where an absolute path really lands: the realpath of its longest existing prefix plus the rest, so a file that
 * doesn't exist yet under a symlinked folder resolves too, and a dangling symlink resolves to the file a write
 * would create. Falls back to the path as given when nothing resolves.
 */
export function realTarget(path: string, lookup: PathLookup = diskLookup): string {
	const given = resolve(path);
	let head = given;
	let rest: string[] = [];
	for (let step = 0; step < MAX_RESOLVE_STEPS; step += 1) {
		const real = attempt(() => lookup.realpath(head));
		if (real !== undefined) return join(real, ...rest);
		const link = attempt(() => lookup.readlink(head));
		if (link !== undefined) {
			head = resolve(dirname(head), link);
			continue;
		}
		const parent = dirname(head);
		if (parent === head) return given;
		rest = [basename(head), ...rest];
		head = parent;
	}
	return given;
}

function attempt<T>(run: () => T): T | undefined {
	try {
		return run();
	} catch {
		return undefined;
	}
}

/** Whether `target` is `root` or below it; both absolute. */
export function isWithin(target: string, root: string, foldCase = false): boolean {
	const fold = (path: string) => (foldCase ? resolve(path).toLowerCase() : resolve(path));
	const normalizedTarget = fold(target);
	const normalizedRoot = fold(root);
	if (normalizedRoot === sep) return true;
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

/** A path as written and where it really lands, without repeats. */
export function pathForms(path: string, lookup: PathLookup = diskLookup): string[] {
	const lexical = resolve(path);
	return [...new Set([lexical, realTarget(lexical, lookup)])];
}
