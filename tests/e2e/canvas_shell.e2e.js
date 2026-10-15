// The canvas shell (?ui=canvas) against an isolated pi-web server with two sessions on disk.
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

const S1 = "01a13c00-0000-7000-8000-0000000000c1";
const S2 = "01a13c00-0000-7000-8000-0000000000c2";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the canvas is laptop chrome only");
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

async function writeSessionFile(root, cwd, id, user, reply) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-15T10-00-00-000Z_${id}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-10-15T10:00:00.000Z", cwd },
		{ type: "message", id: `u${id.slice(-7)}`, parentId: null, timestamp: "2026-10-15T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: user }], timestamp: 1 } },
		{
			type: "message",
			id: `a${id.slice(-7)}`,
			parentId: `u${id.slice(-7)}`,
			timestamp: "2026-10-15T10:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: reply }], api: "anthropic-messages", provider: "anthropic", model: "m", usage, stopReason: "stop", timestamp: 2 },
		},
	];
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

async function startServer(root, port) {
	const proc = spawn(process.env.BUN_BINARY || "bun", ["src/server.ts"], { stdio: "ignore", env: sandboxServerEnv(root, { PI_WEB_PORT: String(port) }) });
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

const tile = (page, id) => page.locator(`.cv-tile[data-tile-id="${id}"]`);

test("running sessions land on the canvas, the map survives reloads, dormant tiles wake on click", async ({ page }, testInfo) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-canvas-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	const path1 = await writeSessionFile(root, cwd, S1, "hello from disk", "hi there");
	const path2 = await writeSessionFile(root, cwd, S2, "second session", "reply two");
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const server = await startServer(root, port);
	try {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`${base}/?ui=phone`);
		await page.evaluate(async (resumeSessionPath) => {
			const client = await (await fetch("/api/client", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
			const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, resumeSessionPath }) });
			if (!res.ok) throw new Error(`start failed: ${res.status}`);
		}, path1);

		await page.goto(`${base}/?ui=canvas`);
		await expect(page.locator(".cv-root")).toBeVisible();
		await expect(page.locator(".app-header")).toHaveCount(0);
		await expect(page.locator(".cv-tile")).toHaveCount(1);
		await expect(tile(page, S1).locator(".user-msg")).toHaveText("hello from disk");
		await expect(tile(page, S1).locator(".assistant-block .md")).toHaveText("hi there");
		await expect(tile(page, S1).locator(".cv-title")).toContainText("repo");
		await expect(tile(page, S1).locator(".cv-pill")).toHaveText(/idle|viewing/);
		await expect(tile(page, S1).locator(".cv-ctl-model .sel")).not.toHaveText("—");

		// the canvas is remembered: a plain reload stays on it, with the same tile where it was
		const rect = await page.evaluate((id) => window.__canvas.canvas.tiles.get(id).rect, S1);
		// the map lives on the host (GET/PUT /api/canvas): add a tile for the second session there
		await expect.poll(() => page.evaluate(async () => (await (await fetch("/api/canvas")).json()).tiles.length)).toBe(1);
		await page.evaluate(
			async ([id, p]) => {
				const layout = await (await fetch("/api/canvas")).json();
				const first = layout.tiles[0];
				layout.tiles.push({ sessionId: id, path: p, title: "repo · second", x: first.x + 840, y: first.y, w: 800, h: 500 });
				const res = await fetch("/api/canvas", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(layout) });
				if (!res.ok) throw new Error(`layout save failed: ${res.status}`);
			},
			[S2, path2],
		);
		await page.goto(`${base}/`);
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		expect(await page.evaluate((id) => window.__canvas.canvas.tiles.get(id).rect, S1)).toEqual(rect);
		await expect(tile(page, S2).locator(".cv-pill")).toHaveText("not running");
		await expect(tile(page, S2).locator(".notice-text")).toContainText("Not running");

		await tile(page, S2).locator(".msgs").click();
		await expect(tile(page, S2).locator(".user-msg")).toHaveText("second session");
		await expect(tile(page, S2).locator(".cv-pill")).toHaveText(/idle|viewing/);
		await expect(tile(page, S2)).toHaveClass(/cv-focused/);
		await expect(tile(page, S2).locator("textarea")).toBeFocused();
		await page.screenshot({ path: testInfo.outputPath("canvas-shell.png") });
		await testInfo.attach("canvas-shell", { path: testInfo.outputPath("canvas-shell.png"), contentType: "image/png" });

		// one tile per session: the hud's new tile has nothing left to add
		await page.locator('.cv-hud-btn[data-act="new"]').click();
		await expect(tile(page, S2).locator(".notice-text.error")).toContainText("already on the canvas");
		await expect(page.locator(".cv-tile")).toHaveCount(2);

		// the red dot only takes the tile off the canvas
		await tile(page, S2).locator(".cv-close").click();
		await expect(page.locator(".cv-tile")).toHaveCount(1);
		await expect.poll(() => page.evaluate(async () => (await (await fetch("/api/canvas")).json()).tiles.map((t) => t.sessionId))).toEqual([S1]);
		const active = await page.evaluate(async () => (await (await fetch("/api/active-sessions")).json()).sessions.map((s) => s.id));
		expect(active).toContain(S2);

		await page.goto(`${base}/?ui=phone`);
		await expect(page.locator(".app-header")).toBeVisible();
		await expect(page.locator(".cv-root")).toHaveCount(0);
	} finally {
		server.kill("SIGTERM");
		await new Promise((resolve) => server.once("exit", resolve));
		await rm(root, { recursive: true, force: true });
	}
});

function trackEventSources() {
	const Native = window.EventSource;
	let open = 0;
	window.EventSource = class extends Native {
		constructor(url, init) {
			super(url, init);
			open += 1;
			const close = this.close.bind(this);
			let closed = false;
			this.close = () => {
				if (!closed) open -= 1;
				closed = true;
				close();
			};
		}
	};
	Object.defineProperty(window, "__openEventSources", { get: () => open });
}

test("offscreen tiles drop their stream, unmount later, and come back from their cursor", async ({ page }) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-canvas-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	const paths = [await writeSessionFile(root, cwd, S1, "hello from disk", "hi there"), await writeSessionFile(root, cwd, S2, "second session", "reply two")];
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const server = await startServer(root, port);
	try {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`${base}/?ui=phone`);
		await page.evaluate(async (resumePaths) => {
			const client = await (await fetch("/api/client", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
			for (const resumeSessionPath of resumePaths) {
				const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, resumeSessionPath }) });
				if (!res.ok) throw new Error(`start failed: ${res.status}`);
			}
		}, paths);

		const streams = [];
		page.on("request", (request) => {
			if (request.url().includes("/events")) streams.push(new URL(request.url()));
		});
		await page.addInitScript(trackEventSources);
		await page.goto(`${base}/?ui=canvas&suspendMs=150&unmountMs=1500&keepMounted=0`);
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		await expect(tile(page, S1).locator(".user-msg")).toHaveText("hello from disk");
		await expect(tile(page, S2).locator(".user-msg")).toHaveText("second session");
		await expect.poll(() => page.evaluate(() => window.__openEventSources)).toBe(2);
		const firstConnects = streams.length;

		// out of view: both streams close after the grace period
		await page.evaluate(() => window.__canvas.canvas.viewport.setCamera({ x: -100_000, y: 0, scale: 0.6 }));
		await expect.poll(() => page.evaluate(() => window.__openEventSources)).toBe(0);
		await expect(tile(page, S1).locator(".cv-pill")).toHaveText("offscreen");

		// back before the unmount: the same dom picks up from its cursor
		await page.evaluate(() => window.__canvas.canvas.viewport.setCamera({ x: 48, y: 64, scale: 0.6 }));
		await expect.poll(() => page.evaluate(() => window.__openEventSources)).toBe(2);
		const resumed = streams.slice(firstConnects);
		expect(resumed).toHaveLength(2);
		for (const url of resumed) expect(url.searchParams.get("since")).toBeTruthy();
		await expect(tile(page, S1).locator(".user-msg")).toHaveCount(1);
		await expect(tile(page, S1).locator(".cv-pill")).toHaveText(/idle|viewing/);

		// away long enough to unmount: only a placeholder stays, and the session keeps running
		await page.evaluate(() => window.__canvas.canvas.viewport.setCamera({ x: -100_000, y: 0, scale: 0.6 }));
		await expect.poll(() => page.locator(".cv-tile .cv-placeholder").count(), { timeout: 10_000 }).toBe(2);
		await expect(page.locator(".cv-tile .msgs")).toHaveCount(0);
		const active = await page.evaluate(async () => (await (await fetch("/api/active-sessions")).json()).sessions.map((s) => s.id));
		expect(active.sort()).toEqual([S1, S2].sort());

		await page.evaluate(() => window.__canvas.canvas.viewport.setCamera({ x: 48, y: 64, scale: 0.6 }));
		await expect(tile(page, S1).locator(".user-msg")).toHaveText("hello from disk");
		await expect(tile(page, S2).locator(".assistant-block .md")).toHaveText("reply two");
		await expect.poll(() => page.evaluate(() => window.__openEventSources)).toBe(2);
	} finally {
		server.kill("SIGTERM");
		await new Promise((resolve) => server.once("exit", resolve));
		await rm(root, { recursive: true, force: true });
	}
});
