import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "./support/sandbox_env.js";

const tempDirs: string[] = [];
const procs: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const proc of procs.splice(0)) {
		proc.kill();
		await proc.exited.catch(() => undefined);
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

async function startServer(home: string, port: number): Promise<Bun.Subprocess> {
	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdout: "pipe",
		stderr: "pipe",
		env: { ...sandboxServerEnv(home, { PI_WEB_PORT: String(port) }), PI_WEB_HOME: home },
	});
	procs.push(proc);
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`http://127.0.0.1:${String(port)}/health`)).ok) return proc;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("server did not become healthy");
}

async function stopServer(proc: Bun.Subprocess): Promise<void> {
	proc.kill();
	await proc.exited;
	procs.splice(procs.indexOf(proc), 1);
}

describe("server auth", () => {
	test("browser sessions survive a server restart", async () => {
		const home = await mkdtemp(join(await realpath(tmpdir()), "pi-web-auth-"));
		tempDirs.push(home);
		const port = await freePort();
		const url = `http://127.0.0.1:${String(port)}/api/client`;

		const first = await startServer(home, port);
		const created = await fetch(url, { method: "POST" });
		const cookie = created.headers.get("set-cookie")?.split(";")[0] ?? "";
		const { clientId } = (await created.json()) as { clientId: string };
		expect(cookie.startsWith("pi_web_client=")).toBe(true);
		await stopServer(first);

		await startServer(home, port);
		const resumed = (await (await fetch(url, { method: "POST", headers: { cookie } })).json()) as { clientId: string };
		expect(resumed.clientId).toBe(clientId);

		const forged = (await (await fetch(url, { method: "POST", headers: { cookie: `${cookie}x` } })).json()) as { clientId: string };
		expect(forged.clientId).not.toBe(clientId);
	});
});
