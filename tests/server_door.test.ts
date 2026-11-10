import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveDeviceRegistry } from "../src/device-registry.ts";
import { cameThroughProxy, parseRequestUrl } from "../src/request-url.ts";
import { sandboxServerEnv } from "./support/sandbox_env.js";

// The door: a host spelled with a trailing dot is a bad request, and a request a proxy handed on is never a local one.

describe("parseRequestUrl and the trailing dot", () => {
	test("refuses a host that ends in a dot, however the dot is spelled", () => {
		for (const host of ["pi.example.test.", "localhost.", "pi.example.test.:8443", "localhost.:4317", "pi.example.test%2E", "pi.example.test\u3002", "a.."]) {
			expect(parseRequestUrl(`http://${host}/api/repos`)).toBeNull();
		}
	});

	test("takes the undotted spellings, and a dotted IPv4 address the parser already made canonical", () => {
		expect(parseRequestUrl("http://pi.example.test:8443/api/repos")?.hostname).toBe("pi.example.test");
		expect(parseRequestUrl("http://localhost:4317/")?.hostname).toBe("localhost");
		expect(parseRequestUrl("http://[::1]:4317/")?.hostname).toBe("[::1]");
		expect(parseRequestUrl("http://127.0.0.1.:4317/")?.hostname).toBe("127.0.0.1");
	});
});

describe("cameThroughProxy", () => {
	test("any forwarding header says a proxy handed the request on", () => {
		for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "X-Forwarded-For"]) {
			expect(cameThroughProxy(new Headers({ [name]: "x" }))).toBe(true);
		}
		expect(cameThroughProxy(new Headers({ "x-forwarded-for": "" }))).toBe(true);
	});

	test("no forwarding header, no proxy: a device fingerprint alone is what a local process sends in secure mode", () => {
		expect(cameThroughProxy(new Headers())).toBe(false);
		expect(cameThroughProxy(new Headers({ host: "localhost:4317", "x-pi-web-client-cert-fingerprint": "aa", "cf-connecting-ip": "1.2.3.4" }))).toBe(false);
	});
});

const REMOTE_ORIGIN = "https://pi.example.test:8443";
const CERT_HEADER = "x-pi-web-client-cert-fingerprint";
const DEVICE = "aa".repeat(32);
const VIA_PROXY = { "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https" };

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

/** A server under test on its own port and state root, with a device registry holding DEVICE. */
function serverFixture(env: Record<string, string>) {
	let root = "";
	let proc: Bun.Subprocess | null = null;
	const self = { port: 0 };
	beforeAll(async () => {
		root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-door-"));
		self.port = await freePort();
		const registry = join(root, "devices.json");
		await saveDeviceRegistry(registry, {
			version: 1,
			devices: [
				{
					name: "laptop",
					platform: "macos",
					fingerprintSha256: DEVICE,
					serial: "laptop",
					issuedAt: "2026-01-01T00:00:00.000Z",
					expiresAt: "2099-01-01T00:00:00.000Z",
					revokedAt: null,
				},
			],
		});
		proc = Bun.spawn({
			cmd: [process.execPath, "src/server.ts"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			env: sandboxServerEnv(root, { PI_WEB_PORT: String(self.port), PI_WEB_DEVICE_REGISTRY: registry, PI_WEB_TERMINALS: "off", PI_OFFLINE: "1", ...env }),
		});
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const healthy = await fetch(`http://127.0.0.1:${String(self.port)}/health`, { signal: AbortSignal.timeout(1_000) }).then(
				(res) => res.ok,
				() => false,
			);
			if (healthy) return;
			await Bun.sleep(50);
		}
		throw new Error("server did not become healthy");
	});
	afterAll(async () => {
		proc?.kill();
		await proc?.exited.catch(() => undefined);
		if (root) await rm(root, { recursive: true, force: true });
	});
	return self;
}

interface Call {
	host: string;
	origin: string;
	headers?: Record<string, string>;
	cookie?: string;
	body?: unknown;
}

async function call(port: number, path: string, { host, origin, headers = {}, cookie, body }: Call) {
	const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
		method: body === undefined ? "GET" : "POST",
		redirect: "error",
		signal: AbortSignal.timeout(5_000),
		headers: {
			host,
			origin,
			...headers,
			...(cookie ? { cookie } : {}),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return { status: res.status, text, setCookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

/** What a browser at a host gets: an API route behind the gate, whether it may enroll, and a register challenge. */
async function door(port: number, at: Call) {
	const browser = await call(port, "/api/client", { ...at, body: {} });
	const cookie = browser.setCookie;
	const status = await call(port, "/api/faceid/status", { ...at, cookie });
	return {
		client: browser.status,
		repos: (await call(port, "/api/repos", { ...at, cookie })).status,
		status: status.status,
		canRegister: status.status === 200 ? (JSON.parse(status.text) as { canRegister: boolean }).canRegister : null,
		register: (await call(port, "/api/faceid/challenge", { ...at, cookie, body: { kind: "register" } })).status,
	};
}

describe("secure mode behind the proxy", () => {
	const server = serverFixture({ PI_WEB_TRUST_PROXY: "1", PI_WEB_SECURE_MODE: "1", PI_WEB_ALLOWED_ORIGINS: REMOTE_ORIGIN });
	const device = { [CERT_HEADER]: DEVICE };
	const localhost = () => ({ host: `localhost:${String(server.port)}`, origin: `http://localhost:${String(server.port)}` });

	test("a dotted host is a bad request on an API route and on the Face ID challenge; the undotted one isn't", async () => {
		const port = server.port;
		const remoteHost = `pi.example.test:${String(port)}`;
		const cookie = (await call(port, "/api/client", { host: remoteHost, origin: REMOTE_ORIGIN, headers: { ...device, ...VIA_PROXY }, body: {} })).setCookie;
		expect(cookie).toStartWith("pi_web_client=");
		const at = (host: string, origin: string, headers: Record<string, string>): Call => ({ host, origin, headers: { ...device, ...headers }, cookie });

		for (const dotted of [at(`pi.example.test.:${String(port)}`, REMOTE_ORIGIN, VIA_PROXY), at(`localhost.:${String(port)}`, localhost().origin, {})]) {
			const repos = await call(port, "/api/repos", dotted);
			const challenge = await call(port, "/api/faceid/challenge", { ...dotted, body: { kind: "register" } });
			expect([dotted.host, repos.status, challenge.status]).toEqual([dotted.host, 400, 400]);
		}

		const remote = at(remoteHost, REMOTE_ORIGIN, VIA_PROXY);
		expect((await call(port, "/api/repos", remote)).status).toBe(401);
		expect((await call(port, "/api/faceid/challenge", { ...remote, body: { kind: "register" } })).status).toBe(200);
		const local = at(localhost().host, localhost().origin, {});
		expect((await call(port, "/api/repos", local)).status).toBe(200);
		expect((await call(port, "/api/faceid/challenge", { ...local, body: { kind: "register" } })).status).toBe(200);
	});

	test("a loopback host the proxy handed on gets the Face ID gate and no first-use enrollment", async () => {
		expect(await door(server.port, { ...localhost(), headers: { ...device, ...VIA_PROXY } })).toEqual({
			client: 200,
			repos: 401,
			status: 200,
			canRegister: false,
			register: 403,
		});
		const cookie = (await call(server.port, "/api/client", { ...localhost(), headers: device, body: {} })).setCookie;
		const forwarding = { "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https", "x-forwarded-host": "localhost", forwarded: "for=100.64.0.9" };
		for (const [name, value] of Object.entries(forwarding)) {
			const repos = await call(server.port, "/api/repos", { ...localhost(), headers: { ...device, [name]: value }, cookie });
			expect([name, repos.status]).toEqual([name, 401]);
		}
	});

	test("the same request from a process on this host, no forwarding headers, keeps its skip and its enrollment", async () => {
		const local = await door(server.port, { ...localhost(), headers: device });
		expect(local).toEqual({ client: 200, repos: 200, status: 200, canRegister: true, register: 200 });
	});
});

describe("local mode", () => {
	const server = serverFixture({});
	const localhost = () => ({ host: `localhost:${String(server.port)}`, origin: `http://localhost:${String(server.port)}` });

	test("a local browser skips the gate and may enroll; behind a proxy that says localhost it gets neither", async () => {
		expect(await door(server.port, localhost())).toEqual({ client: 200, repos: 200, status: 200, canRegister: true, register: 200 });
		expect(await door(server.port, { ...localhost(), headers: { "x-forwarded-for": "203.0.113.7" } })).toEqual({
			client: 200,
			repos: 401,
			status: 200,
			canRegister: false,
			register: 403,
		});
	});

	test("a dotted localhost is a bad request", async () => {
		const at = { host: `localhost.:${String(server.port)}`, origin: localhost().origin };
		expect((await call(server.port, "/api/repos", at)).status).toBe(400);
		expect((await call(server.port, "/api/faceid/challenge", { ...at, body: { kind: "register" } })).status).toBe(400);
	});
});
