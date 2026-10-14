import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function startServer(root: string, port: number): Promise<Bun.Subprocess> {
	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_WEB_HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_HOST: "127.0.0.1", PI_WEB_PORT: String(port) },
	});
	procs.push(proc);
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`http://127.0.0.1:${String(port)}/health`)).ok) return proc;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("server did not become healthy");
}

async function writeSessionFile(root: string, cwd: string): Promise<{ path: string; id: string }> {
	const id = "01a13c00-0000-7000-8000-000000000001";
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-14T10-00-00-000Z_${id}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-10-14T10:00:00.000Z", cwd },
		{ type: "message", id: "u0000001", parentId: null, timestamp: "2026-10-14T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello from disk" }], timestamp: 1 } },
		{
			type: "message",
			id: "a0000001",
			parentId: "u0000001",
			timestamp: "2026-10-14T10:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
		},
	];
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return { path, id };
}

async function readInit(url: string, cookie: string): Promise<{ status: number; init?: { state: { messages: Array<{ role: string; entryId: string }> } } }> {
	const controller = new AbortController();
	const res = await fetch(url, { headers: { cookie }, signal: controller.signal });
	if (!res.ok || !res.body) return { status: res.status };
	const reader = res.body.getReader();
	let buffer = "";
	while (!buffer.includes("\n\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += new TextDecoder().decode(value);
	}
	controller.abort();
	return { status: res.status, init: JSON.parse(buffer.slice(buffer.indexOf("data: ") + 6, buffer.indexOf("\n\n"))) };
}

describe("server sessions", () => {
	test("resumes, pages, lists, and re-attaches a session across a graceful restart", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-sessions-"));
		tempDirs.push(root);
		const cwd = join(root, "repo");
		await mkdir(cwd);
		const { path, id } = await writeSessionFile(root, cwd);
		const port = await freePort();
		const base = `http://127.0.0.1:${String(port)}`;

		const first = await startServer(root, port);
		const client = await fetch(`${base}/api/client`, { method: "POST" });
		const cookie = client.headers.get("set-cookie")?.split(";")[0] ?? "";
		const headers = { cookie, "content-type": "application/json" };

		const started = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ resumeSessionPath: path }) })).json()) as { sessionId: string };
		expect(started.sessionId).toBe(id);

		const state = (await (await fetch(`${base}/api/sessions/${id}/state`, { headers })).json()) as { messages: Array<{ role: string; entryId: string }>; hasOlderMessages: boolean };
		expect(state.messages.map((message) => message.entryId)).toEqual(["u0000001", "a0000001"]);

		const older = (await (await fetch(`${base}/api/sessions/${id}/transcript?before=a0000001`, { headers })).json()) as { messages: Array<{ entryId: string }>; hasOlder: boolean };
		expect(older).toEqual({ messages: [expect.objectContaining({ entryId: "u0000001" })], hasOlder: false });

		const listed = (await (await fetch(`${base}/api/sessions?cwd=${encodeURIComponent(cwd)}`, { headers })).json()) as { sessions: Array<{ id: string; isRunning: boolean; firstMessage: string }> };
		expect(listed.sessions.map((session) => [session.id, session.isRunning, session.firstMessage])).toEqual([[id, true, "hello from disk"]]);

		first.kill("SIGTERM");
		expect(await first.exited).toBe(0);
		procs.splice(procs.indexOf(first), 1);

		await startServer(root, port);
		expect((await readInit(`${base}/api/sessions/${id}/events`, cookie)).status).toBe(404);
		const attached = await readInit(`${base}/api/sessions/${id}/events?path=${encodeURIComponent(path)}`, cookie);
		expect(attached.status).toBe(200);
		expect(attached.init?.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});
});
