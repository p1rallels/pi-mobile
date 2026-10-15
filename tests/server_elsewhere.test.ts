import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "./support/sandbox_env.js";

const tempDirs: string[] = [];
const procs: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const proc of procs.splice(0)) {
		proc.kill("SIGKILL");
		await proc.exited.catch(() => undefined);
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const SESSION_ID = "01a13c00-0000-7000-8000-00000000e201";

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

async function startServer(root: string, port: number): Promise<void> {
	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdout: "ignore",
		stderr: "ignore",
		env: sandboxServerEnv(root, { PI_WEB_PORT: String(port) }),
	});
	procs.push(proc);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`http://127.0.0.1:${String(port)}/health`)).ok) return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("server did not become healthy");
}

/** `ps` shows it as pi, the way pi titles its own process; it leads its own process group like a pfs run. */
function spawnFakePi(cwd: string): Bun.Subprocess {
	const proc = Bun.spawn({ cmd: ["node", "-e", 'process.title = "pi"; setInterval(() => {}, 1000);'], cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
	procs.push(proc);
	return proc;
}

async function writeMidTurnSession(root: string, cwd: string): Promise<string> {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-15T10-00-00-000Z_${SESSION_ID}.jsonl`);
	const now = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: now, cwd },
		{ type: "message", id: "u0000001", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: "count slowly" }], timestamp: 1 } },
		{
			type: "message",
			id: "a0000001",
			parentId: "u0000001",
			timestamp: now,
			message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 60" } }], api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "toolUse", timestamp: 2 },
		},
	];
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

async function firstFrame(url: string, cookie: string): Promise<{ status: number; id?: string | null; data?: Record<string, unknown> }> {
	const controller = new AbortController();
	const res = await fetch(url, { headers: { cookie }, signal: controller.signal });
	if (!res.ok || !res.body) return { status: res.status };
	const reader = res.body.getReader();
	let buffer = "";
	const frame = () => buffer.split("\n\n").find((part) => part.includes("data: "));
	while (!frame()) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += new TextDecoder().decode(value);
	}
	controller.abort();
	const lines = (frame() ?? "").split("\n");
	return {
		status: res.status,
		id: lines.find((line) => line.startsWith("id: "))?.slice(4) ?? null,
		data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}") as Record<string, unknown>,
	};
}

describe("server: sessions another pi is writing", () => {
	test("labels, refuses to resume, follows and stops a session a real pi process is writing", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-elsewhere-server-"));
		tempDirs.push(root);
		const cwd = join(root, "repo");
		await mkdir(cwd);
		const writer = spawnFakePi(cwd);
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const path = await writeMidTurnSession(root, cwd);
		const port = await freePort();
		const base = `http://127.0.0.1:${String(port)}`;
		await startServer(root, port);
		const cookie = (await fetch(`${base}/api/client`, { method: "POST" })).headers.get("set-cookie")?.split(";")[0] ?? "";
		const headers = { cookie, "content-type": "application/json" };

		const listed = (await (await fetch(`${base}/api/sessions?cwd=${encodeURIComponent(cwd)}`, { headers })).json()) as { sessions: Array<{ id: string; elsewhere?: Record<string, unknown> }> };
		expect(listed.sessions.map((session) => [session.id, session.elsewhere?.state, session.elsewhere?.writers])).toEqual([[SESSION_ID, "running", [writer.pid]]]);
		const active = (await (await fetch(`${base}/api/active-sessions`, { headers })).json()) as { sessions: Array<{ id: string; elsewhere?: Record<string, unknown> }> };
		expect(active.sessions.map((session) => [session.id, session.elsewhere?.state])).toEqual([[SESSION_ID, "running"]]);

		const refused = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ resumeSessionPath: path }) });
		expect(refused.status).toBe(409);
		expect(((await refused.json()) as { elsewhere: { state: string } }).elsewhere.state).toBe("running");

		const followUrl = `${base}/api/sessions/${SESSION_ID}/follow?path=${encodeURIComponent(path)}`;
		const followed = await firstFrame(followUrl, cookie);
		expect(followed.status).toBe(200);
		expect(followed.id).toBe("a0000001");
		expect(followed.data).toMatchObject({ type: "follow_init", follow: { state: "running", turn: "running_tools" }, session: { sessionId: SESSION_ID, cwd } });
		expect((await firstFrame(`${base}/api/sessions/${SESSION_ID}/follow?path=${encodeURIComponent("/etc/passwd")}`, cookie)).status).toBe(403);

		const stop = await fetch(`${base}/api/sessions/${SESSION_ID}/stop-elsewhere`, { method: "POST", headers, body: JSON.stringify({ path }) });
		expect(await stop.json()).toEqual({ ok: true, stopped: [writer.pid] });
		expect(await writer.exited).not.toBe(0);

		const after = (await (await fetch(`${base}/api/sessions?cwd=${encodeURIComponent(cwd)}`, { headers })).json()) as { sessions: Array<{ elsewhere?: Record<string, unknown> }> };
		expect(after.sessions[0]?.elsewhere?.state).toBe("stopped");
		const resumed = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ resumeSessionPath: path }) });
		expect(resumed.status).toBe(200);
		expect(((await resumed.json()) as { sessionId: string }).sessionId).toBe(SESSION_ID);
	});
});
