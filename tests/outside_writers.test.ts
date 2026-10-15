import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyElsewhere,
	createProcessCache,
	isAlive,
	isPiCommand,
	listPiProcesses,
	parseElapsed,
	parseLsofCwds,
	parsePsListing,
	QUIET_AFTER_MS,
	stopProcess,
	writersOf,
	type PiProcess,
} from "../src/outside-writers.ts";

const tempDirs: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-writers-"));
	tempDirs.push(dir);
	return dir;
}

function pi(pid: number, cwd: string, startedAtMs: number, pgid = pid): PiProcess {
	return { pid, pgid, command: "pi", cwd, startedAtMs };
}

/** A process `ps` lists as pi, the way pi's own process.title makes it show. */
function spawnFakePi(cwd: string, ownGroup = false): Bun.Subprocess {
	const child = Bun.spawn({
		cmd: ["node", "-e", 'process.title = "pi"; setInterval(() => {}, 1000);'],
		cwd,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		...(ownGroup ? { detached: true } : {}),
	});
	children.push(child);
	return child;
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value) || Date.now() > deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe("outside writers", () => {
	test("parses ps and lsof listings", () => {
		expect(parseElapsed("00:07")).toBe(7_000);
		expect(parseElapsed("12:34")).toBe(754_000);
		expect(parseElapsed("01:00:00")).toBe(3_600_000);
		expect(parseElapsed("2-00:00:01")).toBe(172_801_000);
		expect(parseElapsed("soon")).toBeNull();

		const now = 1_000_000_000;
		const listing = ["  101   101   00:05 pi", "  102   90 1:00:00 /Library/Application Support/thing helper", "garbage", "  103   103   xx:yy pi", ""].join("\n");
		expect(parsePsListing(listing, now)).toEqual([
			{ pid: 101, pgid: 101, command: "pi", startedAtMs: now - 5_000 },
			{ pid: 102, pgid: 90, command: "/Library/Application Support/thing helper", startedAtMs: now - 3_600_000 },
		]);

		expect(parseLsofCwds("p12\nfcwd\nn/a b/c\np13\nfcwd\nn/d\npbad\nn/e\n")).toEqual(
			new Map([
				[12, "/a b/c"],
				[13, "/d"],
			]),
		);
		expect(isPiCommand("pi")).toBe(true);
		expect(isPiCommand("/tmp/x/pi")).toBe(true);
		expect(isPiCommand("pi-rpc")).toBe(true);
		expect(isPiCommand("pip")).toBe(false);
		expect(isPiCommand("node")).toBe(false);
	});

	test("a writer works in the session's folder, as given or resolved, and started before its last write", async () => {
		const root = await tempDir();
		const real = join(root, "repo");
		await mkdir(real);
		const link = join(root, "link");
		await symlink(real, link);
		const processes = [pi(1, real, 1_000), pi(2, join(real, "sub"), 1_000), pi(3, real, 50_000), pi(4, "/elsewhere", 1_000)];

		expect(writersOf(processes, { cwd: real, lastWriteMs: 10_000 }).map((proc) => proc.pid)).toEqual([1]);
		expect(writersOf(processes, { cwd: link, lastWriteMs: 10_000 }).map((proc) => proc.pid)).toEqual([1]);
		expect(writersOf(processes, { cwd: real, lastWriteMs: 49_000 }).map((proc) => proc.pid)).toEqual([1, 3]);
		expect(writersOf(processes, { cwd: "/nowhere", lastWriteMs: 10_000 })).toEqual([]);
	});

	test("classifies open turns by who is left to write them", () => {
		const now = 10 * QUIET_AFTER_MS;
		const writer = [pi(1, "/r", 0)];
		expect(classifyElsewhere("done", now, writer, now)).toBeNull();
		expect(classifyElsewhere("thinking", now - 1_000, writer, now)).toBe("running");
		expect(classifyElsewhere("running_tools", now - QUIET_AFTER_MS, writer, now)).toBe("quiet");
		expect(classifyElsewhere("thinking", now - 1_000, [], now)).toBe("stopped");
		expect(classifyElsewhere("thinking", now - 1_000, null, now)).toBe("running");
		expect(classifyElsewhere("thinking", now - QUIET_AFTER_MS, null, now)).toBe("quiet");
	});

	test("stops a group leader with its group and escalates when TERM is ignored", async () => {
		const sent: Array<[number, string]> = [];
		let aliveChecks = 0;
		const stopped = await stopProcess(pi(40, "/r", 0), {
			graceMs: 100,
			signal: (target, name) => sent.push([target, name]),
			alive: () => ++aliveChecks < 3,
		});
		expect(stopped).toBe("stopped");
		expect(sent).toEqual([[-40, "SIGTERM"]]);

		const stubborn: Array<[number, string]> = [];
		const result = await stopProcess(pi(41, "/r", 0, 7), { graceMs: 60, killWaitMs: 60, signal: (target, name) => stubborn.push([target, name]), alive: () => true });
		expect(result).toBe("alive");
		expect(stubborn).toEqual([
			[41, "SIGTERM"],
			[41, "SIGKILL"],
		]);
	});

	test("caches one listing for every caller until it expires or is invalidated", async () => {
		let calls = 0;
		const cache = createProcessCache(async () => {
			calls += 1;
			return [];
		}, 60_000);
		await Promise.all([cache.list(), cache.list()]);
		expect(calls).toBe(1);
		cache.invalidate();
		await cache.list();
		expect(calls).toBe(2);

		const failing = createProcessCache(() => Promise.reject(new Error("no ps")), 60_000);
		expect(await failing.list()).toBeNull();
	});

	test("finds a real pi process by its folder and stops it", async () => {
		const cwd = await tempDir();
		const child = spawnFakePi(cwd, true);
		const found = await eventually(
			async () => (await listPiProcesses())?.filter((proc) => proc.cwd === cwd) ?? [],
			(list) => list.length === 1,
		);
		expect(found.map((proc) => [proc.pid, proc.command])).toEqual([[child.pid, "pi"]]);
		expect(found[0]!.pgid).toBe(child.pid);
		expect(Math.abs(found[0]!.startedAtMs - Date.now())).toBeLessThan(10_000);

		expect(await stopProcess(found[0]!, { graceMs: 3_000 })).toBe("stopped");
		await child.exited;
		expect(isAlive(child.pid)).toBe(false);
		expect((await listPiProcesses())?.filter((proc) => proc.cwd === cwd)).toEqual([]);
	});
});
