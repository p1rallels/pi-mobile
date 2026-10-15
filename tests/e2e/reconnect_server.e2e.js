import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

const SESSION_ID = "01a13c00-0000-7000-8000-0000000000e2";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

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

async function writeSessionFile(root, cwd) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-15T10-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-15T10:00:00.000Z", cwd },
		{ type: "message", id: "u0000001", parentId: null, timestamp: "2026-10-15T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello from disk" }], timestamp: 1 } },
		{
			type: "message",
			id: "a0000001",
			parentId: "u0000001",
			timestamp: "2026-10-15T10:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "hi there" }], api: "anthropic-messages", provider: "anthropic", model: "m", usage, stopReason: "stop", timestamp: 2 },
		},
	];
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

async function startServer(root, port) {
	const proc = spawn(process.env.BUN_BINARY || "bun", ["src/server.ts"], {
		stdio: "ignore",
		env: sandboxServerEnv(root, { PI_WEB_PORT: String(port) }),
	});
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	proc.kill();
	throw new Error("server did not become healthy");
}

async function stopServer(proc) {
	const exited = new Promise((resolve) => proc.once("exit", resolve));
	proc.kill("SIGTERM");
	await exited;
}

test("the page re-attaches after a server restart and only fetches what it missed", async ({ page }, testInfo) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	const path = await writeSessionFile(root, cwd);
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	let server = await startServer(root, port);

	try {
		const streams = [];
		page.on("request", (request) => {
			if (request.url().includes(`/api/sessions/${SESSION_ID}/events`)) streams.push({ url: new URL(request.url()), headers: request.headers() });
		});

		await page.goto(base);
		const started = await page.evaluate(async (resumeSessionPath) => {
			const res = await fetch("/api/sessions", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ resumeSessionPath }) });
			return res.json();
		}, path);
		expect(started.sessionId).toBe(SESSION_ID);
		await page.reload();

		if (testInfo.project.name.includes("iphone")) await page.locator("#kb-menu").click();
		await page.locator(`.si[data-session-id="${SESSION_ID}"]`).click();
		await expect(page.locator(".user-msg")).toHaveText(["hello from disk"]);
		await expect(page.locator("#role-pill")).toHaveText(/controller|viewer/);

		await stopServer(server);
		await expect(page.locator("#role-pill")).toHaveText("reconnecting");
		server = await startServer(root, port);

		await expect(page.locator("#role-pill")).toHaveText(/controller|viewer/, { timeout: 20_000 });
		await expect(page.locator(".user-msg")).toHaveText(["hello from disk"]);
		await expect(page.locator(".assistant-block .md")).toHaveText(["hi there"]);

		const resumed = streams.at(-1);
		const cursor = resumed?.headers["last-event-id"] || resumed?.url.searchParams.get("since");
		expect(streams.length).toBeGreaterThan(1);
		expect(cursor).toBeTruthy();
		expect(resumed?.url.searchParams.get("path")).toBe(path);
	} finally {
		await stopServer(server).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
