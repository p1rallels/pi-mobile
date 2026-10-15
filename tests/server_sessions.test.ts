import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function startServer(root: string, port: number): Promise<Bun.Subprocess> {
	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdout: "pipe",
		stderr: "pipe",
		env: sandboxServerEnv(root, { PI_WEB_PORT: String(port) }),
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

interface InitFrame {
	id: string | null;
	init: {
		cursor: string | null;
		transcript: { mode: "replace" | "append"; since?: string; messages: Array<{ role: string; entryId: string }> };
	};
}

async function readInit(url: string, cookie: string, lastEventId?: string): Promise<{ status: number } & Partial<InitFrame>> {
	const controller = new AbortController();
	const headers: Record<string, string> = lastEventId ? { cookie, "last-event-id": lastEventId } : { cookie };
	const res = await fetch(url, { headers, signal: controller.signal });
	if (!res.ok || !res.body) return { status: res.status };
	const reader = res.body.getReader();
	let buffer = "";
	const dataFrame = () => buffer.split("\n\n").find((frame) => frame.includes("data: "));
	while (!dataFrame() || !buffer.endsWith("\n\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += new TextDecoder().decode(value);
	}
	controller.abort();
	const lines = (dataFrame() ?? "").split("\n");
	const id = lines.find((line) => line.startsWith("id: "))?.slice(4) ?? null;
	const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
	return { status: res.status, id, init: JSON.parse(data) };
}

describe("server canvas layout", () => {
	test("GET /api/canvas starts empty, PUT saves a sanitized layout, bad bodies are refused", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-canvas-"));
		tempDirs.push(root);
		const port = await freePort();
		await startServer(root, port);
		const base = `http://127.0.0.1:${String(port)}`;
		expect(await (await fetch(`${base}/api/canvas`)).json()).toEqual({ version: 1, tiles: [], updatedAt: null });

		const put = await fetch(`${base}/api/canvas`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tiles: [{ sessionId: "s1", path: "/x.jsonl", title: "t", x: 1, y: 2, w: 10, h: 10 }, { sessionId: "s1" }] }),
		});
		expect(put.status).toBe(200);
		const saved = (await (await fetch(`${base}/api/canvas`)).json()) as { tiles: unknown[]; updatedAt: unknown };
		expect(saved.tiles).toEqual([{ sessionId: "s1", path: "/x.jsonl", title: "t", x: 1, y: 2, w: 320, h: 220 }]);
		expect(typeof saved.updatedAt).toBe("string");

		const bad = await fetch(`${base}/api/canvas`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{nope" });
		expect(bad.status).toBe(400);
		expect(((await (await fetch(`${base}/api/canvas`)).json()) as { tiles: unknown[] }).tiles).toHaveLength(1);
	});
});

/** Reads `count` data frames of an SSE stream, running `between` after the first one arrives. */
async function readFrames(url: string, count: number, between: () => Promise<unknown> = async () => {}): Promise<unknown[]> {
	const controller = new AbortController();
	const res = await fetch(url, { signal: controller.signal });
	if (!res.ok || !res.body) throw new Error(`stream failed: ${String(res.status)}`);
	const reader = res.body.getReader();
	const frames: unknown[] = [];
	let buffer = "";
	while (frames.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += new TextDecoder().decode(value);
		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const data = part.split("\n").find((line) => line.startsWith("data: "));
			if (!data) continue;
			frames.push(JSON.parse(data.slice(6)));
			if (frames.length === 1) await between();
		}
	}
	controller.abort();
	return frames;
}

describe("server canvas status", () => {
	test("GET /api/canvas/status streams the running sessions, then each change", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-sessions-"));
		tempDirs.push(root);
		const cwd = join(root, "repo");
		await mkdir(cwd);
		const { path, id } = await writeSessionFile(root, cwd);
		const port = await freePort();
		const base = `http://127.0.0.1:${String(port)}`;
		await startServer(root, port);
		const client = await fetch(`${base}/api/client`, { method: "POST" });
		const cookie = client.headers.get("set-cookie")?.split(";")[0] ?? "";

		const frames = await readFrames(`${base}/api/canvas/status`, 2, () =>
			fetch(`${base}/api/sessions`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ resumeSessionPath: path }) }),
		);
		expect(frames[0]).toEqual({ type: "canvas_status", sessions: [] });
		expect(frames[1]).toEqual({ type: "canvas_status", sessions: [{ id, path, working: false, waiting: false, viewers: 0 }] });
	});
});

describe("server session files", () => {
	test("GET /api/session-transcript reads a session that isn't running without attaching it", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-sessions-"));
		tempDirs.push(root);
		const cwd = join(root, "repo");
		await mkdir(cwd);
		const { path, id } = await writeSessionFile(root, cwd);
		const port = await freePort();
		const base = `http://127.0.0.1:${String(port)}`;
		await startServer(root, port);

		const read = (query: string) => fetch(`${base}/api/session-transcript?${query}`);
		const tail = await read(`path=${encodeURIComponent(path)}&limit=1`);
		expect(tail.status).toBe(200);
		expect(await tail.json()).toEqual({ sessionId: id, messages: [expect.objectContaining({ role: "assistant", entryId: "a0000001" })], hasOlder: true });
		const older = (await (await read(`path=${encodeURIComponent(path)}&before=a0000001`)).json()) as { messages: Array<{ entryId: string }>; hasOlder: boolean };
		expect(older.messages.map((message) => message.entryId)).toEqual(["u0000001"]);
		expect(older.hasOlder).toBe(false);
		expect(((await (await fetch(`${base}/api/active-sessions`)).json()) as { sessions: unknown[] }).sessions).toEqual([]);

		expect((await read(`path=${encodeURIComponent(join(root, "elsewhere.jsonl"))}`)).status).toBe(403);
		expect((await read(`path=${encodeURIComponent(path.replace(".jsonl", "-gone.jsonl"))}`)).status).toBe(404);
		expect((await read("")).status).toBe(400);
	});
});

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
		const events = `${base}/api/sessions/${id}/events?path=${encodeURIComponent(path)}`;
		const attached = await readInit(events, cookie);
		expect(attached.status).toBe(200);
		const cursor = attached.init?.cursor ?? "";
		expect(cursor).not.toBe("");
		expect(attached.id).toBe(cursor);
		expect(attached.init?.transcript.mode).toBe("replace");
		expect(attached.init?.transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

		const caughtUp = await readInit(events, cookie, cursor);
		expect(caughtUp.init?.transcript).toEqual({ mode: "append", since: cursor, messages: [] });

		const behind = await readInit(`${events}&since=u0000001`, cookie);
		expect(behind.init?.transcript.mode).toBe("append");
		expect(behind.init?.transcript.messages.map((message) => message.entryId)).toEqual(["a0000001"]);

		const headerWins = await readInit(`${events}&since=u0000001`, cookie, cursor);
		expect(headerWins.init?.transcript.messages).toEqual([]);

		const unknown = await readInit(`${events}&since=gone0001`, cookie);
		expect(unknown.init?.transcript.mode).toBe("replace");
	});
});
