import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForkLabels, forkLabel, forksDirFrom, parseForkNames, parseForkPath, pfsHome, type ForkPath } from "../src/fork-labels.ts";

const tempDirs: string[] = [];
const savedEnv = { PATH: process.env.PATH, PFS_HOME: process.env.PFS_HOME };

afterEach(async () => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-forks-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * A pfs first on PATH that names fork 3 "3-web-subs" and notes each run, the folder and its arguments, one per line, in the
 * file it returns. `knowsNames: false` is a pfs from before `ls --names`: clap refuses the flag with exit 2.
 */
async function fakePfs(root: string, { knowsNames = true } = {}): Promise<string> {
	const bin = join(root, "bin");
	const ran = join(root, "pfs-ran");
	await mkdir(bin);
	const refuseNames = knowsNames ? "" : `case " $* " in *" --names "*) exit 2 ;; esac\n`;
	await writeFile(join(bin, "pfs"), `#!/bin/sh\necho "$(pwd -P) $*" >> '${ran}'\n${refuseNames}printf '%s\\n' '{"id":3,"label":"3-web-subs"}'\n`, { mode: 0o755 });
	process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`;
	return ran;
}

/** A repo whose .git/pfs/forks-dir names `forks`, and `forks`'s .main naming it back: what pfs new leaves. */
async function pfsRepo(repo: string, forks: string): Promise<void> {
	await mkdir(join(repo, ".git", "pfs"), { recursive: true });
	await mkdir(forks, { recursive: true });
	await writeFile(join(repo, ".git", "pfs", "forks-dir"), `${forks}\n`);
	await writeFile(join(forks, ".main"), `${repo}\n`);
}

describe("fork labels", () => {
	test("a legacy <repo>/.forks/<n> reads from the path alone", () => {
		expect(parseForkPath("/w/pfs-demo/.forks/8", [])).toEqual({ layout: "legacy", root: "/w/pfs-demo", number: 8 });
		expect(parseForkPath("/w/pfs-demo/.forks/12/src/deep", [])).toEqual({ layout: "legacy", root: "/w/pfs-demo", number: 12 });
		expect(parseForkPath("/w/pfs-demo/.forks/8-x", [])).toBeNull();
		expect(parseForkPath("/w/pfs-demo/.forks/0", [])).toBeNull();
		expect(parseForkPath("/w/pfs-demo/.forks", [])).toBeNull();
		expect(parseForkPath("/w/pfs-demo", [])).toBeNull();
	});

	test("a pfs fork is <forks dir>/<key>/<n> with a .main in <key>, and nowhere else", () => {
		const mains: Record<string, string> = { "/h/.pfs/forks/pfs-demo": "/w/pfs-demo", "/h/notes/2024": "/w/evil", "/h/.pfs/forks/pfs-demo/8/dl": "/w/evil" };
		const mainOf = (dir: string) => mains[dir] ?? null;
		const roots = ["/h/.pfs/forks"];
		const fork = (number: number): ForkPath => ({ layout: "pfs", root: "/w/pfs-demo", forks: "/h/.pfs/forks/pfs-demo", number });
		expect(parseForkPath("/h/.pfs/forks/pfs-demo/8", roots, mainOf)).toEqual(fork(8));
		expect(parseForkPath("/h/.pfs/forks/pfs-demo/12/src/3", roots, mainOf)).toEqual(fork(12));
		expect(parseForkPath("/h/.pfs/forks/pfs-demo/8/dl/3", roots, mainOf)).toEqual(fork(8));
		expect(parseForkPath("/h/.pfs/forks/pfs-demo/8/", ["/h/.pfs/forks/"], mainOf)).toEqual(fork(8));
		expect(parseForkPath("/h/.pfs/forks/pfs-demo", roots, mainOf)).toBeNull();
		expect(parseForkPath("/h/.pfs/forks/pfs-demo/08", roots, mainOf)).toBeNull();
		expect(parseForkPath("/h/.pfs/forks/other/8", roots, mainOf)).toBeNull();
		expect(parseForkPath("/h/notes/2024/3", roots, mainOf)).toBeNull();
		expect(parseForkPath("/h/.pfs/forks/../../notes/2024/3", roots, mainOf)).toBeNull();
		expect(parseForkPath("/h/.pfs/forks-old/pfs-demo/8", roots, mainOf)).toBeNull();
		expect(parseForkPath("h/.pfs/forks/pfs-demo/8", roots, mainOf)).toBeNull();
		expect(parseForkPath("/h/.pfs/forks/pfs-demo/8", [], mainOf)).toBeNull();
	});

	test("finds the forks dir the way pfs does: $PFS_HOME or ~/.pfs, then [forks] dir in its config.toml", () => {
		const env = { HOME: "/Users/me" };
		expect(pfsHome(env)).toBe("/Users/me/.pfs");
		expect(pfsHome({ ...env, PFS_HOME: "" })).toBe("/Users/me/.pfs");
		expect(pfsHome({ PFS_HOME: "/x/pfs" })).toBe("/x/pfs");
		expect(pfsHome({ ...env, PFS_HOME: "rel/pfs" })).toBeNull();
		expect(pfsHome({})).toBeNull();

		expect(forksDirFrom("/x/pfs", null, env)).toBe("/x/pfs/forks");
		expect(forksDirFrom("/x/pfs", "[ports]\nbase = 41000\n[forks]\n", env)).toBe("/x/pfs/forks");
		expect(forksDirFrom("/x/pfs", '[forks]\ndir = "/Volumes/fast/forks"\n', env)).toBe("/Volumes/fast/forks");
		expect(forksDirFrom("/x/pfs", '[forks]\ndir = "~/work/forks"\n', env)).toBe("/Users/me/work/forks");
		expect(forksDirFrom("/x/pfs", '[forks]\ndir = "~/work/forks"\n', {})).toBeNull();
		expect(forksDirFrom("/x/pfs", '[forks]\ndir = "forks"\n', env)).toBeNull();
		expect(forksDirFrom("/x/pfs", '[forks]\ndir = "~forks"\n', env)).toBeNull();
		expect(forksDirFrom("/x/pfs", "[forks]\ndir = 3\n", env)).toBeNull();
		expect(forksDirFrom("/x/pfs", "[forks\n", env)).toBeNull();
	});

	test("names forks from pfs ls --json and falls back to the number", () => {
		const names = parseForkNames(
			[
				'{"branch":"pfs/8-hooks","id":8,"label":"8-hooks","path":"/w/pfs-demo/.forks/8","removed":false}',
				'{"id":9,"label":"  "}',
				"not json",
				'{"id":"10","label":"10-x"}',
			].join("\n"),
		);
		expect(names).toEqual(new Map([[8, "8-hooks"]]));
		expect(forkLabel({ layout: "legacy", root: "/w/pfs-demo", number: 8 }, names)).toBe("pfs-demo · fork 8-hooks");
		expect(forkLabel({ layout: "pfs", root: "/w/pfs-demo", forks: "/h/.pfs/forks/pfs-demo", number: 9 }, names)).toBe("pfs-demo · fork 9");
	});

	test("asks pfs in the repo a forks folder's .main names, once while the names are fresh, and only when the repo claims the folder", async () => {
		const home = await tempRoot();
		const repo = join(home, "code", "pfs-demo");
		const forks = join(home, ".pfs", "forks", "pfs-demo");
		await pfsRepo(repo, forks);
		await mkdir(join(forks, "3"), { recursive: true });
		const unclaimed = join(home, ".pfs", "forks", "moved");
		await mkdir(join(home, "code", "moved", ".git", "pfs"), { recursive: true });
		await mkdir(join(unclaimed, "2"), { recursive: true });
		await writeFile(join(unclaimed, ".main"), `${join(home, "code", "moved")}\n`);
		const asked: string[] = [];
		const labels = createForkLabels(
			async (root) => {
				asked.push(root);
				return '{"id":3,"label":"3-wait"}\n';
			},
			60_000,
			() => join(home, ".pfs", "forks"),
		);

		expect(await labels.label(join(forks, "3"))).toBe("pfs-demo · fork 3-wait");
		expect(await labels.label(join(forks, "3", "src"))).toBe("pfs-demo · fork 3-wait");
		expect(await labels.label(join(forks, "4"))).toBe("pfs-demo · fork 4");
		expect(await labels.label(join(unclaimed, "2"))).toBe("moved · fork 2");
		expect(await labels.label(join(home, "code", "2024"))).toBeUndefined();
		expect(asked).toEqual([repo]);

		const failing = createForkLabels(async () => null, 60_000, () => join(home, ".pfs", "forks"));
		expect(await failing.label(join(forks, "3"))).toBe("pfs-demo · fork 3");
		const nowhere = createForkLabels(async () => '{"id":3,"label":"3-wait"}\n', 60_000, () => null);
		expect(await nowhere.label(join(forks, "3"))).toBeUndefined();
	});

	test("a .main outside pfs's forks root is someone's content: no label, and pfs never runs for it", async () => {
		const root = await tempRoot();
		const ran = await fakePfs(root);
		process.env.PFS_HOME = join(root, "pfs");
		const content = join(root, "downloads", "downloaded-content");
		await pfsRepo(join(root, "downloads", "repo"), content);
		await mkdir(join(content, "7", "src"), { recursive: true });
		const labels = createForkLabels();

		expect(await labels.label(join(content, "7"))).toBeUndefined();
		expect(await labels.label(join(content, "7", "src"))).toBeUndefined();
		expect(await labels.label(join(root, "pfs", "forks", "..", "..", "downloads", "downloaded-content", "7"))).toBeUndefined();
		expect(existsSync(ran)).toBe(false);
	});

	test("a fork under pfs's forks root is named by pfs ls in its repo, and a .main inside the fork doesn't count", async () => {
		const root = await tempRoot();
		const ran = await fakePfs(root);
		process.env.PFS_HOME = join(root, "pfs");
		const repo = join(root, "code", "pi-web");
		const forks = join(root, "pfs", "forks", "pi-web");
		await pfsRepo(repo, forks);
		await mkdir(join(forks, "3", "downloaded", "7"), { recursive: true });
		await pfsRepo(join(root, "downloads", "evil"), join(forks, "3", "downloaded"));
		const labels = createForkLabels();

		expect(await labels.label(join(forks, "3"))).toBe("pi-web · fork 3-web-subs");
		expect(await labels.label(join(forks, "3", "downloaded", "7"))).toBe("pi-web · fork 3-web-subs");
		expect(await labels.label(join(forks, "4"))).toBe("pi-web · fork 4");
		expect(await labels.label(forks)).toBeUndefined();
		expect((await readFile(ran, "utf8")).trim().split("\n")).toEqual([`${repo} ls --names --all --json`]);
	});

	test("a pfs from before ls --names still names the forks, through the full listing", async () => {
		const root = await tempRoot();
		const ran = await fakePfs(root, { knowsNames: false });
		process.env.PFS_HOME = join(root, "pfs");
		const repo = join(root, "code", "pi-web");
		const forks = join(root, "pfs", "forks", "pi-web");
		await pfsRepo(repo, forks);
		await mkdir(join(forks, "3"), { recursive: true });

		expect(await createForkLabels().label(join(forks, "3"))).toBe("pi-web · fork 3-web-subs");
		expect((await readFile(ran, "utf8")).trim().split("\n")).toEqual([`${repo} ls --names --all --json`, `${repo} ls --all --json`]);
	});

	test("a legacy <repo>/.forks/<n> reads from the folder names alone, without pfs", async () => {
		const root = await tempRoot();
		const ran = await fakePfs(root);
		process.env.PFS_HOME = join(root, "pfs");
		const repo = join(root, "pfs-demo");
		await mkdir(join(repo, ".git", "pfs"), { recursive: true });
		await mkdir(join(repo, ".forks", "3", "src"), { recursive: true });
		const labels = createForkLabels();

		expect(await labels.label(join(repo, ".forks", "3"))).toBe("pfs-demo · fork 3");
		expect(await labels.label(join(repo, ".forks", "3", "src"))).toBe("pfs-demo · fork 3");
		expect(existsSync(ran)).toBe(false);
	});
});
