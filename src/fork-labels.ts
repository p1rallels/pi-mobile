import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * pfs keeps forks of a repo in <repo>/.forks/<n>, so a session's folder says which fork it ran in. The fork's
 * name comes from `pfs ls --all --json` in the repo; without pfs the number alone still reads fine.
 */

const FORK_PATH = /^(.+)\/\.forks\/(\d+)(?:\/|$)/;
const NAMES_TTL_MS = 60_000;
const PFS_TIMEOUT_MS = 3_000;

export interface ForkPath {
	root: string;
	number: number;
}

export function parseForkPath(cwd: string): ForkPath | null {
	const match = FORK_PATH.exec(cwd);
	return match ? { root: match[1]!, number: Number(match[2]) } : null;
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

function pfsBinary(): string {
	const cargo = join(homedir(), ".cargo", "bin", "pfs");
	return existsSync(cargo) ? cargo : "pfs";
}

async function listForks(root: string): Promise<string | null> {
	try {
		const proc = Bun.spawn({ cmd: [pfsBinary(), "ls", "--all", "--json"], cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
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

/** Labels for fork folders, with each repo's fork names cached for a minute. */
export function createForkLabels(list: (root: string) => Promise<string | null> = listForks, ttlMs = NAMES_TTL_MS) {
	const cache = new Map<string, { atMs: number; names: Promise<Map<number, string>> }>();

	function namesFor(root: string): Promise<Map<number, string>> {
		const cached = cache.get(root);
		if (cached && Date.now() - cached.atMs < ttlMs) return cached.names;
		const names = existsSync(join(root, ".forks"))
			? list(root).then((listing) => (listing === null ? new Map<number, string>() : parseForkNames(listing))).catch(() => new Map<number, string>())
			: Promise.resolve(new Map<number, string>());
		cache.set(root, { atMs: Date.now(), names });
		return names;
	}

	return {
		async label(cwd: string): Promise<string | undefined> {
			const fork = parseForkPath(cwd);
			return fork ? forkLabel(fork, await namesFor(fork.root)) : undefined;
		},
	};
}
