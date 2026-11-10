// Release does what /quit does, on the canvas and on the phone: it stops the session here (its file stays, so it
// resumes from the list) and hands the pane back, to a launcher at the directory step on the canvas and to the New
// sheet on the phone. While pi works it refuses with a notice and nothing changes. A browser that only watched is told
// the session stopped, in one line. Real isolated servers; a faux model (an extension in the throwaway agent dir)
// answers prompts, and keeps working on "hold on" until Esc.
import { devices, expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

const S1 = "01a1e1ea-0000-7000-8000-0000000000e1";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const REFUSED = "Not released: pi is still working. Esc stops it first";
const STOPPED_ELSEWHERE = "This session was stopped elsewhere. It resumes from the list.";

const FAUX_EXTENSION = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((part) => part?.text ?? "").join(""));
const lastUserText = (context) => textOf([...context.messages].reverse().find((message) => message.role === "user")?.content);

/** "hold on" keeps pi working until it's stopped; anything else gets an answer. */
async function respond(context, options) {
	if (lastUserText(context).includes("hold on")) {
		await new Promise((resolve) => {
			if (options?.signal?.aborted) return resolve();
			const timer = setTimeout(resolve, 120_000);
			options?.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
		});
	}
	return fauxAssistantMessage("got it");
}

export default function (pi) {
	const faux = fauxProvider({ provider: "e2e-faux", models: [{ id: "faux-1", name: "faux one" }] });
	faux.setResponses(Array.from({ length: 20 }, () => respond));
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

/** One user/assistant pair on disk, the way pi saves a session. */
async function writeSessionFile(root, cwd, id, user, reply) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-15T10-00-00-000Z_${id}.jsonl`);
	const tail = id.slice(-7);
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-10-15T10:00:00.000Z", cwd },
		{ type: "message", id: `u${tail}`, parentId: null, timestamp: "2026-10-15T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: user }], timestamp: 1 } },
		{
			type: "message",
			id: `a${tail}`,
			parentId: `u${tail}`,
			timestamp: "2026-10-15T10:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: reply }], api: "faux", provider: "e2e-faux", model: "faux-1", usage, stopReason: "stop", timestamp: 2 },
		},
	];
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

/** An isolated root with a repo folder, one saved session in it, the faux model, and a server on its own port. */
async function setup() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-release-e2e-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	await mkdir(join(root, "agent", "extensions"), { recursive: true });
	await writeFile(join(root, "agent", "extensions", "faux.ts"), FAUX_EXTENSION);
	await writeFile(join(root, "agent", "auth.json"), JSON.stringify({ "e2e-faux": { type: "api_key", key: "not-a-real-key" } }));
	const path = await writeSessionFile(root, cwd, S1, "hello from disk", "hi there");
	const port = await freePort();
	const server = await startServer(root, port);
	return { root, cwd, path, server, base: `http://127.0.0.1:${port}` };
}

/** @param {import("@playwright/test").Page} page @param {string} cwd @returns {Promise<string>} this browser's client id */
function addRepo(page, cwd) {
	return page.evaluate(async (repo) => {
		const client = await (await fetch("/api/client", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
		const res = await fetch("/api/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo }) });
		if (!res.ok) throw new Error(`repo not added: ${res.status}`);
		return client.clientId;
	}, cwd);
}

const activeIds = (page) => page.evaluate(async () => (await (await fetch("/api/active-sessions")).json()).sessions.map((s) => s.id));

/** The launcher (a canvas tile or the phone's sheet) lists the session in its folder, not running. */
async function expectListedStopped(launcher, cwd) {
	await launcher.locator(`.cv-launch-row[data-key="repo:${cwd}"]`).click();
	const row = launcher.locator(`.cv-launch-row[data-key="session:${S1}"]`);
	await expect(row).toContainText("hello from disk");
	await expect(row.locator(".cv-launch-badge")).toHaveCount(0);
}

/** Counts it if `selector` ever shows `text` from here on. */
function watchFor(page, selector, text) {
	return page.evaluate(
		([sel, needle]) => {
			const el = document.querySelector(sel);
			window.__sawText = false;
			new MutationObserver(() => {
				if (el?.textContent?.includes(needle)) window.__sawText = true;
			}).observe(el, { childList: true, subtree: true, characterData: true });
		},
		[selector, text],
	);
}

test.describe("canvas", () => {
	test.beforeEach(({}, testInfo) => {
		test.skip(testInfo.project.name !== "chromium", "the canvas is laptop chrome only");
	});

	const tile = (page, id) => page.locator(`.cv-tile[data-tile-id="${id}"]`);
	const savedIds = (page) => page.evaluate(async () => (await (await fetch("/api/canvas")).json()).tiles.map((t) => t.sessionId));
	const menuItem = (page, primary) => page.locator(".menu-item", { has: page.locator(".primary", { hasText: primary }) });

	test("Release in a tile's menu is refused while pi works, then stops the session and leaves a launcher at the directory step", async ({ page }, testInfo) => {
		const { root, cwd, server, base } = await setup();
		try {
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`${base}/?ui=phone`);
			await addRepo(page, cwd);
			await page.goto(`${base}/?ui=canvas`);
			await expect.poll(() => page.evaluate(() => Boolean(window.__canvas))).toBe(true);
			await page.locator('.cv-hud-btn[data-act="new"]').click();
			const launcher = page.locator(".cv-tile.cv-launcher");
			await launcher.locator(`.cv-launch-row[data-key="repo:${cwd}"]`).click();
			await launcher.locator(`.cv-launch-row[data-key="session:${S1}"]`).click();
			await expect(launcher).toHaveCount(0);
			const t = tile(page, S1);
			const composer = t.locator("textarea");
			await expect(composer).toBeEnabled();
			await expect(t.locator(".cv-ctl-model .sel")).toHaveText("e2e-faux/faux-1");
			await expect.poll(() => activeIds(page)).toEqual([S1]);
			await expect.poll(() => savedIds(page)).toEqual([S1]);
			const rect = await page.evaluate((id) => window.__canvas.canvas.tiles.get(id).rect, S1);

			// pi works: Release says why not, and the tile, its session and its run stay
			await composer.fill("hold on");
			await composer.press("Enter");
			await expect(t.locator(".cv-pill")).toHaveText("working");
			await t.locator(".cv-ctl-more").click();
			await expect(menuItem(page, "Release").locator(".secondary")).toHaveText("stop the session here, like /quit; it resumes from the list");
			await menuItem(page, "Release").click();
			await expect(t.locator(".notice-text.error").filter({ hasText: "Not released" })).toHaveText(REFUSED);
			await expect(t.locator(".cv-pill")).toHaveText("working");
			await expect(launcher).toHaveCount(0);
			expect(await activeIds(page)).toEqual([S1]);
			expect(await savedIds(page)).toEqual([S1]);

			// Esc (the menu's Abort run), then Release: the session stops and a launcher takes the tile's place, back at
			// picking a directory, without the tile ever showing the stopped line on its way out
			await t.locator(".cv-ctl-more").click();
			await menuItem(page, "Abort run").click();
			await expect(t.locator(".cv-pill")).toHaveText("idle");
			await watchFor(page, `.cv-tile[data-tile-id="${S1}"]`, "stopped elsewhere");
			await t.locator(".cv-ctl-more").click();
			await menuItem(page, "Release").click();
			await expect(t).toHaveCount(0);
			expect(await page.evaluate(() => window.__sawText)).toBe(false);
			await expect(launcher).toHaveCount(1);
			await expect(launcher).toHaveClass(/cv-focused/);
			await expect(launcher.locator(".cv-launch-crumb")).toHaveText("open a session · pick a directory");
			await expect(launcher.locator(".cv-launch-search")).toBeFocused();
			expect(await page.evaluate(() => window.__canvas.canvas.tiles.get([...window.__canvas.launchers.keys()][0])?.rect ?? null)).toEqual(rect);
			await expect.poll(() => activeIds(page)).toEqual([]);
			await expect.poll(() => savedIds(page)).toEqual([]);
			await page.screenshot({ path: testInfo.outputPath("release-launcher.png") });
			await testInfo.attach("release-launcher", { path: testInfo.outputPath("release-launcher.png"), contentType: "image/png" });

			// its file stays: the directory lists it, not running, to pick up again
			await expectListedStopped(launcher, cwd);
		} finally {
			await stopServer(server).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});
});

test("the phone's Release is refused while pi works, then stops the session, empties the pane and opens the New sheet; a watching browser is told it stopped", async ({ page, browser }, testInfo) => {
	// a real phone only has the keybar's Release; the laptop's phone layout has the top bar's
	const phone = testInfo.project.name.includes("iphone");
	const releaseBtn = page.locator(phone ? "#kb-release" : "#btn-release");
	const escBtn = page.locator(phone ? "#kb-esc" : "#btn-abort");
	const sheet = page.locator(".ph-launch");
	const expectBusy = async (busy) => {
		if (phone) await expect(page.locator("#working")).toBeVisible({ visible: busy });
		else await expect(page.locator("#inp")).toHaveAttribute("placeholder", busy ? /^Streaming/ : /^Type a prompt/);
	};
	const { root, cwd, path, server, base } = await setup();
	// the watcher is the same kind of device
	const { defaultBrowserType: _type, ...device } = devices["iPhone 14"];
	const watcherContext = await browser.newContext(phone ? device : {});
	try {
		await page.goto(`${base}/?ui=phone`);
		const clientId = await addRepo(page, cwd);
		await page.evaluate(
			async ([resumeSessionPath, client]) => {
				const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client, resumeSessionPath }) });
				if (!res.ok) throw new Error(`start failed: ${res.status}`);
			},
			[path, clientId],
		);
		await page.reload();
		if (phone) await page.locator("#kb-menu").click();
		await page.locator(`.si[data-session-id="${S1}"]`).click();
		await expect(page.locator("#role-pill")).toHaveText("controller");
		await expect(page.locator("#footer-left-2")).toContainText(S1.slice(0, 8));
		await expect(releaseBtn).toBeVisible();
		await expect(releaseBtn).toHaveAttribute("title", "Release: stop the session here, like /quit; it resumes from the list");
		await expect(releaseBtn).toHaveText("Release");

		// another browser watches the same session
		const watcher = await watcherContext.newPage();
		await watcher.goto(`${base}/?ui=phone`);
		if (phone) await watcher.locator("#kb-menu").click();
		await watcher.locator(`.si[data-session-id="${S1}"]`).click();
		await expect(watcher.locator("#role-pill")).toHaveText("viewer");
		await expect(watcher.locator("#msgs .user-msg").first()).toHaveText("hello from disk");

		// pi works: Release says why not, and the session and the pane stay
		await page.locator("#inp").fill("hold on");
		if (phone) await page.locator("#kb-enter").click();
		else await page.locator("#inp").press("Enter");
		await expectBusy(true);
		await releaseBtn.click();
		await expect(page.locator(".notice-text.error").filter({ hasText: "Not released" })).toHaveText(REFUSED);
		await expectBusy(true);
		await expect(sheet).toBeHidden();
		await expect(page.locator("#role-pill")).toHaveText("controller");
		await expect(page.locator("#footer-left-2")).toContainText(S1.slice(0, 8));
		expect(await activeIds(page)).toEqual([S1]);

		// Esc, then Release: the session stops, the pane empties, and the New sheet opens at picking a directory
		await escBtn.click();
		await expectBusy(false);
		await releaseBtn.click();
		await expect(sheet).toBeVisible();
		await expect(sheet.locator(".cv-launch-crumb")).toHaveText("open a session · pick a directory");
		await expect(page.locator("#msgs .notice-text")).toHaveText(["No session selected."]);
		await expect(page.locator("#msgs .user-msg")).toHaveCount(0);
		await expect(page.locator("#footer-left-2")).not.toContainText(S1.slice(0, 8));
		await expect.poll(() => activeIds(page)).toEqual([]);
		await page.screenshot({ path: testInfo.outputPath("release-sheet.png") });
		await testInfo.attach("release-sheet", { path: testInfo.outputPath("release-sheet.png"), contentType: "image/png" });

		// the watcher is told, in one line
		await expect(watcher.locator("#msgs")).toHaveText(STOPPED_ELSEWHERE);
		await expect(watcher.locator("#msgs .tool-box")).toHaveCount(0);

		// its file stays: the sheet lists it in its folder, not running, to pick up again
		await expectListedStopped(sheet, cwd);
	} finally {
		await watcherContext.close().catch(() => {});
		await stopServer(server).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
