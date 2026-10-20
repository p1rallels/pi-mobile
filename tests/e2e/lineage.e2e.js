// msg's lineage and relay's state in a session's header (the phone shell's, on a phone and a laptop) and in a canvas
// tile's pill, read by an isolated server from its own msg store (presence records in <root>/agent/msg/sessions,
// written the way msg writes them: a temp file renamed into place). The lead, hosted here, lists its children with how
// each stands (an ended scout pi-web can open, a flaky one whose process died, a worker another pi runs), and relay's
// resets and loop; a child that comes or ends changes the line without a reload; a child's link opens it read-only
// (pi-web never loads a sub), and the worker's own header says whose child it is. A live child in one tool call for a
// minute or more says so (the tool and its minutes in the line, the command in the details); a shorter call shows nothing.
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

const LEAD = "01a152a0-0000-7000-8000-00000000000a";
const SCOUT = "01a152d4-0000-7000-8000-00000000000b";
const FLAKY = "01a152d4-0000-7000-8000-00000000000c";
const WORKER = "01a152d4-0000-7000-8000-00000000000d";
const API = "01a152d4-0000-7000-8000-00000000000e";
const WEB = "01a152d4-0000-7000-8000-00000000000f";
// what msg's preview of a long bash call looks like: the command, one line, under its 120 characters
const E2E_COMMAND = "bun run test:e2e -- tests/e2e/lineage.e2e.js --project=webkit-iphone --reporter=line --retries=0";
// above any pid macOS hands out (99998) and rarely reached on linux, so kill(pid, 0) says it's gone
const DEAD_PID = 999_999;
const GOAL = "ship the lineage pill";
const LIVE_TIMEOUT = { timeout: 10_000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const text = (value) => [{ type: "text", text: value }];
const line = (value) => `${JSON.stringify(value)}\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Entries in pi's file format, chained root to leaf, `at` ms apart from `start`. */
function chain(rows, start) {
	return rows.map((row, index) => {
		const id = `${row.prefix ?? "e"}${String(index + 1).padStart(7, "0")}`;
		const at = start + index * 1000;
		const parentId = index === 0 ? null : `${row.prefix ?? "e"}${String(index).padStart(7, "0")}`;
		const { prefix: _prefix, ...entry } = row;
		const timestamp = new Date(at).toISOString();
		if (entry.type === "message") return { ...entry, id, parentId, timestamp, message: { ...entry.message, timestamp: at } };
		if (entry.type === "compaction") return { ...entry, id, parentId, timestamp, firstKeptEntryId: id };
		return { ...entry, id, parentId, timestamp };
	});
}

const user = (value) => ({ type: "message", message: { role: "user", content: text(value) } });
const assistant = (value) => ({ type: "message", message: { role: "assistant", content: text(value), api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "stop" } });
const relayReset = (n, note) => ({ type: "compaction", summary: `relay #${n} at 45%\n\nnote: ${note}`, tokensBefore: 90_000, details: { relay: { n, percent: 45, note } }, fromHook: true });

/** The lead: relay's loop switched on with a goal, one reset, and work since. */
function leadEntries(start) {
	return chain(
		[
			user("fan out the pill work"),
			{ type: "custom", customType: "relay", data: { loop: "on", goal: GOAL, by: "user" } },
			assistant("scout first, then a worker"),
			relayReset(1, "scout reported; next: the worker"),
			user("carry on"),
			assistant("the worker is on it"),
		],
		Date.now() - 120_000,
	);
}

async function writeSession(root, cwd, id, entries) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-19T06-00-00-000Z_${id}.jsonl`);
	await writeFile(path, [{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }, ...entries].map(line).join(""));
	return path;
}

/** A presence record the way msg writes one: to a temp file, renamed into place (which is what moves the folder's mtime). */
async function writePresence(root, record) {
	const dir = join(root, "agent", "msg", "sessions");
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `.${record.id}.${process.pid}.tmp`);
	await writeFile(temp, JSON.stringify(record));
	await rename(temp, join(dir, `${record.id}.json`));
}

// a heartbeat ahead of the clock stays fresh for the whole test, where msg would rewrite it every 10s
const presence = (id, fields) => ({ v: 1, id, mode: "print", activity: "idle", heartbeatAt: Date.now() + 10 * 60_000, ...fields });

/** `ps` lists it as pi, like pi's own process.title, and it leads its own process group like a pfs run. */
function spawnFakePi(cwd) {
	return spawn("node", ["-e", 'process.title = "pi"; setInterval(() => {}, 1000);'], { cwd, stdio: "ignore", detached: true });
}

function exited(proc) {
	return proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((resolve) => proc.once("exit", resolve));
}

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
			await sleep(100);
		}
	}
	proc.kill();
	throw new Error("server did not become healthy");
}

/**
 * An isolated host: the lead's session file, the scout's (it ended, and pi-web can open its file), and msg's store with
 * the lead, the scout and flaky (its process died without ending; it has no file here).
 */
async function setup() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-lineage-e2e-"));
	const repo = join(root, "repo");
	const fork = (n) => join(repo, ".forks", String(n));
	await Promise.all([1, 2, 3].map((n) => mkdir(fork(n), { recursive: true })));
	const now = Date.now();
	const leadPath = await writeSession(root, repo, LEAD, leadEntries(now));
	await writeSession(root, fork(1), SCOUT, chain([user("scout the store"), assistant("three records, one stale")], now - 100_000));
	await writePresence(root, presence(LEAD, { name: "lead", cwd: repo, pid: process.pid, mode: "web", startedAt: now - 200_000 }));
	await writePresence(root, presence(SCOUT, { name: "scout", parent: LEAD, cwd: fork(1), pid: DEAD_PID, startedAt: now - 100_000, heartbeatAt: now - 30_000, endedAt: now - 30_000 }));
	await writePresence(root, presence(FLAKY, { name: "flaky", parent: LEAD, cwd: fork(3), pid: DEAD_PID, startedAt: now - 50_000, heartbeatAt: now - 40_000 }));
	const port = await freePort();
	return { root, leadPath, workerCwd: fork(2), port, base: `http://127.0.0.1:${port}` };
}

/**
 * The worker: another pi (a fake one, in its folder) in the middle of a turn, so pi-web follows it; its presence record
 * names the lead as its parent.
 */
async function startWorker(env) {
	const writer = spawnFakePi(env.workerCwd);
	// the writer must have started before the file's last write to count as its writer
	await sleep(1_200);
	const path = await writeSession(env.root, env.workerCwd, WORKER, chain([{ ...user("build the pill"), prefix: "w" }], Date.now()));
	const record = presence(WORKER, { name: "worker", parent: LEAD, cwd: env.workerCwd, pid: writer.pid, activity: "busy", startedAt: Date.now() });
	await writePresence(env.root, record);
	return { writer, path, record };
}

/** Resumes the lead on the host, the way a sidebar or launcher pick would. */
async function resumeLead(page, leadPath) {
	await page.evaluate(async (resumeSessionPath) => {
		const client = await (await fetch("/api/client", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
		const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, resumeSessionPath }) });
		if (!res.ok) throw new Error(`resume failed: ${res.status}`);
	}, leadPath);
}

async function shoot(page, testInfo, name) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: false });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

const LEAD_RELAY = "relay · 1 reset · loop";

/**
 * Opens a session the header's line names: its link on a laptop; on a phone, where the line is cut short, a tap on the
 * line's first words opens the details, and the row opens it.
 */
async function openFromLine(page, phone, id) {
	const lineEl = page.locator("#lineage-line");
	if (!phone) {
		await lineEl.locator(`a.lin-party[data-session-id="${id}"]`).click();
		return;
	}
	await lineEl.locator(".lin-seg").first().click({ position: { x: 3, y: 20 } });
	await page.locator(`#menu-panel .menu-item[data-session-id="${id}"]`).click();
	await expect(page.locator("#menu-overlay")).not.toHaveClass(/\bopen\b/);
}

test("the header lists the lead's children and relay, follows a child coming and ending, and opens them", async ({ page }, testInfo) => {
	const phone = testInfo.project.name.includes("iphone");
	const env = await setup();
	let server = null;
	let worker = null;
	try {
		server = await startServer(env.root, env.port);
		await page.goto(`${env.base}/?ui=phone`);
		await resumeLead(page, env.leadPath);
		await page.reload();
		if (phone) await page.locator("#kb-menu").click();
		await page.locator(`.si[data-session-id="${LEAD}"]`).click();

		const lineEl = page.locator("#lineage-line");
		const segments = lineEl.locator(".lin-seg");
		await expect(segments).toHaveText(["2 children: flaky died · scout ended", LEAD_RELAY], LIVE_TIMEOUT);
		await expect(lineEl.locator("a.lin-party")).toHaveText(["scout"]);
		await expect(lineEl.locator("span.lin-party")).toHaveText(["flaky"]);
		await expect(lineEl.locator("span.lin-party")).toHaveAttribute("title", /died · pi -p · .*\/repo\/\.forks\/3 · pi-web can't open it/);
		// one line: the header keeps its height, and the composer stays where it was
		expect((await page.locator(".app-header").boundingBox())?.height).toBe(40);
		expect(await lineEl.evaluate((el) => el.getBoundingClientRect().right <= document.querySelector(".app-header-right").getBoundingClientRect().left)).toBe(true);

		// the details: everything in full, the loop's goal included
		await segments.nth(1).click();
		const menu = page.locator("#menu-panel");
		await expect(menu.locator(".menu-sub")).toHaveText(["2 children", "relay"]);
		await expect(menu.locator(".menu-item .primary")).toHaveText(["flaky · 01a152d4", "scout · 01a152d4", "1 reset of the context so far", "loop on"]);
		await expect(menu.locator(".menu-item .secondary").first()).toHaveText(/^died · pi -p · .*\/repo\/\.forks\/3 · pi-web can't open it$/);
		await expect(menu.locator(".menu-item.is-wrap .secondary")).toHaveText(`goal: ${GOAL}`);
		await shoot(page, testInfo, "lineage-details");
		await menu.locator(".menu-mini").click();
		await expect(page.locator("#menu-overlay")).not.toHaveClass(/\bopen\b/);

		// a child comes, then ends: the line follows without a reload
		worker = await startWorker(env);
		await expect(segments).toHaveText(["3 children: flaky died · worker · scout ended", LEAD_RELAY], LIVE_TIMEOUT);
		await shoot(page, testInfo, "lineage-header");
		await writePresence(env.root, { ...worker.record, activity: "idle", endedAt: Date.now() });
		await expect(segments).toHaveText(["3 children: flaky died · worker ended · scout ended", LEAD_RELAY], LIVE_TIMEOUT);

		// the worker's link follows it read-only (another pi still runs it, and it's a sub), and its header says whose child it is
		await openFromLine(page, phone, WORKER);
		await expect(page.locator(".user-msg")).toHaveText(["build the pill"]);
		await expect(page.locator("#role-pill")).toHaveText("read-only");
		await expect(page.locator("#read-only-note")).toHaveText("Read-only: lead manages this sub · Esc stops it");
		await expect(page.locator("#editor-wrap")).toBeHidden();
		await expect(segments).toHaveText(["child of lead · 01a152a0"], LIVE_TIMEOUT);
		await expect(lineEl.locator(`a.lin-party[data-session-id="${LEAD}"]`)).toHaveText("lead");
		// a relay reset in the worker's file bumps its count
		await appendFile(worker.path, line({ ...relayReset(1, "built; next: tests"), id: "w0000002", parentId: "w0000001", timestamp: new Date().toISOString(), firstKeptEntryId: "w0000002" }));
		await expect(segments).toHaveText(["child of lead · 01a152a0", "relay · 1 reset"], LIVE_TIMEOUT);

		// back to the lead through the worker's line (it hosts the lead: the composer is back), then the scout's link
		await openFromLine(page, phone, LEAD);
		await expect(page.locator(".assistant-block .md").last()).toHaveText("the worker is on it");
		await expect(segments).toHaveText(["3 children: flaky died · worker ended · scout ended", LEAD_RELAY], LIVE_TIMEOUT);
		await expect(page.locator("#editor-wrap")).toBeVisible();
		await expect(page.locator("#read-only-note")).toBeHidden();
		await openFromLine(page, phone, SCOUT);
		await expect(page.locator(".assistant-block .md")).toHaveText(["three records, one stale"]);
		// the scout ended: its transcript, read-only, never loaded here, so msg never rewrote its record and it's still the lead's child
		await expect(page.locator("#role-pill")).toHaveText("read-only");
		await expect(page.locator("#read-only-note")).toHaveText("Read-only: lead manages this sub");
		await expect(page.locator("#editor-wrap")).toBeHidden();
		await expect(segments).toHaveText(["child of lead · 01a152a0"], LIVE_TIMEOUT);
		const running = await page.evaluate(async () => (await (await fetch("/api/active-sessions")).json()).sessions.filter((s) => s.isRunning).map((s) => s.id));
		expect(running).toEqual([LEAD]);
	} finally {
		if (worker && worker.writer.exitCode === null && worker.writer.signalCode === null) worker.writer.kill("SIGKILL");
		if (server) {
			server.kill("SIGTERM");
			await exited(server);
		}
		await rm(env.root, { recursive: true, force: true });
	}
});

test("a child in one tool call for a minute shows the tool and its minutes in the line, the command in the details; under a minute, nothing", async ({ page }, testInfo) => {
	const phone = testInfo.project.name.includes("iphone");
	const env = await setup();
	const now = Date.now();
	// both live (this process, heartbeats ahead of the clock): api has been in one bash call for just over 3 minutes, web in one for 10s
	const live = (id, name, fork, startedAt, call) =>
		presence(id, { name, parent: LEAD, cwd: join(env.root, "repo", ".forks", String(fork)), pid: process.pid, activity: "busy", startedAt, call });
	const api = live(API, "api", 4, now - 240_000, { id: "toolu_api", name: "bash", preview: E2E_COMMAND, since: now - 185_000 });
	await writePresence(env.root, api);
	await writePresence(env.root, live(WEB, "web", 5, now - 20_000, { id: "toolu_web", name: "bash", preview: "bun test", since: now - 10_000 }));
	let server = null;
	try {
		server = await startServer(env.root, env.port);
		await page.goto(`${env.base}/?ui=phone`);
		await resumeLead(page, env.leadPath);
		await page.reload();
		if (phone) await page.locator("#kb-menu").click();
		await page.locator(`.si[data-session-id="${LEAD}"]`).click();

		const lineEl = page.locator("#lineage-line");
		const segments = lineEl.locator(".lin-seg");
		await expect(segments).toHaveText(["4 children: api bash 3m · flaky died · web · scout ended", LEAD_RELAY], LIVE_TIMEOUT);
		await expect(lineEl.locator(".lin-call")).toHaveText(["bash 3m"]);
		const where = (fork) => `pi -p · .*/repo/\\.forks/${fork}`;
		await expect(lineEl.locator("span.lin-party").first()).toHaveAttribute(
			"title",
			new RegExp(`^api · ${API} · live · bash: ${escapeRegExp(E2E_COMMAND)} · 3m · ${where(4)} · pi-web can't open it$`),
		);
		expect((await page.locator(".app-header").boundingBox())?.height).toBe(40);

		// the details: the command and its minutes in api's row, nothing more in web's
		await segments.nth(1).click();
		const menu = page.locator("#menu-panel");
		await expect(menu.locator(".menu-item .primary")).toHaveText(["api · 01a152d4", "flaky · 01a152d4", "web · 01a152d4", "scout · 01a152d4", "1 reset of the context so far", "loop on"]);
		const secondary = menu.locator(".menu-item .secondary");
		await expect(secondary.nth(0)).toHaveText(new RegExp(`^live · bash: ${escapeRegExp(E2E_COMMAND)} · 3m · ${where(4)} · pi-web can't open it$`));
		await expect(secondary.nth(2)).toHaveText(new RegExp(`^live · ${where(5)} · pi-web can't open it$`));
		// the row holds the whole command, which CSS cuts short; the minutes after it stay whole and in view
		const row = secondary.nth(0);
		await expect(row.locator(".lin-preview")).toHaveText(E2E_COMMAND);
		await expect(row.locator(".lin-minutes")).toHaveText("· 3m");
		expect(await row.locator(".lin-preview").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
		const minutesInView = await row.locator(".lin-minutes").evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= (el.parentElement?.getBoundingClientRect().right ?? 0));
		expect(minutesInView).toBe(true);
		await shoot(page, testInfo, "lineage-running-call");
		await menu.locator(".menu-mini").click();
		await expect(page.locator("#menu-overlay")).not.toHaveClass(/\bopen\b/);

		// its run settles: msg rewrites the record without the call, and the line follows
		const { call: _settled, ...idle } = api;
		await writePresence(env.root, { ...idle, activity: "idle" });
		await expect(segments).toHaveText(["4 children: api · flaky died · web · scout ended", LEAD_RELAY], LIVE_TIMEOUT);
		await expect(lineEl.locator(".lin-call")).toHaveCount(0);
	} finally {
		if (server) {
			server.kill("SIGTERM");
			await exited(server);
		}
		await rm(env.root, { recursive: true, force: true });
	}
});

test("a canvas tile's pill shows them too, live, and a child's link opens it in a tile of its own", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the canvas is laptop chrome only");
	const env = await setup();
	const tile = (id) => page.locator(`.cv-tile[data-tile-id="${id}"]`);
	let server = null;
	let worker = null;
	try {
		server = await startServer(env.root, env.port);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`${env.base}/?ui=phone`);
		await resumeLead(page, env.leadPath);
		await page.goto(`${env.base}/?ui=canvas`);
		await expect(page.locator(".cv-tile")).toHaveCount(1);

		const pill = tile(LEAD).locator(".cv-lineage");
		await expect(pill.locator(".lin-seg")).toHaveText(["2 children: flaky died · scout ended", LEAD_RELAY], LIVE_TIMEOUT);
		worker = await startWorker(env);
		await expect(pill.locator(".lin-seg")).toHaveText(["3 children: flaky died · worker · scout ended", LEAD_RELAY], LIVE_TIMEOUT);
		await shoot(page, testInfo, "lineage-canvas");

		// a narrow tile cuts the children short: a click off the links shows them all, and a row opens one
		await pill.locator(".lin-seg-relay").click();
		await expect(page.locator("#menu-panel .menu-item.is-wrap .secondary")).toHaveText(`goal: ${GOAL}`);
		await page.locator(`#menu-panel .menu-item[data-session-id="${WORKER}"]`).click();
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		await expect(tile(WORKER).locator(".user-msg")).toHaveText("build the pill");
		await expect(tile(WORKER).locator(".cv-lineage .lin-seg")).toHaveText(["child of lead · 01a152a0"], LIVE_TIMEOUT);
		// a sub: read-only, and its pill says another pi still runs it
		await expect(tile(WORKER).locator(".cv-pill")).toHaveText("read-only · running");
		await expect(tile(WORKER).locator(".read-only-note")).toHaveText("Read-only: lead manages this sub · Esc stops it");
		await expect(tile(WORKER).locator(".editor-wrap")).toBeHidden();
		// the lead's tile is already on the canvas: its link brings it into view instead of opening another
		await tile(WORKER).locator(`.cv-lineage a.lin-party[data-session-id="${LEAD}"]`).click();
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		await expect(tile(LEAD)).toHaveClass(/cv-focused/);
	} finally {
		if (worker && worker.writer.exitCode === null && worker.writer.signalCode === null) worker.writer.kill("SIGKILL");
		if (server) {
			server.kill("SIGTERM");
			await exited(server);
		}
		await rm(env.root, { recursive: true, force: true });
	}
});
