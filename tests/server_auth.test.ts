import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCookieSigner } from "../src/signed-cookies.ts";
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

	test("face id status says how long ago this browser passed a check, and only for its own check", async () => {
		const home = await mkdtemp(join(await realpath(tmpdir()), "pi-web-auth-"));
		tempDirs.push(home);
		const port = await freePort();
		const base = `http://127.0.0.1:${String(port)}`;
		await startServer(home, port);

		const created = await fetch(`${base}/api/client`, { method: "POST" });
		const clientCookie = created.headers.get("set-cookie")?.split(";")[0] ?? "";
		const { clientId } = (await created.json()) as { clientId: string };
		const signer = createCookieSigner(await readFile(join(home, "cookie-key")));
		const checkCookie = (forClient: string, secondsAgo: number): string => {
			const verifiedAt = Date.now() - secondsAgo * 1000;
			const token = signer.sign({ kind: "faceid", clientId: forClient, rpId: "127.0.0.1", verifiedAt, exp: verifiedAt + 3_600_000, jti: crypto.randomUUID(), dev: null });
			return `pi_web_faceid=${token}`;
		};
		const status = async (cookie: string) =>
			(await (await fetch(`${base}/api/faceid/status`, { headers: { cookie } })).json()) as { freshForSeconds: number; verifiedSecondsAgo: number | null };

		const mine = await status(`${clientCookie}; ${checkCookie(clientId, 125)}`);
		expect(mine.freshForSeconds).toBe(15 * 60);
		expect(mine.verifiedSecondsAgo).toBeGreaterThanOrEqual(125);
		expect(mine.verifiedSecondsAgo).toBeLessThanOrEqual(127);
		expect((await status(`${clientCookie}; ${checkCookie("another-browser", 5)}`)).verifiedSecondsAgo).toBeNull();
		expect((await status(clientCookie)).verifiedSecondsAgo).toBeNull();
	});
});
