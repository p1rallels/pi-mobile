import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Folder completion for the canvas launcher: list what a typed /path or ~/path could continue with, and make one new folder. */

export const DIRECTORY_LIMIT = 50;
const MAX_TYPED_PATH = 4096;
const MAX_FOLDER_NAME = 255;

export interface DirectoryEntry {
	name: string;
	path: string;
}

export interface DirectoryListing {
	/** The typed path, absolute. */
	path: string;
	exists: boolean;
	/** The folder listed: everything up to the typed path's last slash. */
	parent: string;
	parentExists: boolean;
	/** The listed folder resolves inside the home folder, so a new name typed in it could be created. */
	insideHome: boolean;
	/** The typed path is missing, its parent isn't, and it would land inside the home folder. */
	canCreate: boolean;
	/** Subfolders of parent starting with the typed name (any case), sorted, at most DIRECTORY_LIMIT. */
	entries: DirectoryEntry[];
	truncated: boolean;
}

/** An absolute folder path; a leading ~ means the home folder of the user running pi-web. */
export function normalizeCwd(input: string, home = homedir()): string {
	const trimmed = input.trim();
	if (trimmed === "~") return resolve(home);
	if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2));
	return resolve(trimmed);
}

/** A path the launcher may ask about: /… , ~ or ~/… */
export function isTypedPath(input: string): boolean {
	const trimmed = input.trim();
	return trimmed.length <= MAX_TYPED_PATH && !trimmed.includes("\0") && /^(\/|~(\/|$))/.test(trimmed);
}

/** The folder a typed path lists (through its last slash) and the name typed after it; "~" lists the home folder. */
export function splitTypedPath(typed: string, home = homedir()): { parent: string; leaf: string; path: string } {
	const trimmed = typed.trim();
	const text = trimmed === "~" ? "~/" : trimmed;
	const cut = text.lastIndexOf("/") + 1;
	return { parent: normalizeCwd(text.slice(0, cut), home), leaf: text.slice(cut), path: normalizeCwd(text, home) };
}

/** Starts with the typed name in any case; hidden folders only once the name starts with a dot. */
export function matchesLeaf(name: string, leaf: string): boolean {
	if (name.startsWith(".") && !leaf.startsWith(".")) return false;
	return name.toLowerCase().startsWith(leaf.toLowerCase());
}

const byName = (a: string, b: string): number => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }) || a.localeCompare(b);

/** A name mkdir can take as one new folder. */
export function isCreatableName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_FOLDER_NAME && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

export function isInsideFolder(path: string, folder: string): boolean {
	return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

export async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Subfolder names of `parent` that match `leaf`, following symlinks to folders; [] when it can't be read. */
async function matchingSubfolders(parent: string, leaf: string): Promise<string[]> {
	let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
	try {
		entries = await readdir(parent, { withFileTypes: true });
	} catch {
		return [];
	}
	const candidates = entries.filter((entry) => matchesLeaf(entry.name, leaf) && (entry.isDirectory() || entry.isSymbolicLink()));
	const folders = await Promise.all(candidates.map(async (entry) => (entry.isDirectory() || (await isDirectory(join(parent, entry.name))) ? entry.name : null)));
	return folders.filter((name): name is string => name !== null).sort(byName);
}

/** The folder, symlinks resolved, is home or inside it. */
async function resolvesInsideHome(folder: string, home: string): Promise<boolean> {
	try {
		return isInsideFolder(await realpath(folder), await realpath(home));
	} catch {
		return false;
	}
}

/** Nothing at all is there, not even a file or a dangling link. */
async function isFree(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		return errorCode(error) === "ENOENT";
	}
}

async function canCreateFolder(path: string, home: string): Promise<boolean> {
	const parent = dirname(path);
	return isCreatableName(basename(path)) && (await isDirectory(parent)) && (await resolvesInsideHome(parent, home)) && (await isFree(path));
}

export async function listDirectories(typed: string, options: { home?: string; limit?: number } = {}): Promise<DirectoryListing> {
	const home = options.home ?? homedir();
	const limit = options.limit ?? DIRECTORY_LIMIT;
	const { parent, leaf, path } = splitTypedPath(typed, home);
	const [exists, parentExists, names] = await Promise.all([isDirectory(path), isDirectory(parent), matchingSubfolders(parent, leaf)]);
	return {
		path,
		exists,
		parent,
		parentExists,
		insideHome: parentExists && (await resolvesInsideHome(parent, home)),
		canCreate: !exists && (await canCreateFolder(path, home)),
		entries: names.slice(0, limit).map((name) => ({ name, path: join(parent, name) })),
		truncated: names.length > limit,
	};
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Makes one folder inside the home folder and returns it (absolute). Its parent has to exist, so a typo can't spawn a chain
 * of folders, and has to resolve inside home, so neither .. nor a symlinked parent escapes it. An existing folder is fine.
 */
export async function createFolderInHome(typed: string, home = homedir()): Promise<string> {
	const path = normalizeCwd(typed, home);
	if (await isDirectory(path)) return path;
	const name = basename(path);
	if (!isCreatableName(name)) throw new Error(`can't create a folder at ${path}`);
	const parent = dirname(path);
	if (!(await isDirectory(parent))) throw new Error(`parent folder does not exist: ${parent}`);
	const realParent = await realpath(parent);
	if (!isInsideFolder(realParent, await realpath(home))) throw new Error(`new folders go inside the home folder (${home}), and ${parent} isn't`);
	try {
		await mkdir(join(realParent, name));
	} catch (error) {
		const code = errorCode(error);
		if (code === "EEXIST" && (await isDirectory(path))) return path;
		if (code === "EEXIST") throw new Error(`a file is in the way: ${path}`);
		throw new Error(`couldn't create ${path}${code ? ` (${code})` : ""}`);
	}
	return path;
}
