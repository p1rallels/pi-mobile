import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDirForCwd } from "../src/session-index.ts";
import { sandboxServerEnv } from "./support/sandbox_env.js";

const tempDirs: string[] = [];
const procs: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const proc of procs.splice(0)) {
		proc.kill();
		await proc.exited.catch(() => undefined);
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

/** A server whose home folder (HOME, so ~ and "inside home") is root/me, never the real one. */
async function startServer(root: string): Promise<string> {
	const port = await freePort();
	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdout: "pipe",
		stderr: "pipe",
		env: sandboxServerEnv(root, { PI_WEB_PORT: String(port), HOME: join(root, "me") }),
	});
	procs.push(proc);
	const base = `http://127.0.0.1:${String(port)}`;
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${base}/health`)).ok) return base;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("server did not become healthy");
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-repos-"));
	tempDirs.push(root);
	await mkdir(join(root, "me", "code", "alpha"), { recursive: true });
	await mkdir(join(root, "me", "code", ".hidden"));
	await mkdir(join(root, "outside"));
	return root;
}

const post = (base: string, body: unknown) => fetch(`${base}/api/repos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("server folders", () => {
	test("GET /api/dirs lists what a typed ~/path continues with, and refuses anything else", async () => {
		const root = await makeRoot();
		const base = await startServer(root);
		const dirs = async (path: string) => (await fetch(`${base}/api/dirs?${new URLSearchParams({ path }).toString()}`)).json();

		expect(await dirs("~/code/")).toEqual({
			path: join(root, "me", "code"),
			exists: true,
			parent: join(root, "me", "code"),
			parentExists: true,
			insideHome: true,
			canCreate: false,
			entries: [{ name: "alpha", path: join(root, "me", "code", "alpha") }],
			truncated: false,
		});
		expect(await dirs("~/code/.")).toMatchObject({ entries: [{ name: ".hidden" }] });
		expect(await dirs("~/code/new")).toMatchObject({ exists: false, canCreate: true, entries: [] });
		expect(await dirs(join(root, "outside", "new"))).toMatchObject({ exists: false, insideHome: false, canCreate: false });
		expect((await fetch(`${base}/api/dirs?path=code`)).status).toBe(400);
		expect((await fetch(`${base}/api/dirs`)).status).toBe(400);
	});

	test("POST /api/repos with create makes one folder inside home, saves it, and refuses the rest", async () => {
		const root = await makeRoot();
		const base = await startServer(root);

		const made = await post(base, { cwd: "~/code/new-app", create: true });
		expect(made.status).toBe(200);
		expect(await made.json()).toEqual({ ok: true, cwd: join(root, "me", "code", "new-app") });
		expect((await stat(join(root, "me", "code", "new-app"))).isDirectory()).toBe(true);
		expect(((await (await fetch(`${base}/api/repos`)).json()) as { repos: string[] }).repos).toContain(join(root, "me", "code", "new-app"));

		const existing = await post(base, { cwd: "~/code/alpha", create: true });
		expect(await existing.json()).toEqual({ ok: true, cwd: join(root, "me", "code", "alpha") });

		const outside = await post(base, { cwd: join(root, "outside", "nope"), create: true });
		expect(outside.status).toBe(400);
		expect(((await outside.json()) as { error: string }).error).toContain("new folders go inside the home folder");
		const chain = await post(base, { cwd: "~/missing/deeper", create: true });
		expect(chain.status).toBe(400);
		expect(((await chain.json()) as { error: string }).error).toContain("parent folder does not exist");
		const plain = await post(base, { cwd: "~/code/not-made" });
		expect(((await plain.json()) as { error: string }).error).toContain("cwd does not exist");
		await expect(stat(join(root, "outside", "nope"))).rejects.toThrow();
		await expect(stat(join(root, "me", "code", "not-made"))).rejects.toThrow();
	});

	test("GET /api/repos/suggestions offers folders sessions ran in, minus saved and temp ones", async () => {
		const root = await makeRoot();
		const used = join(import.meta.dir, "..", "test-results", `suggestions-${String(process.pid)}`);
		tempDirs.push(used);
		await mkdir(used, { recursive: true });
		for (const [cwd, id] of [
			[used, "01a13c00-0000-7000-8000-0000000000e1"],
			[join(root, "me", "code", "alpha"), "01a13c00-0000-7000-8000-0000000000e2"],
		] as const) {
			const dir = sessionDirForCwd(join(root, "agent", "sessions"), cwd);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, `2026-10-15T10-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-15T10:00:00.000Z", cwd })}\n`);
		}
		const base = await startServer(root);
		const suggestions = async () => ((await (await fetch(`${base}/api/repos/suggestions`)).json()) as { suggestions: Array<{ cwd: string; sessions: number }> }).suggestions;

		expect((await suggestions()).map((suggestion) => suggestion.cwd)).toEqual([used]);
		expect((await post(base, { cwd: used })).status).toBe(200);
		expect(await suggestions()).toEqual([]);
	});
});
