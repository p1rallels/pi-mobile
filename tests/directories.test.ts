import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFolderInHome, isCreatableName, isInsideFolder, isTypedPath, listDirectories, matchesLeaf, splitTypedPath } from "../src/directories.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** root/me is home: code/{alpha,Beta,.hidden,notes.txt,link -> alpha}, plus root/outside and a home link to it. */
async function makeTree(): Promise<{ root: string; home: string }> {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-dirs-"));
	tempDirs.push(root);
	const home = join(root, "me");
	await mkdir(join(home, "code", "alpha"), { recursive: true });
	await mkdir(join(home, "code", "Beta"));
	await mkdir(join(home, "code", ".hidden"));
	await writeFile(join(home, "code", "notes.txt"), "not a folder");
	await symlink(join(home, "code", "alpha"), join(home, "code", "link"));
	await symlink(join(home, "code", "notes.txt"), join(home, "code", "file-link"));
	await mkdir(join(root, "outside"));
	await symlink(join(root, "outside"), join(home, "escape"));
	return { root, home };
}

describe("typed paths", () => {
	test("only /..., ~ and ~/... are paths", () => {
		expect(isTypedPath("/Users/me")).toBe(true);
		expect(isTypedPath("~")).toBe(true);
		expect(isTypedPath(" ~/code ")).toBe(true);
		expect(isTypedPath("~other")).toBe(false);
		expect(isTypedPath("code/app")).toBe(false);
		expect(isTypedPath("")).toBe(false);
		expect(isTypedPath("/a\0b")).toBe(false);
		expect(isTypedPath(`/${"a".repeat(5000)}`)).toBe(false);
	});

	test("split into the folder listed (through the last slash) and the name typed after it", () => {
		expect(splitTypedPath("~/code/al", "/Users/me")).toEqual({ parent: "/Users/me/code", leaf: "al", path: "/Users/me/code/al" });
		expect(splitTypedPath("~/code/", "/Users/me")).toEqual({ parent: "/Users/me/code", leaf: "", path: "/Users/me/code" });
		expect(splitTypedPath("~", "/Users/me")).toEqual({ parent: "/Users/me", leaf: "", path: "/Users/me" });
		expect(splitTypedPath("/", "/Users/me")).toEqual({ parent: "/", leaf: "", path: "/" });
		expect(splitTypedPath("/Us", "/Users/me")).toEqual({ parent: "/", leaf: "Us", path: "/Us" });
	});

	test("names match by prefix in any case; hidden ones only for a leading dot", () => {
		expect(matchesLeaf("Alpha", "al")).toBe(true);
		expect(matchesLeaf("alpha", "")).toBe(true);
		expect(matchesLeaf("beta", "al")).toBe(false);
		expect(matchesLeaf(".git", "")).toBe(false);
		expect(matchesLeaf(".git", ".g")).toBe(true);
		expect(matchesLeaf(".git", ".")).toBe(true);
	});

	test("one new folder needs a plain name, and inside means the folder or below it", () => {
		expect(isCreatableName("new-app")).toBe(true);
		expect(isCreatableName(".config")).toBe(true);
		for (const bad of ["", ".", "..", "a/b", "a\0b", "x".repeat(256)]) expect(isCreatableName(bad)).toBe(false);
		expect(isInsideFolder("/Users/me", "/Users/me")).toBe(true);
		expect(isInsideFolder("/Users/me/code", "/Users/me")).toBe(true);
		expect(isInsideFolder("/Users/meow", "/Users/me")).toBe(false);
		expect(isInsideFolder("/anything", "/")).toBe(true);
	});
});

describe("listDirectories", () => {
	test("lists the subfolders a typed path continues with: folders and links to them, no files, hidden only for a dot", async () => {
		const { home } = await makeTree();
		const listing = await listDirectories("~/code/", { home });
		expect(listing.entries.map((entry) => entry.name)).toEqual(["alpha", "Beta", "link"]);
		expect(listing.entries[0]).toEqual({ name: "alpha", path: join(home, "code", "alpha") });
		expect(listing).toMatchObject({ path: join(home, "code"), exists: true, parent: join(home, "code"), parentExists: true, insideHome: true, canCreate: false, truncated: false });

		expect((await listDirectories("~/code/b", { home })).entries.map((entry) => entry.name)).toEqual(["Beta"]);
		expect((await listDirectories("~/code/.", { home })).entries.map((entry) => entry.name)).toEqual([".hidden"]);
		expect((await listDirectories(`${home}/code/AL`, { home })).entries.map((entry) => entry.name)).toEqual(["alpha"]);
	});

	test("says whether the typed path exists, and caps the list", async () => {
		const { home } = await makeTree();
		expect(await listDirectories("~/code/alpha", { home })).toMatchObject({ exists: true, canCreate: false, entries: [{ name: "alpha" }] });
		expect(await listDirectories("~/code/notes.txt", { home })).toMatchObject({ exists: false, canCreate: false, entries: [] });
		const capped = await listDirectories("~/code/", { home, limit: 2 });
		expect(capped.entries.map((entry) => entry.name)).toEqual(["alpha", "Beta"]);
		expect(capped.truncated).toBe(true);
	});

	test("a missing name can be created when its folder exists inside home, nowhere else", async () => {
		const { root, home } = await makeTree();
		expect(await listDirectories("~/code/new-app", { home })).toMatchObject({ exists: false, parentExists: true, insideHome: true, canCreate: true });
		expect(await listDirectories("~/code/new-app/", { home })).toMatchObject({ exists: false, parentExists: false, canCreate: true });
		expect(await listDirectories("~/nope/new-app", { home })).toMatchObject({ parentExists: false, insideHome: false, canCreate: false, entries: [] });
		expect(await listDirectories(`${root}/outside/new-app`, { home })).toMatchObject({ parentExists: true, insideHome: false, canCreate: false });
		expect(await listDirectories("~/escape/new-app", { home })).toMatchObject({ parentExists: true, insideHome: false, canCreate: false });
		expect(await listDirectories("~/code/..", { home })).toMatchObject({ path: home, exists: true });
	});
});

describe("createFolderInHome", () => {
	test("makes one folder inside home and returns it", async () => {
		const { home } = await makeTree();
		expect(await createFolderInHome("~/code/new-app", home)).toBe(join(home, "code", "new-app"));
		expect((await stat(join(home, "code", "new-app"))).isDirectory()).toBe(true);
		expect(await createFolderInHome(`${home}/fresh/`, home)).toBe(join(home, "fresh"));
	});

	test("an existing folder is just returned, even outside home", async () => {
		const { root, home } = await makeTree();
		expect(await createFolderInHome("~/code/alpha", home)).toBe(join(home, "code", "alpha"));
		expect(await createFolderInHome(`${root}/outside`, home)).toBe(join(root, "outside"));
	});

	test("never makes a chain, never lands outside home, never replaces a file", async () => {
		const { root, home } = await makeTree();
		await expect(createFolderInHome("~/nope/deeper", home)).rejects.toThrow("parent folder does not exist");
		await expect(createFolderInHome(`${root}/outside/new`, home)).rejects.toThrow("new folders go inside the home folder");
		await expect(createFolderInHome("~/../sneaky", home)).rejects.toThrow("new folders go inside the home folder");
		await expect(createFolderInHome("~/escape/new", home)).rejects.toThrow("new folders go inside the home folder");
		await expect(createFolderInHome("~/code/notes.txt", home)).rejects.toThrow("a file is in the way");
		await expect(stat(join(root, "sneaky"))).rejects.toThrow();
		await expect(stat(join(root, "outside", "new"))).rejects.toThrow();
	});
});
