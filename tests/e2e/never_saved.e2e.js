// A session nobody sent anything to was never saved (pi writes the file with the first message), so a server
// restart leaves nothing to resume. The tile or page that had it keeps its draft, says nothing, and enter starts a
// new session in the same folder and sends the draft there. Real restarts of an isolated server; a faux model
// (an extension in the throwaway agent dir, with a fake key there) answers the prompts.
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

const FAUX_EXTENSION = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default function (pi) {
	const faux = fauxProvider({ provider: "e2e-faux", models: [{ id: "faux-1", name: "faux one" }] });
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("got it")));
	pi.registerProvider(faux.provider);
	pi.on("session_start", async (_event, ctx) => {
		const model = ctx.modelRegistry.find("e2e-faux", "faux-1");
		if (model) await pi.setModel(model);
	});
}
`;

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

async function stopServer(proc) {
	if (proc.exitCode !== null) return;
	const exited = new Promise((resolve) => proc.once("exit", resolve));
	proc.kill("SIGTERM");
	await exited;
}

/** An isolated root with a saved repo folder and the faux model. */
async function setup() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-never-saved-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	await mkdir(join(root, "agent", "extensions"), { recursive: true });
	await writeFile(join(root, "agent", "extensions", "faux.ts"), FAUX_EXTENSION);
	await writeFile(join(root, "agent", "auth.json"), JSON.stringify({ "e2e-faux": { type: "api_key", key: "not-a-real-key" } }));
	const port = await freePort();
	return { root, cwd, port, base: `http://127.0.0.1:${port}` };
}

/** @param {import("@playwright/test").Page} page @param {string} cwd */
async function addRepo(page, cwd) {
	return page.evaluate(async (repo) => {
		const client = await (await fetch("/api/client", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
		const res = await fetch("/api/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo }) });
		if (!res.ok) throw new Error(`repo not added: ${res.status}`);
		return client.clientId;
	}, cwd);
}

const activeSessions = (page) => page.evaluate(async () => (await (await fetch("/api/active-sessions")).json()).sessions.map((s) => ({ id: s.id, cwd: s.cwd })));

test.describe("canvas", () => {
	test.beforeEach(({}, testInfo) => {
		test.skip(testInfo.project.name !== "chromium", "the canvas is laptop chrome only");
	});

	const tile = (page, id) => page.locator(`.cv-tile[data-tile-id="${id}"]`);
	const tileIds = (page) => page.evaluate(() => [...window.__canvas.entries.keys()]);
	const savedTiles = (page) => page.evaluate(async () => (await (await fetch("/api/canvas")).json()).tiles.map((t) => t.sessionId));
	const isFresh = (page, id) => page.evaluate((tileId) => Boolean(window.__canvas.entries.get(tileId)?.pane.isFresh()), id);

	/** A new session from the launcher, as a focused tile. */
	async function newSessionTile(page, cwd) {
		await page.locator('.cv-hud-btn[data-act="new"]').click();
		const launcher = page.locator(".cv-tile.cv-launcher");
		await launcher.locator(`.cv-launch-row[data-key="repo:${cwd}"]`).click();
		await launcher.locator('.cv-launch-row[data-key="new"]').click();
		await expect(launcher).toHaveCount(0);
		const [id] = await tileIds(page);
		await expect(tile(page, id).locator(".cv-pill")).toHaveText("idle");
		await expect(tile(page, id).locator(".cv-ctl-model .sel")).toHaveText("e2e-faux/faux-1");
		return id;
	}

	/** Enter in a fresh tile: a new session in the same folder takes the tile over and gets the draft. */
	async function sendFromFreshTile(page, id, text, cwd) {
		await tile(page, id).locator("textarea").press("Enter");
		await expect.poll(() => tileIds(page)).not.toEqual([id]);
		const [next] = await tileIds(page);
		expect(next).not.toBe(id);
		await expect(tile(page, next).locator(".user-msg")).toHaveText([text]);
		await expect(tile(page, next).locator(".assistant-block .md")).toHaveText(["got it"]);
		await expect(tile(page, next).locator(".notice-text")).toHaveCount(0);
		await expect(tile(page, next).locator(".cv-pill")).toHaveText("idle");
		expect(await activeSessions(page)).toEqual([{ id: next, cwd }]);
		await expect.poll(() => savedTiles(page)).toEqual([next]);
		return next;
	}

	test("a draft outlives the restart that took its never-messaged session, and enter sends it to a new session in the same folder", async ({ page }, testInfo) => {
		const { root, cwd, port, base } = await setup();
		let server = await startServer(root, port);
		try {
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`${base}/?ui=phone`);
			await addRepo(page, cwd);
			await page.goto(`${base}/?ui=canvas`);
			await expect.poll(() => page.evaluate(() => Boolean(window.__canvas))).toBe(true);

			const first = await newSessionTile(page, cwd);
			const composer = tile(page, first).locator("textarea");
			await composer.pressSequentially("hello after the restart");
			await expect.poll(() => savedTiles(page)).toEqual([first]);

			await stopServer(server);
			await expect(tile(page, first).locator(".cv-pill")).toHaveText("reconnecting");
			server = await startServer(root, port);

			// nothing to resume and nothing to say: the same tile, ready, draft and settings kept
			await expect.poll(() => isFresh(page, first), { timeout: 20_000 }).toBe(true);
			await expect(tile(page, first).locator(".cv-pill")).toHaveText("idle");
			await expect(tile(page, first).locator(".notice-text")).toHaveCount(0);
			await expect(composer).toBeEnabled();
			await expect(composer).toHaveValue("hello after the restart");
			await expect(composer).toBeFocused();
			await expect(tile(page, first).locator(".cv-ctl-model .sel")).toHaveText("e2e-faux/faux-1");
			await page.screenshot({ path: testInfo.outputPath("fresh-tile.png") });
			await testInfo.attach("fresh-tile", { path: testInfo.outputPath("fresh-tile.png"), contentType: "image/png" });

			await sendFromFreshTile(page, first, "hello after the restart", cwd);
		} finally {
			await stopServer(server).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an idle tile whose never-messaged session went away goes fresh instead of offering a resume, after a reload too", async ({ page }) => {
		const { root, cwd, port, base } = await setup();
		let server = await startServer(root, port);
		try {
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`${base}/?ui=phone`);
			await addRepo(page, cwd);
			await page.goto(`${base}/?ui=canvas&idleSuspendMs=300`);
			await expect.poll(() => page.evaluate(() => Boolean(window.__canvas))).toBe(true);

			const first = await newSessionTile(page, cwd);
			await tile(page, first).locator("textarea").pressSequentially("kept while idle");
			// unfocused, it lets go of its stream once idle
			await page.evaluate(() => window.__canvas.canvas.tiles.focusTile(null));
			await expect.poll(() => page.evaluate((id) => window.__canvas.entries.get(id)?.pane.getConnection(), first)).toBe("suspended");

			await stopServer(server);
			server = await startServer(root, port);

			// the status stream says it's gone; with no file behind it, the tile goes fresh, not dormant
			await expect.poll(() => isFresh(page, first), { timeout: 20_000 }).toBe(true);
			await expect(tile(page, first).locator(".cv-pill")).toHaveText("idle");
			await expect(tile(page, first).locator(".notice-text")).toHaveCount(0);
			await expect(tile(page, first).locator("textarea")).toHaveValue("kept while idle");

			// after a reload the map still names the old session: same answer, no resume
			await page.reload();
			await expect.poll(() => page.evaluate(() => Boolean(window.__canvas))).toBe(true);
			await expect.poll(() => isFresh(page, first)).toBe(true);
			await expect(tile(page, first).locator(".cv-pill")).toHaveText("idle");
			await expect(tile(page, first).locator(".notice-text")).toHaveCount(0);
			await tile(page, first).locator(".cv-ctl-more").click();
			await expect(page.locator("#menu-panel .menu-item .primary")).toHaveText(["Remove from canvas"]);
			await page.keyboard.press("Escape");
			await tile(page, first).locator("textarea").click();
			await expect(tile(page, first).locator("textarea")).toBeFocused();
			await tile(page, first).locator("textarea").pressSequentially("after a reload");

			await sendFromFreshTile(page, first, "after a reload", cwd);
		} finally {
			await stopServer(server).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});

	test("/quit in a fresh tile starts no session and leaves a launcher in its place", async ({ page }) => {
		const { root, cwd, port, base } = await setup();
		let server = await startServer(root, port);
		try {
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`${base}/?ui=phone`);
			await addRepo(page, cwd);
			await page.goto(`${base}/?ui=canvas`);
			await expect.poll(() => page.evaluate(() => Boolean(window.__canvas))).toBe(true);

			const first = await newSessionTile(page, cwd);
			await stopServer(server);
			server = await startServer(root, port);
			await expect.poll(() => isFresh(page, first), { timeout: 20_000 }).toBe(true);

			const composer = tile(page, first).locator("textarea");
			await composer.fill("/quit");
			await composer.press("Enter");
			const launcher = page.locator(".cv-tile.cv-launcher");
			await expect(launcher).toHaveCount(1);
			await expect(tile(page, first)).toHaveCount(0);
			await expect(launcher.locator(".cv-launch-crumb")).toHaveText("open a session \u00b7 pick a directory");
			await expect(launcher.locator(".cv-launch-search")).toBeFocused();
			await expect.poll(() => savedTiles(page)).toEqual([]);
			expect(await tileIds(page)).toEqual([]);
			expect(await activeSessions(page)).toEqual([]);
		} finally {
			await stopServer(server).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});
});

test("the phone keeps its draft across a restart that took a never-messaged session, and sending starts a new one", async ({ page }, testInfo) => {
	const phone = testInfo.project.name.includes("iphone");
	const { root, cwd, port, base } = await setup();
	let server = await startServer(root, port);
	try {
		await page.goto(`${base}/?ui=phone`);
		const clientId = await addRepo(page, cwd);
		const created = await page.evaluate(
			async ([repo, client]) => (await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client, cwd: repo }) })).json(),
			[cwd, clientId],
		);
		await page.reload();
		if (phone) await page.locator("#kb-menu").click();
		await page.locator(`.si[data-session-id="${created.sessionId}"]`).click();
		await expect(page.locator("#role-pill")).toHaveText("controller");
		await expect(page.locator("#footer-left-2")).toContainText(created.sessionId.slice(0, 8));
		await page.locator("#inp").fill("hello from the phone");

		await stopServer(server);
		await expect(page.locator("#role-pill")).toHaveText("reconnecting");
		server = await startServer(root, port);

		// ready again with the draft, nothing said about the session that never was
		await expect(page.locator("#role-pill")).toHaveText("controller", { timeout: 20_000 });
		await expect(page.locator("#footer-left-2")).not.toContainText(created.sessionId.slice(0, 8));
		await expect(page.locator(".notice-text")).toHaveCount(0);
		await expect(page.locator("#inp")).toBeEnabled();
		await expect(page.locator("#inp")).toHaveValue("hello from the phone");

		if (phone) await page.locator("#kb-enter").click();
		else await page.locator("#inp").press("Enter");
		await expect(page.locator(".user-msg")).toHaveText(["hello from the phone"]);
		await expect(page.locator(".assistant-block .md")).toHaveText(["got it"]);
		await expect(page.locator(".notice-text.error")).toHaveCount(0);
		const active = await activeSessions(page);
		expect(active).toHaveLength(1);
		expect(active[0].id).not.toBe(created.sessionId);
		expect(active[0].cwd).toBe(cwd);
		await expect(page.locator("#footer-left-2")).toContainText(active[0].id.slice(0, 8));
	} finally {
		await stopServer(server).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
