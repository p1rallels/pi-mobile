import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchOfHead, findGitHead, readGitBranch, watchGitBranch } from "../src/git-branch.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await cleanupAgentDirs();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-git-"));
	tempDirs.push(dir);
	return dir;
}

/** A repo whose .git holds just HEAD, which is all the branch reader looks at. */
async function makeRepo(root: string, head = "ref: refs/heads/main\n"): Promise<string> {
	const repo = join(root, "repo");
	await mkdir(join(repo, ".git"), { recursive: true });
	await mkdir(join(repo, "src", "deep"), { recursive: true });
	await writeFile(join(repo, ".git", "HEAD"), head);
	return repo;
}

/** Switches branches the way git does: a new HEAD renamed over the old one. */
async function checkout(repo: string, branch: string): Promise<void> {
	await writeFile(join(repo, ".git", "HEAD.lock"), `ref: refs/heads/${branch}\n`);
	await rename(join(repo, ".git", "HEAD.lock"), join(repo, ".git", "HEAD"));
}

describe("git branch", () => {
	test("HEAD names a branch, or says detached; reftable's placeholder needs git", () => {
		expect(branchOfHead("ref: refs/heads/main\n")).toBe("main");
		expect(branchOfHead("ref: refs/heads/feat/footer")).toBe("feat/footer");
		expect(branchOfHead("8a1b2c3d4e5f60718293a4b5c6d7e8f901234567\n")).toBe("detached");
		expect(branchOfHead("ref: refs/heads/.invalid")).toBeNull();
	});

	test("finds HEAD from any folder inside the repo, through a worktree's gitdir file too", async () => {
		const root = await tempRoot();
		const repo = await makeRepo(root);
		expect(findGitHead(join(repo, "src", "deep"))).toEqual({ repoDir: repo, headPath: join(repo, ".git", "HEAD") });
		expect(await readGitBranch(findGitHead(join(repo, "src")))).toBe("main");

		const worktree = join(root, "wt");
		await mkdir(join(root, "wt-git"), { recursive: true });
		await writeFile(join(root, "wt-git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
		await mkdir(worktree);
		await writeFile(join(worktree, ".git"), "gitdir: ../wt-git\n");
		expect(findGitHead(worktree)).toEqual({ repoDir: worktree, headPath: join(root, "wt-git", "HEAD") });
		expect(await readGitBranch(findGitHead(worktree))).toBe("detached");

		const plain = join(root, "plain");
		await mkdir(plain);
		expect(findGitHead(plain)).toBeNull();
		expect(await readGitBranch(null)).toBeNull();
	});

	test("follows a checkout through the HEAD folder's watcher, and refresh() reads it again on demand", async () => {
		const root = await tempRoot();
		const repo = await makeRepo(root);
		const seen: Array<string | null> = [];
		const watch = watchGitBranch(join(repo, "src"), (branch) => seen.push(branch), { debounceMs: 20 });
		try {
			expect(watch.current()).toBe("main");
			await checkout(repo, "feature");
			await waitFor(() => watch.current() === "feature", 3_000);
			expect(seen).toEqual(["feature"]);

			watch.refresh();
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(seen).toEqual(["feature"]);
		} finally {
			watch.dispose();
		}
		await checkout(repo, "after-dispose");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(watch.current()).toBe("feature");

		const outside = watchGitBranch(root, () => {});
		expect(outside.current()).toBeNull();
		outside.refresh();
		outside.dispose();
	});

	test("a running session reports its branch and patches it when the checkout changes", async () => {
		const root = await tempRoot();
		const repo = await makeRepo(root);
		const { runtime, sessionId, clientId, events } = await startFauxSession([fauxAssistantMessage("done")], { cwd: repo });
		expect(runtime.getSessionState(sessionId).gitBranch).toBe("main");

		await checkout(repo, "feature");
		const branchPatches = () => events.flatMap((event) => (event.type === "state_patch" && event.patch.gitBranch !== undefined ? [event.patch.gitBranch] : []));
		await waitFor(() => branchPatches().includes("feature"), 4_000);
		expect(runtime.getSessionState(sessionId).gitBranch).toBe("feature");

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hello" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		expect(branchPatches().at(-1)).toBe("feature");
		await runtime.release(sessionId, { clientId });
	});
});
