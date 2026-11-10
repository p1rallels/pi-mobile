import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Where pi-web finds the tools it runs in a session's folder (git, pfs): by absolute path, from PATH's absolute entries
 * only. A relative entry ("." or an empty one, which a shell reads as ".") would find the tool in whatever folder it runs
 * in, so a session folder holding its own `git` would get it run.
 */

/** PATH's absolute folders, in order, each once. */
export function absoluteDirs(path: string | undefined): string[] {
	return [...new Set((path ?? "").split(":").filter((dir) => isAbsolute(dir)))];
}

function isExecutableFile(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The first `dirs/name` that's an executable file, or null. */
export function findExecutable(name: string, dirs: readonly string[], isExecutable: (file: string) => boolean = isExecutableFile): string | null {
	return dirs.map((dir) => join(dir, name)).find(isExecutable) ?? null;
}

const found = new Map<string, string | null>();

/** `name` from this process's PATH (absolute entries only), then `fallbackDirs`; looked up once per PATH, null when missing. */
export function executable(name: string, fallbackDirs: readonly string[] = []): string | null {
	const dirs = [...absoluteDirs(process.env.PATH), ...fallbackDirs.filter((dir) => isAbsolute(dir))];
	const key = [name, ...dirs].join("\0");
	if (!found.has(key)) found.set(key, findExecutable(name, dirs));
	return found.get(key) ?? null;
}
