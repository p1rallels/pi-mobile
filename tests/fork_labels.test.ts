import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForkLabels, forkLabel, parseForkNames, parseForkPath } from "../src/fork-labels.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("fork labels", () => {
	test("reads the repo and fork number from a pfs fork folder", () => {
		expect(parseForkPath("/w/pfs-demo/.forks/8")).toEqual({ root: "/w/pfs-demo", number: 8 });
		expect(parseForkPath("/w/pfs-demo/.forks/12/src/deep")).toEqual({ root: "/w/pfs-demo", number: 12 });
		expect(parseForkPath("/w/pfs-demo/.forks/8-x")).toBeNull();
		expect(parseForkPath("/w/pfs-demo/.forks")).toBeNull();
		expect(parseForkPath("/w/pfs-demo")).toBeNull();
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
		expect(forkLabel({ root: "/w/pfs-demo", number: 8 }, names)).toBe("pfs-demo · fork 8-hooks");
		expect(forkLabel({ root: "/w/pfs-demo", number: 9 }, names)).toBe("pfs-demo · fork 9");
	});

	test("asks pfs once per repo while the names are fresh, and only where forks exist", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-forks-"));
		tempDirs.push(root);
		await mkdir(join(root, ".forks", "3"), { recursive: true });
		const asked: string[] = [];
		const labels = createForkLabels(async (repo) => {
			asked.push(repo);
			return '{"id":3,"label":"3-wait"}\n';
		});

		expect(await labels.label(join(root, ".forks", "3"))).toBe(`${root.split("/").at(-1)} · fork 3-wait`);
		expect(await labels.label(join(root, ".forks", "4"))).toBe(`${root.split("/").at(-1)} · fork 4`);
		expect(await labels.label(root)).toBeUndefined();
		expect(await labels.label("/no/such/repo/.forks/1")).toBe("repo · fork 1");
		expect(asked).toEqual([root]);

		const failing = createForkLabels(async () => null);
		expect(await failing.label(join(root, ".forks", "3"))).toBe(`${root.split("/").at(-1)} · fork 3`);
	});
});
