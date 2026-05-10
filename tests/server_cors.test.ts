import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDirs: string[] = [];
const procs: Bun.Subprocess[] = [];

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	return port;
}

async function waitForHealth(baseUrl: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/health`);
			if (res.ok) return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("server did not become healthy");
}

async function startServer() {
	const tempRoot = await realpath(tmpdir());
	const dir = await mkdtemp(join(tempRoot, "pi-web-server-cors-"));
	tempDirs.push(dir);
	const port = await freePort();
	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PI_WEB_HOME: dir,
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_PORT: String(port),
			PI_WEB_PUBLIC_ORIGIN: "http://allowed.example",
		},
	});
	procs.push(proc);
	const baseUrl = `http://127.0.0.1:${String(port)}`;
	await waitForHealth(baseUrl);
	return { baseUrl };
}

afterEach(async () => {
	while (procs.length > 0) {
		const proc = procs.pop();
		if (!proc) continue;
		proc.kill();
		await proc.exited.catch(() => undefined);
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		await rm(dir, { recursive: true, force: true });
	}
});

describe("server cors", () => {
	test("allows exact configured origins", async () => {
		const { baseUrl } = await startServer();
		const preflight = await fetch(`${baseUrl}/api/client`, {
			method: "OPTIONS",
			headers: {
				origin: "http://allowed.example",
				"access-control-request-method": "POST",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("http://allowed.example");
		expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");

		const hosts = await fetch(`${baseUrl}/api/hosts`, {
			headers: { origin: "http://allowed.example" },
		});
		expect(hosts.status).toBe(200);
		expect(hosts.headers.get("access-control-allow-origin")).toBe("http://allowed.example");
	});

	test("rejects disallowed preflight origins", async () => {
		const { baseUrl } = await startServer();
		const preflight = await fetch(`${baseUrl}/api/client`, {
			method: "OPTIONS",
			headers: {
				origin: "http://evil.example",
				"access-control-request-method": "POST",
			},
		});
		expect(preflight.status).toBe(403);
		expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
	});
});
