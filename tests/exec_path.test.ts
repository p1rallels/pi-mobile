import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absoluteDirs, executable, findExecutable } from "../src/exec-path.ts";

const tempDirs: string[] = [];
const savedPath = process.env.PATH;

afterEach(async () => {
	process.env.PATH = savedPath;
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("exec path", () => {
	test("only PATH's absolute entries count, in order, each once", () => {
		expect(absoluteDirs(".:/usr/bin::bin:./x:/bin:/usr/bin:~/bin")).toEqual(["/usr/bin", "/bin"]);
		expect(absoluteDirs("")).toEqual([]);
		expect(absoluteDirs(undefined)).toEqual([]);
	});

	test("finds the first executable file, or none", () => {
		const files = new Set(["/b/git", "/c/git"]);
		expect(findExecutable("git", ["/a", "/b", "/c"], (file) => files.has(file))).toBe("/b/git");
		expect(findExecutable("pfs", ["/a", "/b"], (file) => files.has(file))).toBeNull();
	});

	test("skips relative PATH entries, folders and files that can't run, then tries the fallback folders", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-exec-"));
		tempDirs.push(root);
		const [bin, plain, fallback] = ["bin", "plain", "fallback"].map((name) => join(root, name)) as [string, string, string];
		await mkdir(join(bin, "tool"), { recursive: true });
		await mkdir(plain);
		await mkdir(fallback);
		await writeFile(join(plain, "tool"), "not executable\n", { mode: 0o644 });
		await writeFile(join(fallback, "tool"), "#!/bin/sh\n", { mode: 0o755 });
		process.env.PATH = `.:${bin}:${plain}`;

		expect(executable("tool")).toBeNull();
		expect(executable("tool", [fallback])).toBe(join(fallback, "tool"));
		expect(executable("tool", ["fallback"])).toBeNull();
		process.env.PATH = `${fallback}:${bin}`;
		expect(executable("tool")).toBe(join(fallback, "tool"));
	});
});
