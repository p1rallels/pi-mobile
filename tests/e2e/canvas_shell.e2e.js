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

/** A session file with one user/assistant pair per turn; entry ids are u<turn><id tail> and a<turn><id tail>. */
async function writeSessionTurns(root, cwd, id, turns) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-15T10-00-00-000Z_${id}.jsonl`);
	const tail = id.slice(-7);
	const lines = [{ type: "session", version: 3, id, timestamp: "2026-10-15T10:00:00.000Z", cwd }];
	let parentId = null;
	for (const [index, [user, reply]] of turns.entries()) {
		const turn = index === 0 ? "" : String(index);
		const userId = `u${turn}${tail}`;
		const replyId = `a${turn}${tail}`;
		lines.push(
			{ type: "message", id: userId, parentId, timestamp: "2026-10-15T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: user }], timestamp: index * 2 + 1 } },
			{
				type: "message",
				id: replyId,
				parentId: userId,
				timestamp: "2026-10-15T10:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: reply }], api: "anthropic-messages", provider: "anthropic", model: "m", usage, stopReason: "stop", timestamp: index * 2 + 2 },
			},
		);
		parentId = replyId;
	}
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

const writeSessionFile = (root, cwd, id, user, reply) => writeSessionTurns(root, cwd, id, [[user, reply]]);

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

		// esc closes a tile's menu before it would ever abort the run
		await tile(page, S1).locator(".cv-ctl-more").click();
		await expect(page.locator("#menu-overlay")).toHaveClass(/open/);
		await page.keyboard.press("Escape");
		await expect(page.locator("#menu-overlay")).not.toHaveClass(/open/);
		await expect(tile(page, S1).locator(".notice-text.error")).toHaveCount(0);

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

		// one tile per session: picking a session that's already here in the launcher flies to its tile
		await page.locator('.cv-hud-btn[data-act="new"]').click();
		const launcher = page.locator(".cv-tile.cv-launcher");
		await expect(launcher.locator(".cv-launch-search")).toBeFocused();
		await launcher.locator(`.cv-launch-row[data-key="repo:${cwd}"]`).click();
		await expect(launcher.locator(`.cv-launch-row[data-key="session:${S1}"] .cv-launch-badge`)).toHaveText("on canvas");
		await launcher.locator(`.cv-launch-row[data-key="session:${S1}"]`).click();
		await expect(launcher).toHaveCount(0);
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		await expect(tile(page, S1)).toHaveClass(/cv-focused/);

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

/** @param {import("@playwright/test").Locator} tileLocator */
const shownEntries = (tileLocator) =>
	tileLocator.locator(".msgs").evaluate((msgs) => [...new Set([...msgs.children].map((child) => child.dataset.entryId).filter(Boolean))]);

test("tiles keep the newest entries of a long transcript and page back on request", async ({ page }) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-canvas-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	const turns = Array.from({ length: 30 }, (_, i) => [`question ${i}`, `answer ${i}\n`.repeat(3)]);
	const path = await writeSessionTurns(root, cwd, S1, turns);
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
		}, path);

		const requests = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (url.pathname.endsWith("/events") || url.pathname.endsWith("/transcript")) requests.push(url);
		});
		await page.goto(`${base}/?ui=canvas`);
		const t = tile(page, S1);
		await expect(t.locator(".user-msg").first()).toHaveText("question 20");
		expect(await shownEntries(t)).toHaveLength(20);
		await expect(t.locator(".load-older")).toHaveText("↑ earlier messages");
		const events = requests.find((url) => url.pathname.endsWith("/events"));
		expect(events?.searchParams.get("limit")).toBe("20");

		// the toggle pages back (and focuses the tile, which keeps more)
		await t.locator(".load-older").click();
		await expect(t.locator(".user-msg").first()).toHaveText("question 0");
		expect(await shownEntries(t)).toHaveLength(60);
		await expect(t.locator(".load-older")).toHaveCount(0);
		const older = requests.find((url) => url.pathname.endsWith("/transcript"));
		expect(older?.searchParams.get("before")).toBe(`u20${S1.slice(-7)}`);
		expect(older?.searchParams.get("limit")).toBe("50");

		// following the bottom again, an unfocused tile goes back to its window
		await t.locator(".msgs").evaluate((msgs) => {
			msgs.scrollTop = msgs.scrollHeight;
		});
		await page.waitForTimeout(100);
		await page.evaluate(() => window.__canvas.canvas.tiles.focusTile(null));
		await expect.poll(() => shownEntries(t).then((ids) => ids.length)).toBe(20);
		await expect(t.locator(".user-msg").first()).toHaveText("question 20");
		await expect(t.locator(".load-older")).toHaveText("↑ earlier messages");
		await expect(t.locator(".user-msg").last()).toHaveText("question 29");

		// paging back again after a trim fetches what was dropped, without duplicates
		await t.locator(".load-older").click();
		await expect(t.locator(".user-msg").first()).toHaveText("question 0");
		expect(await shownEntries(t)).toHaveLength(60);
		await expect(t.locator(".user-msg")).toHaveCount(30);
	} finally {
		server.kill("SIGTERM");
		await new Promise((resolve) => server.once("exit", resolve));
		await rm(root, { recursive: true, force: true });
	}
});

test("the launcher lists a directory's sessions, resumes one in place, starts new ones, and steps back with esc", async ({ page }, testInfo) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-canvas-e2e-"));
	const cwd = join(root, "launch-repo");
	await mkdir(cwd);
	await writeSessionFile(root, cwd, S1, "hello from disk", "hi there");
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const server = await startServer(root, port);
	try {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`${base}/?ui=phone`);
		await page.evaluate(async (repo) => {
			await fetch("/api/client", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
			const res = await fetch("/api/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo }) });
			if (!res.ok) throw new Error(`repo not added: ${res.status}`);
		}, cwd);
		const posts = [];
		await page.route("**/api/sessions", (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			const body = route.request().postDataJSON();
			posts.push(body);
			if (body.cwd && !body.projectTrust) {
				return route.fulfill({ status: 409, json: { error: "Project trust required", projectTrust: { cwd: body.cwd, options: [{ choice: "trust_session", label: "Trust (this session only)", trusted: true }, { choice: "distrust", label: "Do not trust", trusted: false }] } } });
			}
			return route.fallback();
		});

		await page.goto(`${base}/?ui=canvas`);
		await expect(page.locator(".cv-root")).toBeVisible();
		await expect(page.locator(".cv-tile")).toHaveCount(0);

		// double-click on empty canvas opens a launcher there; esc steps back, then closes it
		await page.mouse.dblclick(700, 450);
		const launcher = page.locator(".cv-tile.cv-launcher");
		await expect(launcher).toHaveCount(1);
		const center = await page.evaluate(() => {
			const { canvas, launchers } = window.__canvas;
			const id = [...launchers.keys()][0];
			const { rect } = canvas.tiles.get(id);
			const cam = canvas.viewport.getCamera();
			return { x: (rect.x + rect.w / 2) * cam.scale + cam.x, y: (rect.y + rect.h / 2) * cam.scale + cam.y };
		});
		expect(Math.abs(center.x - 700)).toBeLessThan(2);
		expect(Math.abs(center.y - 450)).toBeLessThan(2);
		const search = launcher.locator(".cv-launch-search");
		await expect(search).toBeFocused();
		await search.fill("launch-repo");
		await expect(launcher.locator(".cv-launch-row")).toHaveCount(1);
		await search.press("Enter");
		await expect(launcher.locator(".cv-launch-crumb")).toHaveText("launch-repo · pick a session");
		await expect(launcher.locator(".cv-launch-row").first()).toHaveText(/new session/);
		await expect(launcher.locator(`.cv-launch-row[data-key="session:${S1}"]`)).toContainText("hello from disk");
		await page.screenshot({ path: testInfo.outputPath("launcher.png") });
		await testInfo.attach("launcher", { path: testInfo.outputPath("launcher.png"), contentType: "image/png" });
		await page.keyboard.press("Escape");
		await expect(launcher.locator(".cv-launch-crumb")).toHaveText("open a session · pick a directory");
		await page.keyboard.press("Escape");
		await expect(launcher).toHaveCount(0);

		// an old session: the launcher turns into its tile in place and resumes it
		await page.locator('.cv-hud-btn[data-act="new"]').click();
		await launcher.locator(`.cv-launch-row[data-key="repo:${cwd}"]`).click();
		const launcherRect = await page.evaluate(() => {
			const { canvas, launchers } = window.__canvas;
			return canvas.tiles.get([...launchers.keys()][0]).rect;
		});
		await launcher.locator(`.cv-launch-row[data-key="session:${S1}"]`).click();
		await expect(launcher).toHaveCount(0);
		await expect(tile(page, S1).locator(".user-msg")).toHaveText("hello from disk");
		await expect(tile(page, S1).locator(".cv-pill")).toHaveText(/idle|viewing/);
		await expect(tile(page, S1).locator("textarea")).toBeFocused();
		expect(await page.evaluate((id) => window.__canvas.canvas.tiles.get(id).rect, S1)).toEqual(launcherRect);
		expect(posts.at(-1)?.resumeSessionPath).toContain(S1);

		// a new session, after the project trust question asked inline
		await page.locator('.cv-hud-btn[data-act="new"]').click();
		await launcher.locator(`.cv-launch-row[data-key="repo:${cwd}"]`).click();
		await launcher.locator('.cv-launch-row[data-key="new"]').click();
		await expect(launcher.locator(".cv-launch-crumb")).toHaveText("trust this folder?");
		await launcher.locator(".cv-launch-row", { hasText: "Trust (this session only)" }).click();
		await expect(launcher).toHaveCount(0);
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		expect(posts.filter((body) => body.cwd).map((body) => body.projectTrust ?? null)).toEqual([null, "trust_session"]);
		const created = await page.evaluate((known) => [...window.__canvas.entries.keys()].find((id) => id !== known), S1);
		await expect(tile(page, created)).toHaveClass(/cv-focused/);
		await expect(tile(page, created).locator(".cv-pill")).toHaveText(/idle|viewing/);
		await expect(tile(page, created).locator("textarea")).toBeEnabled();
		await expect.poll(() => page.evaluate(async () => (await (await fetch("/api/canvas")).json()).tiles.length)).toBe(2);
	} finally {
		server.kill("SIGTERM");
		await new Promise((resolve) => server.once("exit", resolve));
		await rm(root, { recursive: true, force: true });
	}
});

const ASK_EXTENSION = `
export default function (pi) {
	pi.registerCommand("ask", {
		description: "asks twice before acting",
		handler: async (_args, ctx) => {
			ctx.ui.setTitle("asking a human");
			const first = await ctx.ui.confirm("Proceed?", "This needs a human");
			const second = await ctx.ui.confirm("Really?", "Asking twice");
			ctx.ui.setTitle("");
			ctx.ui.notify(first && second ? "went ahead" : "stopped", "info");
		},
	});
}
`;

test("extension dialogs stay inside their tile, leave the keyboard where it is, and turn the tile to waiting", async ({ page }) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-canvas-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	await mkdir(join(root, "agent", "extensions"), { recursive: true });
	await writeFile(join(root, "agent", "extensions", "ask.ts"), ASK_EXTENSION);
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
		await page.goto(`${base}/?ui=canvas`);
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		await expect(tile(page, S1).locator(".cv-pill")).toHaveText(/idle|viewing/);
		const pageTitle = await page.title();

		// ask from S1: the dialog opens inside S1's tile and, since S1 has the keyboard, takes it
		await tile(page, S1).locator(".msgs").click();
		await tile(page, S1).locator("textarea").fill("/ask");
		await tile(page, S1).locator("textarea").press("Enter");
		const dialog = tile(page, S1).locator(".ext-dialog-overlay");
		await expect(dialog.locator(".ext-dialog-title")).toHaveText("Proceed?");
		await expect(page.locator("body > .ext-dialog-overlay")).toHaveCount(0);
		await expect(dialog.locator("button:focus")).toHaveCount(1);
		await expect(tile(page, S1).locator(".cv-pill")).toHaveText("waiting");
		await expect(tile(page, S1)).toHaveClass(/cv-waiting/);
		await expect(tile(page, S1).locator(".cv-title")).toHaveText("asking a human");
		expect(await page.title()).toBe(pageTitle);

		// typing in S2 meanwhile: S1's next dialog (answered from elsewhere) must not take the keyboard
		await tile(page, S2).locator(".msgs").click();
		await expect(tile(page, S2).locator("textarea")).toBeFocused();
		const firstId = await dialog.getAttribute("data-dialog-id");
		await page.evaluate(
			async ([id, dialogId]) => {
				const res = await fetch(`/api/sessions/${id}/ui-response`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: dialogId, confirmed: true }) });
				if (!res.ok) throw new Error(`answer failed: ${res.status}`);
			},
			[S1, firstId],
		);
		await expect(dialog.locator(".ext-dialog-title")).toHaveText("Really?");
		await expect(tile(page, S2).locator("textarea")).toBeFocused();
		await expect(tile(page, S1)).toHaveClass(/cv-waiting/);

		// clicking the waiting tile hands the keyboard to its dialog; answering clears the waiting state
		await dialog.click({ position: { x: 8, y: 8 } });
		await expect(dialog.locator("button:focus")).toHaveCount(1);
		await dialog.getByRole("button", { name: "Yes", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(tile(page, S1)).not.toHaveClass(/cv-waiting/);
		await expect(tile(page, S1).locator(".cv-pill")).toHaveText(/idle|viewing/);
		await expect(tile(page, S1).locator(".notice-text").last()).toContainText("went ahead");
		await expect(tile(page, S1).locator(".cv-title")).toContainText("repo");
	} finally {
		server.kill("SIGTERM");
		await new Promise((resolve) => server.once("exit", resolve));
		await rm(root, { recursive: true, force: true });
	}
});
