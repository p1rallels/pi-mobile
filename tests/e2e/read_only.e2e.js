// Subs open read-only and parents with live subs stay loaded (src/msg-subs.ts), through real servers in a sandbox with
// their own msg store (presence records in <root>/agent/msg/sessions, written the way msg writes them). A sub opened from
// its parent's lineage line has no composer and no take over; Esc stops the pi running it, and it stays read-only. A
// session whose folder is gone opens the same way, from a msg sender's link, on the canvas and through the api. An idle
// parent stays loaded while its sub counts and goes once the sub ended; after a restart, one whose sub counts is back.
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

const LEAD = "01a155b1-0000-7000-8000-00000000000a";
const WORKER = "01a155b1-0000-7000-8000-00000000000b";
const GONE = "01a155b1-0000-7000-8000-00000000000c";
const OTHER = "01a155b1-0000-7000-8000-00000000000d";
const SUB = "01a155b1-0000-7000-8000-00000000000e";
const LATER_SUB = "01a155b1-0000-7000-8000-00000000000f";
// above any pid macOS hands out (99998) and rarely reached on linux, so kill(pid, 0) says it's gone
const DEAD_PID = 999_999;
const LIVE_TIMEOUT = { timeout: 10_000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const text = (value) => [{ type: "text", text: value }];
const line = (value) => `${JSON.stringify(value)}\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Entries in pi's file format, chained root to leaf, a second apart from `start`. */
function chain(rows, start, prefix = "e") {
	return rows.map((row, index) => {
		const id = `${prefix}${String(index + 1).padStart(7, "0")}`;
		const at = start + index * 1000;
		const parentId = index === 0 ? null : `${prefix}${String(index).padStart(7, "0")}`;
		const timestamp = new Date(at).toISOString();
		if (row.type === "message") return { ...row, id, parentId, timestamp, message: { ...row.message, timestamp: at } };
		return { ...row, id, parentId, timestamp };
	});
}

const user = (value) => ({ type: "message", message: { role: "user", content: text(value) } });
const assistant = (value) => ({ type: "message", message: { role: "assistant", content: text(value), api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "stop" } });
/** A msg message from `from`, the way msg's extension appends one to the session it lands in. */
const msgFrom = (from, value) => ({
	type: "custom_message",
	customType: "msg",
	content: `<msg id="0mgqk3x2p-a1b2c3" from="${from.name}" session="${from.id}">\n${value}\n</msg>`,
	display: true,
	details: { v: 1, id: "0mgqk3x2p-a1b2c3", ts: Date.now(), from, to: LEAD, text: value },
});

async function writeSession(root, cwd, id, entries) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-19T19-44-17-051Z_${id}.jsonl`);
	await writeFile(path, [{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }, ...entries].map(line).join(""));
	return path;
}

/** A presence record the way msg writes one: to a temp file, renamed into place (which is what moves the folder's mtime). */
async function writePresence(root, record) {
	const dir = join(root, "agent", "msg", "sessions");
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `.${record.id}.${process.pid}.tmp`);
	await writeFile(temp, JSON.stringify({ v: 1, mode: "print", activity: "busy", startedAt: Date.now() - 60_000, ...record }));
	await rename(temp, join(dir, `${record.id}.json`));
}

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

/** A sandboxed server whose log lines the test can wait for. */
async function startServer(root, port, env = {}) {
	const proc = spawn(process.env.BUN_BINARY || "bun", ["src/server.ts"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: sandboxServerEnv(root, { PI_WEB_PORT: String(port), ...env }),
	});
	const lines = [];
	for (const stream of [proc.stdout, proc.stderr]) {
		let partial = "";
		stream.on("data", (chunk) => {
			const parts = (partial + chunk.toString()).split("\n");
			partial = parts.pop() ?? "";
			lines.push(...parts);
		});
	}
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			if ((await fetch(`${base}/health`)).ok) break;
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) {
			proc.kill();
			throw new Error(`server did not become healthy:\n${lines.join("\n")}`);
		}
		await sleep(100);
	}
	const logged = async (wanted) => {
		try {
			await expect.poll(() => lines.includes(wanted), { timeout: 15_000 }).toBe(true);
		} catch (error) {
			throw new Error(`the server never logged "${wanted}", only:\n${lines.join("\n")}`, { cause: error });
		}
	};
	return { proc, base, lines, logged };
}

async function stopServer(proc) {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	const done = exited(proc);
	proc.kill("SIGTERM");
	await done;
}

/** The api as a browser session sees it: a client cookie, sessions resumed from their files. */
async function connect(base) {
	const client = await fetch(`${base}/api/client`, { method: "POST" });
	const { clientId } = await client.json();
	const headers = { cookie: client.headers.get("set-cookie")?.split(";")[0] ?? "", "content-type": "application/json" };
	return {
		/** POST /api/sessions resuming a file: the status and the body. */
		async resume(resumeSessionPath) {
			const res = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ clientId, resumeSessionPath }) });
			return { status: res.status, body: await res.json() };
		},
		/** GET a session's state by id and path, which attaches a session pi-web disposed. */
		async state(id, path) {
			const res = await fetch(`${base}/api/sessions/${id}/state?${new URLSearchParams({ path })}`, { headers });
			return { status: res.status, body: await res.json() };
		},
		async running() {
			const { sessions } = await (await fetch(`${base}/api/active-sessions`, { headers })).json();
			return sessions.filter((session) => session.isRunning).map((session) => session.id);
		},
		async health() {
			return (await fetch(`${base}/health`)).json();
		},
	};
}

async function shoot(page, testInfo, name) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: false });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Opens the lead, which the host runs, from the phone shell's sidebar. */
async function openLead(page, phone) {
	if (phone) await page.locator("#kb-menu").click();
	await page.locator(`.si[data-session-id="${LEAD}"]`).click();
}

test("a sub opens read-only from its parent's line: no composer, no take over, Esc while a pi runs it, read-only after", async ({ page }, testInfo) => {
	const phone = testInfo.project.name.includes("iphone");
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-read-only-e2e-"));
	const repo = join(root, "repo");
	const fork = join(repo, ".forks", "1");
	await mkdir(fork, { recursive: true });
	const leadPath = await writeSession(root, repo, LEAD, chain([user("fan out the pill work"), assistant("the worker is on it")], Date.now() - 120_000));
	const writer = spawnFakePi(fork);
	let server = null;
	try {
		// the writer must have started before the file's last write to count as its writer
		await sleep(1_200);
		const workerPath = await writeSession(root, fork, WORKER, chain([user("build the pill")], Date.now(), "w"));
		await writePresence(root, { id: LEAD, name: "lead", cwd: repo, pid: process.pid, mode: "web", activity: "idle", heartbeatAt: Date.now() + 10 * 60_000 });
		await writePresence(root, { id: WORKER, name: "worker", parent: LEAD, cwd: fork, pid: writer.pid, heartbeatAt: Date.now() + 10 * 60_000 });
		server = await startServer(root, await freePort());
		const api = await connect(server.base);
		expect((await api.resume(leadPath)).status).toBe(200);

		await page.goto(`${server.base}/?ui=phone`);
		await openLead(page, phone);
		const lineEl = page.locator("#lineage-line");
		await expect(lineEl.locator(".lin-seg")).toHaveText(["1 child: worker"], LIVE_TIMEOUT);
		if (phone) {
			await lineEl.locator(".lin-seg").first().click({ position: { x: 3, y: 20 } });
			await expect(page.locator(`#menu-panel .menu-item[data-session-id="${WORKER}"] .secondary`)).toContainText("opens read-only");
			await page.locator(`#menu-panel .menu-item[data-session-id="${WORKER}"]`).click();
			await expect(page.locator("#menu-overlay")).not.toHaveClass(/\bopen\b/);
		} else {
			const link = lineEl.locator(`a.lin-party[data-session-id="${WORKER}"]`);
			await expect(link).toHaveAttribute("title", /click to open read-only$/);
			await link.click();
		}

		await expect(page.locator(".user-msg")).toHaveText(["build the pill"]);
		await expect(page.locator("#role-pill")).toHaveText("read-only");
		await expect(page.locator("#read-only-note")).toHaveText("Read-only: lead manages this sub · Esc stops it");
		await expect(page.locator("#editor-wrap")).toBeHidden();
		await expect(page.locator("#footer-line-1")).toContainText(`running elsewhere (pi ${writer.pid})`);
		const esc = page.locator(phone ? "#kb-esc" : "#btn-abort");
		await expect(esc).toBeVisible();
		await expect(esc).toBeEnabled();
		for (const id of phone ? ["#kb-takeover", "#kb-release", "#kb-enter"] : ["#btn-takeover", "#btn-release"]) await expect(page.locator(id)).toBeHidden();
		await shoot(page, testInfo, "read-only-sub-running");

		// Esc stops the pi running it; with nobody writing it, it's still a sub: no typing, no take over
		if (phone) await esc.click();
		else await page.keyboard.press("Escape");
		await exited(writer);
		await expect(page.locator(".notice-text").last()).toHaveText(`Stopped pi (pid ${writer.pid}).`);
		await expect(page.locator("#role-pill")).toHaveText("read-only");
		await expect(page.locator("#read-only-note")).toHaveText("Read-only: lead manages this sub");
		await expect(esc).toBeHidden();
		await expect(page.locator("#editor-wrap")).toBeHidden();
		for (const id of phone ? ["#kb-takeover", "#kb-enter"] : ["#btn-takeover"]) await expect(page.locator(id)).toBeHidden();
		await shoot(page, testInfo, "read-only-sub-stopped");

		// pi-web never loaded it, and a resume through the api is refused with the reason
		expect(await api.running()).toEqual([LEAD]);
		const refused = await api.resume(workerPath);
		expect(refused.status).toBe(409);
		expect(refused.body.readOnly).toEqual({ reason: "sub", parent: LEAD });
	} finally {
		if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
		if (server) await stopServer(server.proc);
		await rm(root, { recursive: true, force: true });
	}
});

/**
 * An isolated host: the lead, whose transcript holds a message from a session whose folder is gone (pfs removed its
 * fork), and that session's file.
 */
async function goneSetup() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-read-only-e2e-"));
	const repo = join(root, "repo");
	const gone = join(repo, ".forks", "4");
	await mkdir(gone, { recursive: true });
	const start = Date.now() - 120_000;
	const leadPath = await writeSession(root, repo, LEAD, chain([user("what did the old fork find?"), msgFrom({ id: GONE, name: "old-fork", cwd: gone }, "notes from the old fork")], start));
	const gonePath = await writeSession(root, gone, GONE, chain([user("take notes"), assistant("what the old fork said")], start, "g"));
	await rm(gone, { recursive: true, force: true });
	return { root, leadPath, gonePath };
}

test("a session whose folder is gone opens read-only from a msg sender's link, and the api refuses to load it", async ({ page }, testInfo) => {
	const phone = testInfo.project.name.includes("iphone");
	const { root, leadPath, gonePath } = await goneSetup();
	let server = null;
	try {
		server = await startServer(root, await freePort());
		const api = await connect(server.base);
		expect((await api.resume(leadPath)).status).toBe(200);
		await page.goto(`${server.base}/?ui=phone`);
		await openLead(page, phone);
		await expect(page.locator(".msg-card .msg-body")).toHaveText("notes from the old fork");
		await page.locator(".msg-card .msg-from").click();

		await expect(page.locator(".assistant-block .md")).toHaveText(["what the old fork said"]);
		await expect(page.locator("#role-pill")).toHaveText("read-only");
		await expect(page.locator("#read-only-note")).toHaveText("Read-only: its folder is gone");
		await expect(page.locator("#editor-wrap")).toBeHidden();
		// nobody runs it: no Esc either
		await expect(page.locator(phone ? "#kb-esc" : "#btn-abort")).toBeHidden();
		await shoot(page, testInfo, "read-only-folder-gone");

		expect(await api.running()).toEqual([LEAD]);
		const refused = await api.resume(gonePath);
		expect(refused.status).toBe(409);
		expect(refused.body.readOnly).toEqual({ reason: "folder" });
		const attach = await api.state(GONE, gonePath);
		expect(attach.status).toBe(409);
		expect(attach.body.readOnly).toEqual({ reason: "folder" });
	} finally {
		if (server) await stopServer(server.proc);
		await rm(root, { recursive: true, force: true });
	}
});

test("on the canvas it gets a read-only tile, and after a reload its dormant tile opens it read-only, never resumes it", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the canvas is laptop chrome only");
	const { root, leadPath } = await goneSetup();
	const tile = (id) => page.locator(`.cv-tile[data-tile-id="${id}"]`);
	let server = null;
	try {
		server = await startServer(root, await freePort());
		const api = await connect(server.base);
		expect((await api.resume(leadPath)).status).toBe(200);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`${server.base}/?ui=canvas`);
		await expect(page.locator(".cv-tile")).toHaveCount(1);
		await tile(LEAD).locator(".msg-card .msg-from").click();
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		await expect(tile(GONE).locator(".assistant-block .md")).toHaveText("what the old fork said");
		await expect(tile(GONE).locator(".cv-pill")).toHaveText("read-only");
		await expect(tile(GONE).locator(".read-only-note")).toHaveText("Read-only: its folder is gone");
		await expect(tile(GONE).locator(".editor-wrap")).toBeHidden();

		// a reload: the tile comes back dormant, learns from the file read that it opens read-only, and offers no resume
		await page.reload();
		await expect(page.locator(".cv-tile")).toHaveCount(2);
		await page.evaluate((id) => window.__canvas.canvas.revealTile(id), GONE);
		await expect(tile(GONE).locator(".cv-pill")).toHaveText("read-only · click to open", LIVE_TIMEOUT);
		await expect(tile(GONE).locator(".assistant-block .md")).toHaveText("what the old fork said");
		await tile(GONE).locator(".cv-ctl-more").click();
		await expect(page.locator("#menu-panel .menu-item .primary")).toHaveText(["Open", "Remove from canvas"]);
		await page.locator("#menu-panel .menu-item", { hasText: "Open" }).click();
		await expect(tile(GONE).locator(".cv-pill")).toHaveText("read-only", LIVE_TIMEOUT);
		await expect(tile(GONE).locator(".read-only-note")).toHaveText("Read-only: its folder is gone");
		await expect(tile(GONE).locator(".editor-wrap")).toBeHidden();
		await shoot(page, testInfo, "read-only-canvas");
		expect(await api.running()).toEqual([LEAD]);
	} finally {
		if (server) await stopServer(server.proc);
		await rm(root, { recursive: true, force: true });
	}
});

test("an idle parent stays loaded while its sub counts and goes once it ended; after a restart, one whose sub counts is back", async ({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the host's behavior, the same in every browser");
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-read-only-e2e-"));
	const repo = join(root, "repo");
	const fork = join(repo, ".forks", "1");
	await mkdir(fork, { recursive: true });
	const start = Date.now() - 120_000;
	const leadPath = await writeSession(root, repo, LEAD, chain([user("start a worker"), assistant("started; waiting for it")], start));
	const otherPath = await writeSession(root, repo, OTHER, chain([user("nothing to wait on"), assistant("done")], start, "o"));
	// msg never ran in the lead (no record of its own): only its sub's record names it
	const sub = { id: SUB, name: "worker", parent: LEAD, cwd: fork, pid: DEAD_PID, heartbeatAt: Date.now() + 10 * 60_000 };
	await writePresence(root, sub);
	// unwatched sessions idle for 3 seconds go, a sweep every 750ms
	const env = { PI_WEB_IDLE_SESSION_MINUTES: "0.05" };
	let server = await startServer(root, await freePort(), env);
	try {
		const api = await connect(server.base);
		expect((await api.resume(leadPath)).status).toBe(200);
		expect((await api.resume(otherPath)).status).toBe(200);
		// the other one goes as soon as it idled out; the lead stays while its sub counts
		await server.logged(`[pi-web] disposed idle session ${OTHER}`);
		await sleep(3_000);
		expect(await api.running()).toEqual([LEAD]);
		expect(await api.health()).toMatchObject({ runningSessions: 1, waitingSessions: 1, viewers: 0 });

		await writePresence(root, { ...sub, activity: "idle", endedAt: Date.now() });
		await server.logged(`[pi-web] disposed idle session ${LEAD}`);
		expect(await api.running()).toEqual([]);

		// a restart: a sub that counts brings the lead back at the start, with nobody watching; the other stays down
		await stopServer(server.proc);
		await writePresence(root, { id: LATER_SUB, name: "fixer", parent: LEAD, cwd: fork, pid: DEAD_PID, heartbeatAt: Date.now() + 10 * 60_000 });
		server = await startServer(root, server.base.split(":").at(-1), env);
		await server.logged(`[pi-web] reopened ${LEAD} for its subs`);
		const again = await connect(server.base);
		expect(await again.running()).toEqual([LEAD]);
		expect(await again.health()).toMatchObject({ runningSessions: 1, waitingSessions: 1, viewers: 0 });
		await sleep(3_000);
		expect(await again.running()).toEqual([LEAD]);
	} finally {
		await stopServer(server.proc);
		await rm(root, { recursive: true, force: true });
	}
});
