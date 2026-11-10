import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";
import { executable } from "./exec-path.ts";

/**
 * pfs keeps a repo's forks in <forks dir>/<key>/<n> and writes the repo's own folder into <forks dir>/<key>/.main, the
 * forks dir being `[forks] dir` in $PFS_HOME/config.toml, else $PFS_HOME/forks ($PFS_HOME defaults to ~/.pfs). A session
 * folder there is fork n of that repo, named from `pfs ls --all --json` run in the repo once the repo's
 * .git/pfs/forks-dir names the folder back (pfs's own test for its forks). A .main anywhere else is just content: pfs's
 * listing stages each fork into a temporary index, so git would run the configured filters of whatever repo it lists.
 * pfs before 0.4 kept forks in <repo>/.forks/<n>; old sessions still name them, and they read from the path alone, with
 * no pfs (0.4 refuses those forks, and would migrate the repo's .forks on any command run there).
 */

const LEGACY_FORK_PATH = /^(.+)\/\.forks\/([1-9]\d*)(?:\/|$)/;
const FORK_NUMBER = /^[1-9]\d*$/;
const NAMES_TTL_MS = 60_000;
const PFS_TIMEOUT_MS = 3_000;

/** `root` is the repo's own folder, the one forked; `forks` its folder in pfs's forks dir. */
export type ForkPath =
	| { layout: "pfs"; root: string; forks: string; number: number }
	| { layout: "legacy"; root: string; number: number };

export interface PfsEnv {
	HOME?: string;
	PFS_HOME?: string;
}

/** $PFS_HOME, or ~/.pfs when it's unset or empty; null where pfs would refuse (a relative $PFS_HOME, no home). */
export function pfsHome(env: PfsEnv): string | null {
	if (env.PFS_HOME) return isAbsolute(env.PFS_HOME) ? env.PFS_HOME : null;
	return env.HOME ? join(env.HOME, ".pfs") : null;
}

/** The forks dir from $PFS_HOME/config.toml's text (null: no file), the way pfs reads it; null where pfs would refuse it. */
export function forksDirFrom(home: string, config: string | null, env: PfsEnv): string | null {
	if (config === null) return join(home, "forks");
	let doc: unknown;
	try {
		doc = Bun.TOML.parse(config);
	} catch {
		return null;
	}
	const forks = (doc as { forks?: unknown }).forks;
	const dir = forks && typeof forks === "object" ? (forks as { dir?: unknown }).dir : undefined;
	if (dir === undefined) return join(home, "forks");
	if (typeof dir !== "string") return null;
	if (dir.startsWith("~/")) return env.HOME ? join(env.HOME, dir.slice(2)) : null;
	return isAbsolute(dir) ? dir : null;
}

function readConfig(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Where pfs keeps forks for this process's environment, or null when pfs couldn't say. */
export function currentForksDir(env: PfsEnv = { HOME: process.env.HOME, PFS_HOME: process.env.PFS_HOME }): string | null {
	const home = pfsHome(env);
	if (!home) return null;
	try {
		return forksDirFrom(home, readConfig(join(home, "config.toml")), env);
	} catch {
		return null;
	}
}

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The forks dir as written and as resolved (/tmp is /private/tmp), so a session folder recorded either way matches. */
function forksRoots(dir: string | null): string[] {
	return dir ? [...new Set([normalize(dir), realPath(dir)])] : [];
}

/** The repo a pfs forks folder belongs to: the absolute path on its .main's first line, or null. */
function readMain(forks: string): string | null {
	try {
		const main = readFileSync(join(forks, ".main"), "utf8").split("\n")[0]!.trim();
		return isAbsolute(main) ? main : null;
	} catch {
		return null;
	}
}

/** <root>/<key>/<n>[/…] with a .main in <root>/<key>; nothing deeper counts. */
function pfsFork(path: string, root: string, mainOf: (forks: string) => string | null): ForkPath | null {
	if (!path.startsWith(`${root}/`)) return null;
	const [key, number] = path.slice(root.length + 1).split("/");
	if (!key || !number || !FORK_NUMBER.test(number)) return null;
	const forks = join(root, key);
	const main = mainOf(forks);
	return main ? { layout: "pfs", root: main, forks, number: Number(number) } : null;
}

/** @param roots pfs's forks dir (as written and resolved), the only place a .main counts */
export function parseForkPath(cwd: string, roots: readonly string[], mainOf: (forks: string) => string | null = readMain): ForkPath | null {
	if (!isAbsolute(cwd)) return null;
	const path = normalize(cwd);
	const legacy = LEGACY_FORK_PATH.exec(path);
	if (legacy) return { layout: "legacy", root: legacy[1]!, number: Number(legacy[2]) };
	return roots.map((root) => pfsFork(path, root.replace(/\/+$/, ""), mainOf)).find((fork) => fork !== null) ?? null;
}

/** `pfs ls --json` prints one object per fork: its number and label ("8-hooks"). */
export function parseForkNames(listing: string): Map<number, string> {
	const names = new Map<number, string>();
	for (const line of listing.split("\n")) {
		try {
			const fork = JSON.parse(line) as { id?: unknown; label?: unknown };
			if (typeof fork.id === "number" && typeof fork.label === "string" && fork.label.trim()) names.set(fork.id, fork.label.trim());
		} catch {
			// not a fork line
		}
	}
	return names;
}

export function forkLabel(fork: ForkPath, names: ReadonlyMap<number, string>): string {
	return `${basename(fork.root)} · fork ${names.get(fork.number) ?? String(fork.number)}`;
}

/** pfs's own test that `forks` is `main`'s: main is a repo whose .git/pfs/forks-dir names that folder. */
function claims(main: string, forks: string): boolean {
	try {
		if (!statSync(join(main, ".git")).isDirectory()) return false;
		const record = readFileSync(join(main, ".git", "pfs", "forks-dir"), "utf8").split("\n")[0]!.trim();
		return isAbsolute(record) && realPath(record) === realPath(forks);
	} catch {
		return false;
	}
}

async function listForks(root: string): Promise<string | null> {
	const pfs = executable("pfs", [join(homedir(), ".cargo", "bin")]);
	if (!pfs) return null;
	try {
		const proc = Bun.spawn({ cmd: [pfs, "ls", "--all", "--json"], cwd: root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill(), PFS_TIMEOUT_MS);
		try {
			const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			return code === 0 ? stdout : null;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

/**
 * Labels for fork folders. pfs's forks dir is resolved again at most once a ttl, and each repo's fork names are cached as
 * long; pfs runs only for a fork under that dir whose repo claims it.
 */
export function createForkLabels(list: (root: string) => Promise<string | null> = listForks, ttlMs = NAMES_TTL_MS, forksDir: () => string | null = currentForksDir) {
	const cache = new Map<string, { atMs: number; names: Promise<Map<number, string>> }>();
	let roots: { atMs: number; dirs: string[] } | null = null;

	function currentRoots(): string[] {
		if (!roots || Date.now() - roots.atMs >= ttlMs) roots = { atMs: Date.now(), dirs: forksRoots(forksDir()) };
		return roots.dirs;
	}

	function namesFor(fork: ForkPath): Promise<Map<number, string>> {
		if (fork.layout === "legacy") return Promise.resolve(new Map<number, string>());
		const cached = cache.get(fork.forks);
		if (cached && Date.now() - cached.atMs < ttlMs) return cached.names;
		const names = claims(fork.root, fork.forks)
			? list(fork.root).then((listing) => (listing === null ? new Map<number, string>() : parseForkNames(listing))).catch(() => new Map<number, string>())
			: Promise.resolve(new Map<number, string>());
		cache.set(fork.forks, { atMs: Date.now(), names });
		return names;
	}

	return {
		async label(cwd: string): Promise<string | undefined> {
			const fork = parseForkPath(cwd, currentRoots());
			return fork ? forkLabel(fork, await namesFor(fork)) : undefined;
		},
	};
}
