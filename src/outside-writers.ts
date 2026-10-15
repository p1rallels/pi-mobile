import { existsSync, realpathSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { isOpenTurn, type Turn } from "./session-turn.ts";

/**
 * pi processes pi-web doesn't host, found by working folder: a terminal pi, a `pi -p` started by pfs or a
 * script. pi titles its process "pi" (or "pi-rpc"), which `ps` shows, and never changes folder, so the
 * folder a session file names is where its writer works. pi doesn't keep the file open between writes,
 * so nothing ties a process to one file: a process counts for a session when it works in the session's
 * folder and started before the session's last write.
 */
export interface PiProcess {
	pid: number;
	pgid: number;
	command: string;
	cwd: string;
	startedAtMs: number;
}

/** null when pi-web can't list processes here; callers treat that as "maybe someone". */
export type ListPiProcesses = () => Promise<PiProcess[] | null>;

/** An open turn with a writer still around; quiet once it hasn't written for a while. */
export type ElsewhereState = "running" | "quiet" | "stopped";

/** No write for this long and a long tool call is as likely as a pi killed next to another one in the same folder. */
export const QUIET_AFTER_MS = 30 * 60_000;

/** `ps` reports elapsed time in whole seconds, so a start can read up to a second late. */
const START_SLACK_MS = 2_000;
const COMMAND_TIMEOUT_MS = 3_000;
const LISTING_TTL_MS = 2_000;
const PI_COMMANDS: ReadonlySet<string> = new Set(["pi", "pi-rpc"]);
const LSOF_PATHS = ["/usr/sbin/lsof", "/usr/bin/lsof"];

interface PsRow {
	pid: number;
	pgid: number;
	command: string;
	startedAtMs: number;
}

/** `[[dd-]hh:]mm:ss`, the BSD and procps `etime` column. */
export function parseElapsed(raw: string): number | null {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim());
	if (!match) return null;
	const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map((part) => Number.parseInt(part ?? "0", 10));
	return (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000;
}

function baseName(command: string): string {
	return command.slice(command.lastIndexOf("/") + 1);
}

export function isPiCommand(command: string): boolean {
	return PI_COMMANDS.has(baseName(command.trim()));
}

/** `ps -A -o pid=,pgid=,etime=,comm=` rows; the command is last and may hold spaces. */
export function parsePsListing(listing: string, nowMs: number): PsRow[] {
	return listing.split("\n").flatMap((line): PsRow[] => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
		if (!match) return [];
		const elapsed = parseElapsed(match[3]!);
		if (elapsed === null) return [];
		return [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[4]!.trim(), startedAtMs: nowMs - elapsed }];
	});
}

/** `lsof -Fpn` output: a `p<pid>` line opens each process, `n<path>` names its working folder. */
export function parseLsofCwds(listing: string): Map<number, string> {
	const cwds = new Map<number, string>();
	let pid: number | null = null;
	for (const line of listing.split("\n")) {
		if (line.startsWith("p")) {
			const parsed = Number.parseInt(line.slice(1), 10);
			pid = Number.isFinite(parsed) ? parsed : null;
		} else if (line.startsWith("n") && pid !== null && !cwds.has(pid)) {
			cwds.set(pid, line.slice(1));
		}
	}
	return cwds;
}

async function run(cmd: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
		try {
			const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			return stdout;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

async function cwdsFromProc(pids: readonly number[]): Promise<Map<number, string>> {
	const entries = await Promise.all(
		pids.map(async (pid) => {
			try {
				return [pid, await readlink(`/proc/${String(pid)}/cwd`)] as const;
			} catch {
				return null;
			}
		}),
	);
	return new Map(entries.filter((entry): entry is readonly [number, string] => entry !== null));
}

/** lsof exits 1 when a process left before it got to it; the ones it listed still count. */
async function cwdsFromLsof(pids: readonly number[]): Promise<Map<number, string> | null> {
	const lsof = LSOF_PATHS.find((path) => existsSync(path)) ?? "lsof";
	const listing = await run([lsof, "-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"]);
	return listing === null ? null : parseLsofCwds(listing);
}

/** Every pi process with its folder, from one `ps` and one `lsof` (or /proc on linux). */
export async function listPiProcesses(ownPid = process.pid, nowMs = Date.now()): Promise<PiProcess[] | null> {
	const listing = await run(["ps", "-A", "-o", "pid=,pgid=,etime=,comm="]);
	if (listing === null) return null;
	const rows = parsePsListing(listing, nowMs).filter((row) => row.pid !== ownPid && isPiCommand(row.command));
	if (rows.length === 0) return [];
	const pids = rows.map((row) => row.pid);
	const cwds = existsSync("/proc/self/cwd") ? await cwdsFromProc(pids) : await cwdsFromLsof(pids);
	if (cwds === null) return null;
	return rows.flatMap((row) => {
		const cwd = cwds.get(row.pid);
		return cwd ? [{ ...row, command: baseName(row.command), cwd }] : [];
	});
}

/** One listing shared by every caller for a couple of seconds: session lists poll, and so does each follower. */
export function createProcessCache(list: ListPiProcesses = () => listPiProcesses(), ttlMs = LISTING_TTL_MS) {
	let cached: { atMs: number; value: Promise<PiProcess[] | null> } | null = null;
	return {
		list(): Promise<PiProcess[] | null> {
			const now = Date.now();
			if (!cached || now - cached.atMs >= ttlMs) cached = { atMs: now, value: list().catch(() => null) };
			return cached.value;
		},
		invalidate(): void {
			cached = null;
		},
	};
}

/** The folder as given and as the filesystem resolves it: pi reports resolved paths, pi-web can file a session under the given one. */
export function folderForms(cwd: string): string[] {
	try {
		const resolved = realpathSync(cwd);
		return resolved === cwd ? [cwd] : [cwd, resolved];
	} catch {
		return [cwd];
	}
}

/** pi processes that may be writing a session: in its folder, and already running when it was last written. */
export function writersOf(processes: readonly PiProcess[], session: { cwd: string; lastWriteMs: number }): PiProcess[] {
	const folders = folderForms(session.cwd);
	return processes.filter((proc) => folders.includes(proc.cwd) && proc.startedAtMs <= session.lastWriteMs + START_SLACK_MS);
}

/**
 * Where a session pi-web isn't hosting stands: null once its turn closed. An open turn with nobody left to
 * write it (a pi killed mid-tool writes no closing message) is stopped. Unknown processes count as someone.
 */
export function classifyElsewhere(turn: Turn, lastWriteMs: number, writers: readonly PiProcess[] | null, nowMs = Date.now()): ElsewhereState | null {
	if (!isOpenTurn(turn)) return null;
	if (writers !== null && writers.length === 0) return "stopped";
	return nowMs - lastWriteMs >= QUIET_AFTER_MS ? "quiet" : "running";
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function exitedWithin(pid: number, ms: number, alive: (pid: number) => boolean): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (alive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return true;
}

export interface StopOptions {
	graceMs?: number;
	killWaitMs?: number;
	signal?: (target: number, signal: NodeJS.Signals) => void;
	alive?: (pid: number) => boolean;
}

/**
 * SIGTERM, then SIGKILL after a grace period. A pi that leads its process group (pfs runs every bg command
 * in its own group, shells do the same for jobs) is stopped with its group, so the tool it was running goes too.
 */
export async function stopProcess(proc: PiProcess, options: StopOptions = {}): Promise<"stopped" | "killed" | "alive"> {
	const signal = options.signal ?? ((target, name) => process.kill(target, name));
	const alive = options.alive ?? isAlive;
	const target = proc.pgid === proc.pid ? -proc.pid : proc.pid;
	const send = (name: NodeJS.Signals) => {
		try {
			signal(target, name);
		} catch {
			// gone already
		}
	};
	send("SIGTERM");
	if (await exitedWithin(proc.pid, options.graceMs ?? 5_000, alive)) return "stopped";
	send("SIGKILL");
	return (await exitedWithin(proc.pid, options.killWaitMs ?? 2_000, alive)) ? "killed" : "alive";
}
