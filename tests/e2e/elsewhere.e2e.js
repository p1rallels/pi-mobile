import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

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

const line = (value) => `${JSON.stringify(value)}\n`;
const now = () => new Date().toISOString();

function userEntry(id, parentId, text) {
	return line({ type: "message", id, parentId, timestamp: now(), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
}

function assistantEntry(id, parentId, stopReason, content) {
	return line({ type: "message", id, parentId, timestamp: now(), message: { role: "assistant", content, api: "faux", provider: "faux", model: "faux-1", usage, stopReason, timestamp: Date.now() } });
}

function toolResultEntry(id, parentId, callId, text) {
	return line({ type: "message", id, parentId, timestamp: now(), message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: Date.now() } });
}

async function writeSession(root, cwd, id, body) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-15T10-00-00-000Z_${id}.jsonl`);
	await writeFile(path, line({ type: "session", version: 3, id, timestamp: now(), cwd }) + body);
	return path;
}

/** `ps` lists it as pi, like pi's own process.title, and it leads its own process group like a pfs run. */
function spawnFakePi(cwd) {
	return spawn("node", ["-e", 'process.title = "pi"; setInterval(() => {}, 1000);'], { cwd, stdio: "ignore", detached: true });
}

function exited(proc) {
	return proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((resolve) => proc.once("exit", resolve));
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

async function openSidebar(page, testInfo) {
	if (testInfo.project.name.includes("iphone")) await page.locator("#kb-menu").click();
}

async function pressEsc(page, testInfo) {
	if (testInfo.project.name.includes("iphone")) {
		await page.locator("#kb-esc").click();
	} else {
		await page.keyboard.press("Escape");
	}
}

test("follows a session another pi is writing, stops it with Esc and continues it here", async ({ page }, testInfo) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-e2e-elsewhere-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	const writer = spawnFakePi(cwd);
	const sessionId = "01a13c00-0000-7000-8000-0000000000f1";
	let server = null;
	try {
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "for i in 1 2 3; do echo $i; sleep 1; done" } };
		const path = await writeSession(root, cwd, sessionId, userEntry("u1", null, "count slowly") + assistantEntry("a1", "u1", "toolUse", [call]));
		const port = await freePort();
		server = await startServer(root, port);

		await page.goto(`http://127.0.0.1:${port}`);
		await openSidebar(page, testInfo);
		const row = page.locator(`.si[data-session-id="${sessionId}"]`);
		await expect(row.locator(".si-elsewhere")).toHaveText("running elsewhere");
		await row.click();

		await expect(page.locator(".user-msg")).toHaveText(["count slowly"]);
		await expect(page.locator("#role-pill")).toHaveText("elsewhere");
		await expect(page.locator("#inp")).toBeDisabled();
		await expect(page.locator("#inp")).toHaveAttribute("placeholder", /Esc stops it/);
		await expect(page.locator("#footer-line-1")).toContainText(`running elsewhere (pi ${writer.pid})`);

		await appendFile(path, toolResultEntry("t1", "a1", "call-1", "1\n2\n3"));
		await expect(page.locator(".tool-box")).toContainText("1\n2\n3");

		await pressEsc(page, testInfo);
		await exited(writer);
		await expect(page.locator(".notice-text").last()).toContainText(`Stopped pi (pid ${writer.pid})`);
		await expect(page.locator("#role-pill")).toHaveText("stopped");
		await expect(page.locator("#inp")).toBeEnabled();

		await page.locator(testInfo.project.name.includes("iphone") ? "#kb-takeover" : "#btn-takeover").click();
		await expect(page.locator("#role-pill")).toHaveText("controller");
		await expect(page.locator(".user-msg")).toHaveText(["count slowly"]);
		await expect(page.locator(".tool-box")).toHaveCount(1);
	} finally {
		if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
		if (server) {
			server.kill("SIGTERM");
			await exited(server);
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("a followed session unlocks when its turn closes", async ({ page }, testInfo) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-e2e-elsewhere-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	const writer = spawnFakePi(cwd);
	const sessionId = "01a13c00-0000-7000-8000-0000000000f2";
	let server = null;
	try {
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const path = await writeSession(root, cwd, sessionId, userEntry("u1", null, "think about it"));
		const port = await freePort();
		server = await startServer(root, port);

		await page.goto(`http://127.0.0.1:${port}`);
		await openSidebar(page, testInfo);
		await page.locator(`.si[data-session-id="${sessionId}"]`).click();
		await expect(page.locator("#role-pill")).toHaveText("elsewhere");
		await expect(page.locator("#inp")).toBeDisabled();

		await appendFile(path, assistantEntry("a1", "u1", "stop", [{ type: "text", text: "thought about it" }]));
		await expect(page.locator(".assistant-block .md")).toHaveText(["thought about it"]);
		await expect(page.locator("#role-pill")).toHaveText("finished");
		await expect(page.locator("#inp")).toBeEnabled();
		await expect(page.locator("#inp")).toHaveAttribute("placeholder", /Finished elsewhere/);
		expect(writer.exitCode).toBeNull();
	} finally {
		writer.kill("SIGKILL");
		if (server) {
			server.kill("SIGTERM");
			await exited(server);
		}
		await rm(root, { recursive: true, force: true });
	}
});
