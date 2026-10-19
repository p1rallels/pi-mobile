// msg mail brings back a session pi-web disposed (src/msg-mail.ts), through a real server in a sandbox. With one slot,
// a second session takes the first one's, and a message file dropped into the first one's inbox brings it back with
// nobody watching (the second, idle and without mail, gives up its slot); a session whose file changed since stays down.
// Across a restart, mail that came while pi-web was down brings its session back when the server starts. No page: this
// is the host's own doing, read from its api and its log.
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

const FIRST = "01a16000-0000-7000-8000-0000000000a1";
const SECOND = "01a16000-0000-7000-8000-0000000000b2";
const M1 = "0mv962x7a-111111";
const M2 = "0mv962x7b-222222";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the host's behavior, the same in every browser");
});

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function writeSessionFile(root, cwd, id) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-19T07-00-00-000Z_${id}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-10-19T07:00:00.000Z", cwd },
		{ type: "message", id: "u0000001", parentId: null, timestamp: "2026-10-19T07:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "fan out the docs work" }], timestamp: 1 } },
		{
			type: "message",
			id: "a0000001",
			parentId: "u0000001",
			timestamp: "2026-10-19T07:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "started two children" }], api: "anthropic-messages", provider: "anthropic", model: "m", usage, stopReason: "stop", timestamp: 2 },
		},
	];
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

/** A sandboxed server whose log lines the test can wait for. */
async function startServer(root, port, env = {}) {
	const proc = spawn(process.env.BUN_BINARY || "bun", ["src/server.ts"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: sandboxServerEnv(root, { PI_WEB_PORT: String(port), ...env }),
	});
	const lines = [];
	let partial = "";
	proc.stdout.on("data", (chunk) => {
		const parts = (partial + chunk.toString()).split("\n");
		partial = parts.pop() ?? "";
		lines.push(...parts);
	});
	proc.stderr.on("data", () => {});
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${base}/health`)).ok) break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	const logged = (line) =>
		expect.poll(() => lines.includes(line), { message: `server logs "${line}"`, timeout: 15_000 }).toBe(true);
	return { proc, base, lines, logged };
}

async function stopServer(proc) {
	if (proc.exitCode !== null) return;
	const exited = new Promise((resolve) => proc.once("exit", resolve));
	proc.kill("SIGTERM");
	await exited;
}

/** The api as a browser session sees it: a client cookie, sessions resumed from their files. */
async function connect(base) {
	const client = await fetch(`${base}/api/client`, { method: "POST" });
	const headers = { cookie: client.headers.get("set-cookie")?.split(";")[0] ?? "", "content-type": "application/json" };
	return {
		async resume(resumeSessionPath) {
			const res = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ resumeSessionPath }) });
			if (!res.ok) throw new Error(`resume failed: ${res.status} ${await res.text()}`);
		},
		async running(id) {
			const { sessions } = await (await fetch(`${base}/api/sessions?id=${id}`, { headers })).json();
			return sessions.map((session) => session.isRunning);
		},
		async health() {
			return (await fetch(`${base}/health`)).json();
		},
	};
}

/** A message the way msg delivers it: written to the recipient's tmp/, renamed into new/. */
async function deliver(root, sessionId, id) {
	const box = join(root, "agent", "msg", "inbox", sessionId);
	await mkdir(join(box, "tmp"), { recursive: true });
	await mkdir(join(box, "new"), { recursive: true });
	const tmp = join(box, "tmp", `.${id}.json.${process.pid}.abcd1234.tmp`);
	const message = { v: 1, id, ts: Date.now(), from: { id: "01a16000-0000-7000-8000-0000000000c3", name: "scout" }, to: sessionId, text: "docs done", delivery: "steer", kind: "ended" };
	await writeFile(tmp, `${JSON.stringify(message)}\n`);
	await rename(tmp, join(box, "new", `${id}.json`));
}

test("a session pi-web disposed comes back, with nobody watching, when msg mail lands in its inbox; one whose file changed stays down", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-mail-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	const first = await writeSessionFile(root, cwd, FIRST);
	const second = await writeSessionFile(root, cwd, SECOND);
	const server = await startServer(root, await freePort(), { PI_WEB_MAX_RUNNING_SESSIONS: "1" });
	try {
		const api = await connect(server.base);
		await api.resume(first);
		await api.resume(second);
		expect(await api.running(FIRST)).toEqual([false]);
		expect(await api.health()).toMatchObject({ runningSessions: 1, detachedSessions: 1 });

		await deliver(root, FIRST, M1);
		await server.logged(`[pi-web] reopened ${FIRST} for msg mail`);
		expect(server.lines).toContain(`[pi-web] disposed idle session ${SECOND} to make room for msg mail`);
		expect(await api.running(FIRST)).toEqual([true]);
		expect(await api.running(SECOND)).toEqual([false]);
		expect(await api.health()).toMatchObject({ runningSessions: 1, viewers: 0, detachedSessions: 1 });

		// another pi wrote to the second session since pi-web disposed it: its mail doesn't bring it back here
		const label = { type: "label", id: "cli00001", parentId: "a0000001", timestamp: new Date().toISOString(), targetId: "a0000001", label: "cli" };
		await appendFile(second, `${JSON.stringify(label)}\n`);
		await deliver(root, SECOND, M2);
		await server.logged(`[pi-web] not reopening ${SECOND} for msg mail: its file changed since pi-web disposed it`);
		expect(await api.running(SECOND)).toEqual([false]);
		expect(await api.running(FIRST)).toEqual([true]);

		// pi-web only looked: the mail is where msg left it, for msg to take
		expect(await readdir(join(root, "agent", "msg", "inbox", FIRST, "new"))).toEqual([`${M1}.json`]);
		expect(await readdir(join(root, "agent", "msg", "inbox", SECOND, "new"))).toEqual([`${M2}.json`]);
	} finally {
		await stopServer(server.proc).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

test("mail that came while pi-web was down brings its session back when the server starts", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-mail-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	const first = await writeSessionFile(root, cwd, FIRST);
	const port = await freePort();
	let server = await startServer(root, port);
	try {
		await (await connect(server.base)).resume(first);
		await stopServer(server.proc);

		await deliver(root, FIRST, M1);
		server = await startServer(root, port);
		await server.logged(`[pi-web] reopened ${FIRST} for msg mail`);
		const api = await connect(server.base);
		expect(await api.running(FIRST)).toEqual([true]);
		expect(await api.health()).toMatchObject({ runningSessions: 1, viewers: 0, detachedSessions: 0 });
	} finally {
		await stopServer(server.proc).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
