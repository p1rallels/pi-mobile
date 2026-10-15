import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sandboxServerEnv, scrubbedEnv } from "../support/sandbox_env.js";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const FAUX_EXTENSION = resolve("tests/support/faux_pi_extension.ts");

function freePort() {
	return new Promise((done, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => done(port));
		});
	});
}

function exited(proc) {
	return proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve(proc.exitCode) : new Promise((done) => proc.once("exit", (code) => done(code)));
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
			await new Promise((done) => setTimeout(done, 100));
		}
	}
	proc.kill();
	throw new Error("server did not become healthy");
}

/** A real `pi -p` on a scripted model: one bash call counting for `seconds`, then an answer. Its own process group, like a pfs run. */
function startPi(root, cwd, seconds) {
	return spawn(
		"node",
		[PI_CLI, "-p", "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "-e", FAUX_EXTENSION, "--provider", "pi-web-faux", "--model", "faux-slow", "count slowly"],
		{ cwd, stdio: "ignore", detached: true, env: { ...scrubbedEnv(), PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_FAUX_SECONDS: String(seconds) } },
	);
}

/** The session file once pi has written the bash call to it. */
async function waitForToolCall(root) {
	const sessions = join(root, "agent", "sessions");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		for (const dir of await readdir(sessions).catch(() => [])) {
			for (const name of await readdir(join(sessions, dir)).catch(() => [])) {
				const path = join(sessions, dir, name);
				const text = await readFile(path, "utf8");
				if (text.includes('"stopReason":"toolUse"')) return { path, id: JSON.parse(text.split("\n")[0]).id };
			}
		}
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error("pi never wrote its tool call");
}

async function setup(seconds) {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-e2e-real-pi-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	await mkdir(join(root, "agent"), { recursive: true });
	await writeFile(join(root, "agent", "settings.json"), "{}");
	const port = await freePort();
	const server = await startServer(root, port);
	const pi = startPi(root, cwd, seconds);
	const session = await waitForToolCall(root);
	return { root, port, server, pi, session };
}

async function teardown({ root, server, pi }) {
	if (pi.exitCode === null && pi.signalCode === null) process.kill(-pi.pid, "SIGKILL");
	server.kill("SIGTERM");
	await exited(server);
	await rm(root, { recursive: true, force: true });
}

const phone = (testInfo) => testInfo.project.name.includes("iphone");

test("a real pi -p shows as running elsewhere; Esc stops it and take over continues it here", async ({ page }, testInfo) => {
	const env = await setup(60);
	try {
		await page.goto(`http://127.0.0.1:${env.port}`);
		if (phone(testInfo)) await page.locator("#kb-menu").click();
		const row = page.locator(`.si[data-session-id="${env.session.id}"]`);
		await expect(row.locator(".si-elsewhere")).toHaveText("running elsewhere");
		await row.click();

		await expect(page.locator(".user-msg")).toHaveText(["count slowly"]);
		await expect(page.locator("#role-pill")).toHaveText("elsewhere");
		await expect(page.locator(".tool-box")).toContainText("seq 1 60");
		await expect(page.locator("#inp")).toBeDisabled();

		if (phone(testInfo)) {
			await page.locator("#kb-esc").click();
		} else {
			await page.keyboard.press("Escape");
		}
		expect(await exited(env.pi)).not.toBe(0);
		await expect(page.locator(".notice-text").last()).toContainText(`Stopped pi (pid ${env.pi.pid})`);
		await expect(page.locator("#role-pill")).toHaveText("stopped");
		await expect(page.locator(".tool-box.error")).toContainText("Stopped: the pi running it is gone");

		await page.locator(phone(testInfo) ? "#kb-takeover" : "#btn-takeover").click();
		await expect(page.locator("#role-pill")).toHaveText("controller");
		await expect(page.locator(".user-msg")).toHaveText(["count slowly"]);
	} finally {
		await teardown(env);
	}
});

test("a real pi -p that finishes unlocks the view with its answer", async ({ page }, testInfo) => {
	const env = await setup(4);
	try {
		await page.goto(`http://127.0.0.1:${env.port}`);
		if (phone(testInfo)) await page.locator("#kb-menu").click();
		await page.locator(`.si[data-session-id="${env.session.id}"]`).click();
		await expect(page.locator("#role-pill")).toHaveText("elsewhere");

		await expect(page.locator(".tool-box")).toContainText("count 4", { timeout: 15_000 });
		await expect(page.locator(".assistant-block .md").last()).toHaveText("counted to 4");
		await expect(page.locator("#role-pill")).toHaveText("finished");
		await expect(page.locator("#inp")).toBeEnabled();
		expect(await exited(env.pi)).toBe(0);
	} finally {
		await teardown(env);
	}
});
