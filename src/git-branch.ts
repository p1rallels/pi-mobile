import { execFile } from "node:child_process";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * The git branch a session's folder is on, for the footer, read the way pi's own footer reads it: the HEAD file, found by
 * walking up to .git (a folder, or a worktree's "gitdir:" file), with git itself only for reftable repos. "detached" when
 * HEAD isn't on a branch, null outside git.
 */

export interface GitHead {
	repoDir: string;
	headPath: string;
}

const REFS_HEADS = "ref: refs/heads/";
const WATCH_DEBOUNCE_MS = 500;
const GIT_TIMEOUT_MS = 3_000;

/** HEAD for a .git in `dir`; undefined when `dir` has no .git (keep walking up), null when its .git has no HEAD (pi stops there too). */
function headAt(dir: string): GitHead | null | undefined {
	const gitPath = join(dir, ".git");
	let isFolder: boolean;
	try {
		isFolder = statSync(gitPath).isDirectory();
	} catch {
		return undefined;
	}
	try {
		if (isFolder) {
			statSync(join(gitPath, "HEAD"));
			return { repoDir: dir, headPath: join(gitPath, "HEAD") };
		}
		const content = readFileSync(gitPath, "utf8").trim();
		if (!content.startsWith("gitdir: ")) return undefined;
		const headPath = join(resolve(dir, content.slice(8).trim()), "HEAD");
		statSync(headPath);
		return { repoDir: dir, headPath };
	} catch {
		return null;
	}
}

export function findGitHead(cwd: string): GitHead | null {
	const dir = resolve(cwd);
	const found = headAt(dir);
	if (found !== undefined) return found;
	const parent = dirname(dir);
	return parent === dir ? null : findGitHead(parent);
}

/** The branch HEAD names, "detached" off a branch, or null for reftable's placeholder (only git knows then). */
export function branchOfHead(content: string): string | null {
	const text = content.trim();
	if (!text.startsWith(REFS_HEADS)) return "detached";
	const branch = text.slice(REFS_HEADS.length);
	return branch === ".invalid" ? null : branch;
}

function gitSymbolicRef(repoDir: string): Promise<string | null> {
	return new Promise((done) => {
		execFile("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoDir, encoding: "utf8", timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
			done(error ? null : stdout.trim() || null);
		});
	});
}

export async function readGitBranch(head: GitHead | null): Promise<string | null> {
	if (!head) return null;
	try {
		const branch = branchOfHead(await readFile(head.headPath, "utf8"));
		return branch ?? (await gitSymbolicRef(head.repoDir)) ?? "detached";
	} catch {
		return null;
	}
}

/** Without git: reftable repos read as unknown (null) until the async read asks git. */
function readGitBranchSync(head: GitHead | null): { branch: string | null; settled: boolean } {
	if (!head) return { branch: null, settled: true };
	try {
		const branch = branchOfHead(readFileSync(head.headPath, "utf8"));
		return { branch, settled: branch !== null };
	} catch {
		return { branch: null, settled: true };
	}
}

export interface GitBranchWatch {
	current(): string | null;
	/** Reads HEAD again soon (debounced): call it when something may have switched branches. */
	refresh(): void;
	dispose(): void;
}

/**
 * Keeps a folder's branch current: read now, then again whenever HEAD's folder changes (watched like pi's footer does: git
 * replaces HEAD by rename, so the folder is watched, not the file) or refresh() asks. onChange hears only real changes.
 */
export function watchGitBranch(cwd: string, onChange: (branch: string | null) => void, options: { debounceMs?: number } = {}): GitBranchWatch {
	const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
	const head = findGitHead(cwd);
	const initial = readGitBranchSync(head);
	let branch = initial.branch;
	let disposed = false;
	let reads = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let watcher: FSWatcher | null = null;

	async function reread(): Promise<void> {
		const mine = ++reads;
		const next = await readGitBranch(head);
		if (disposed || mine !== reads || next === branch) return;
		branch = next;
		onChange(next);
	}

	function refresh(): void {
		if (disposed || !head || timer) return;
		timer = setTimeout(() => {
			timer = null;
			void reread();
		}, debounceMs);
	}

	if (head) {
		try {
			watcher = watch(dirname(head.headPath), (_event, filename) => {
				if (!filename || filename === "HEAD") refresh();
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = null;
			});
		} catch {
			watcher = null;
		}
	}
	if (!initial.settled) refresh();

	return {
		current: () => branch,
		refresh,
		dispose() {
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = null;
			watcher?.close();
			watcher = null;
		},
	};
}
