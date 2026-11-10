import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultScratchRoots, isScratchFolder, pickRepoSuggestions } from "../src/repo-suggestions.ts";
import { createSessionFolders, sessionDirForCwd } from "../src/session-index.ts";
import { PiWebRuntime } from "../src/session-runtime.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	// not "pi-web-…": a random suffix with "e2e" or "test" in it would read as a pi-web test folder
	const dir = await mkdtemp(join(await realpath(tmpdir()), "suggestions-"));
	tempDirs.push(dir);
	return dir;
}

/** A session file in `cwd`, last written at `atMs`. */
async function writeSession(sessionsDir: string, cwd: string, id: string, atMs: number): Promise<string> {
	const dir = sessionDirForCwd(sessionsDir, cwd);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
	await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T10:00:00.000Z", cwd })}\n`);
	await utimes(path, atMs / 1000, atMs / 1000);
	return path;
}

const folder = (cwd: string, lastWriteMs: number, sessions = 1) => ({ cwd, lastWriteMs, sessions });

describe("scratch folders", () => {
	test("temp roots and pi-web test folders are scratch; pfs forks aren't", () => {
		const roots = ["/tmp", "/private/var/folders"];
		expect(isScratchFolder("/tmp", roots)).toBe(true);
		expect(isScratchFolder("/tmp/x/y", roots)).toBe(true);
		expect(isScratchFolder("/private/var/folders/j0/T/pi-web-canvas-e2e-abc/repo", roots)).toBe(true);
		expect(isScratchFolder("/Users/me/scratch/pi-web-runtime-test-1/repo", roots)).toBe(true);
		expect(isScratchFolder("/Users/me/cc/pi-web/.forks/3", roots)).toBe(false);
		expect(isScratchFolder("/Users/me/cc/pi-web", roots)).toBe(false);
		expect(isScratchFolder("/Users/me/cc/pi-web-live", roots)).toBe(false);
		expect(isScratchFolder("/Users/me/tmp-notes", roots)).toBe(false);
		expect(defaultScratchRoots()).toContain("/tmp");
	});

	test("suggestions are absolute, unsaved, not scratch, newest first", () => {
		const picked = pickRepoSuggestions(
			[folder("/Users/me/old", 1), folder("/Users/me/saved", 5), folder("/tmp/junk", 9), folder("/Users/me/new", 3), folder("relative", 4)],
			new Set(["/Users/me/saved"]),
			["/tmp"],
		);
		expect(picked.map((entry) => entry.cwd)).toEqual(["/Users/me/new", "/Users/me/old"]);
	});
});

describe("session folders", () => {
	test("groups session files by the cwd in their header, newest write first", async () => {
		const root = await tempRoot();
		const sessions = join(root, "sessions");
		await writeSession(sessions, "/w/app", "s1", 1_000_000);
		await writeSession(sessions, "/w/app", "s2", 3_000_000);
		await writeSession(sessions, "/w/lib", "s3", 2_000_000);
		await mkdir(join(sessions, "--w-partial--"));
		await writeFile(join(sessions, "--w-partial--", "half.jsonl"), '{"type":"session","cwd":"/w/half"');
		const folders = createSessionFolders(sessions);
		expect(await folders.list()).toEqual([folder("/w/app", 3_000_000, 2), folder("/w/lib", 2_000_000)]);

		await writeFile(join(sessions, "--w-partial--", "half.jsonl"), '{"type":"session","id":"s4","cwd":"/w/half"}\n');
		await utimes(join(sessions, "--w-partial--", "half.jsonl"), 500, 500);
		expect((await folders.list()).map((entry) => entry.cwd)).toEqual(["/w/app", "/w/lib", "/w/half"]);
		expect(await createSessionFolders(join(root, "missing")).list()).toEqual([]);
	});

	test("the runtime suggests folders pi ran in that still exist and aren't saved or scratch", async () => {
		const root = await tempRoot();
		const agentDir = join(root, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const work = join(root, "work");
		const [saved, fresh, older, gone, scratch] = ["saved", "fresh", "older", "gone", "scratch"].map((name) => join(work, name));
		const fork = join(work, "repo", ".forks", "2");
		for (const dir of [saved, fresh, older, join(scratch, "inner"), fork]) await mkdir(dir, { recursive: true });
		const sessions = join(agentDir, "sessions");
		const now = Date.now();
		await writeSession(sessions, saved, "a", now);
		await writeSession(sessions, fresh, "b", now - 1_000);
		await writeSession(sessions, fresh, "c", now - 90_000);
		await writeSession(sessions, older, "d", now - 60_000);
		await writeSession(sessions, gone, "e", now);
		await writeSession(sessions, join(scratch, "inner"), "f", now);
		await writeSession(sessions, fork, "g", now - 120_000);

		const runtime = new PiWebRuntime({ scratchRoots: [scratch], listForks: async () => '{"id":2,"label":"2-probe"}\n' });
		await runtime.addRepo(saved);
		const suggestions = await runtime.listRepoSuggestions();
		expect(suggestions.map((suggestion) => suggestion.cwd)).toEqual([fresh, older, fork]);
		expect(suggestions.map((suggestion) => suggestion.forkLabel)).toEqual([undefined, undefined, "repo · fork 2"]);
		expect(suggestions[0]?.sessions).toBe(2);
		expect(Math.abs(Date.parse(suggestions[0]?.modified ?? "") - (now - 1_000))).toBeLessThan(1_000);
		expect((await runtime.listRepoSuggestions(1)).map((suggestion) => suggestion.cwd)).toEqual([fresh]);

		await runtime.addRepo(fresh);
		expect((await runtime.listRepoSuggestions()).map((suggestion) => suggestion.cwd)).toEqual([older, fork]);
	});
});
