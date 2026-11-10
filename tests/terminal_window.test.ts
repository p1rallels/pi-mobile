// An open terminal socket is held to the rule a fresh attach meets: a Face ID check from the command window, newer than
// its browser's last terminal lock, where the check is the newest one its browser passed on this host. So a browser that
// keeps passing checks keeps its shell, and a page left open past the window loses it, however long other browsers'
// checks keep the shell itself alive. A secure-mode server behind a stand-in for the trusted proxy (the fingerprint
// header) with a 1-minute command window, signed dummy cookies whose checks are backdated so that window ends seconds
// into the test, and real Face ID checks from a dummy passkey.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveDeviceRegistry } from "../src/device-registry.ts";
import { STREAM_SWEEP_MS } from "../src/open-streams.ts";
import { createCookieSigner } from "../src/signed-cookies.ts";
import { newestCheck, withPassedCheck, type PassedChecks } from "../src/terminal-window.ts";
import { assertion, passkey, registration } from "./support/passkey.ts";
import { sandboxServerEnv } from "./support/sandbox_env.js";

describe("which check holds a shell", () => {
	const laptop = { clientId: "c1", device: "aa", rpId: "pi.example" };
	const empty: PassedChecks = new Map();

	test("a browser's newest check counts: the one its request carries, or one it passed since", () => {
		expect(newestCheck(empty, laptop, 100)).toBe(100);
		const passed = withPassedCheck(empty, laptop, 500, 1_000);
		expect(newestCheck(passed, laptop, 100)).toBe(500);
		expect(newestCheck(passed, laptop, 700)).toBe(700);
		// a check recorded late never moves it back
		expect(newestCheck(withPassedCheck(passed, laptop, 400, 1_000), laptop, 0)).toBe(500);
		expect(empty.size).toBe(0);
	});

	test("another browser's check, the same browser's on another device or for another host, doesn't count", () => {
		const passed = withPassedCheck(empty, laptop, 500, 1_000);
		for (const other of [
			{ ...laptop, clientId: "c2" },
			{ ...laptop, device: "bb" },
			{ ...laptop, device: null },
			{ ...laptop, rpId: "localhost" },
		]) {
			expect(newestCheck(passed, other, 100)).toBe(100);
		}
	});

	test("checks too old to hold a shell drop out of the record", () => {
		const old = withPassedCheck(empty, { ...laptop, clientId: "old" }, 0, 1_000);
		const both = withPassedCheck(old, laptop, 900, 1_000);
		expect(both.size).toBe(2);
		expect(withPassedCheck(both, laptop, 1_001, 1_000).size).toBe(1);
	});
});

const HOST = "termwindow.example";
const ORIGIN = `http://${HOST}`;
const CERT_HEADER = "x-pi-web-client-cert-fingerprint";
const COMMAND_WINDOW_MS = 60_000;
/** How long into the test the backdated checks' command window ends: room for the setup on a loaded machine. */
const WINDOW_LEFT_MS = 12_000;
/** A sweep may have just run when the window ends: the next one is a full interval away, plus slack. */
const CLOSE_BOUND_MS = STREAM_SWEEP_MS + 2_500;
const DEVICES = ["laptop", "phone"] as const;
type DeviceName = (typeof DEVICES)[number];
const fingerprint = (name: DeviceName) => (DEVICES.indexOf(name) + 1).toString(16).repeat(64);

const key = Buffer.alloc(32, 0x57);
const signer = createCookieSigner(key);
const owner = passkey();
let root = "";
let cwd = "";
let base = "";
let wsBase = "";
let server: Bun.Subprocess | null = null;
let serverLog = "";
const cleanups: Array<() => Promise<void> | void> = [];

type HeaderMap = Record<string, string>;

const clientCookie = (clientId: string, device: DeviceName) =>
	`pi_web_client=${signer.sign({ kind: "client", clientId, dev: fingerprint(device), exp: Date.now() + 86_400_000 })}`;

/** A browser's requests as the proxy hands them on; with a Face ID cookie for a check passed at `checkedAt`. */
function browser(clientId: string, device: DeviceName, checkedAt?: number): HeaderMap {
	const dev = fingerprint(device);
	const face =
		checkedAt === undefined
			? null
			: signer.sign({ kind: "faceid", clientId, dev, rpId: HOST, verifiedAt: checkedAt, exp: checkedAt + 4 * 3_600_000, jti: `jti-${clientId}` });
	const cookies = [clientCookie(clientId, device), ...(face ? [`pi_web_faceid=${face}`] : [])];
	return { host: HOST, origin: ORIGIN, [CERT_HEADER]: dev, cookie: cookies.join("; ") };
}

async function request(path: string, headers: HeaderMap, method = "GET", body?: unknown): Promise<Response> {
	return fetch(base + path, {
		method,
		headers: { ...headers, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(8_000),
	});
}

async function jsonRequest<T = Record<string, unknown>>(path: string, headers: HeaderMap, method = "GET", body?: unknown): Promise<T> {
	const res = await request(path, headers, method, body);
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path}: ${String(res.status)} ${text}`);
	return JSON.parse(text) as T;
}

/** A Face ID check passed in a browser, the way its page passes one; the cookie it gets back replaces its old one. */
async function passCheck(clientId: string, device: DeviceName, kind: "register" | "authenticate" = "authenticate"): Promise<HeaderMap> {
	const headers = browser(clientId, device);
	const { challengeId, options } = await jsonRequest<{ challengeId: string; options: { challenge: string } }>("/api/faceid/challenge", headers, "POST", { kind });
	const credential = kind === "register" ? registration(owner, options.challenge, HOST, ORIGIN) : assertion(owner, options.challenge, HOST, ORIGIN);
	const res = await request("/api/faceid/verify", headers, "POST", { challengeId, credential });
	const text = await res.text();
	if (!res.ok) throw new Error(`${clientId} on ${device}: ${kind} check refused: ${String(res.status)} ${text}`);
	const face = res.headers.get("set-cookie")?.split(";")[0] ?? "";
	return { ...headers, cookie: kind === "register" ? headers.cookie : `${clientCookie(clientId, device)}; ${face}` };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (predicate()) return true;
		await Bun.sleep(25);
	}
	return predicate();
}

interface Connection {
	label: string;
	closed(): boolean;
	closeFrame(): { code: number; reason: string } | null;
}

/** A shell the keeper opens, and a browser's socket onto it. */
async function attachTerminal(label: string, headers: HeaderMap) {
	const { id } = await jsonRequest<{ id: string }>("/api/terminals", keeperHeaders, "POST", { cwd });
	cleanups.push(async () => {
		await request(`/api/terminals/${id}/close`, keeperHeaders, "POST", { force: true }).then((res) => res.arrayBuffer());
	});
	const ws = new WebSocket(`${wsBase}/api/terminals/${id}/socket`, { headers });
	ws.binaryType = "arraybuffer";
	let opened = false;
	let closeFrame: { code: number; reason: string } | null = null;
	let output = "";
	const decoder = new TextDecoder();
	ws.onopen = () => {
		opened = true;
	};
	ws.onmessage = (event) => {
		output += typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer, { stream: true });
	};
	ws.onclose = (event) => {
		closeFrame = { code: event.code, reason: event.reason };
	};
	if (!(await waitUntil(() => output.includes('"type":"snapshot"') || closeFrame !== null, 8_000)) || !opened || closeFrame !== null) {
		throw new Error(`${label}: terminal socket didn't attach (close ${JSON.stringify(closeFrame)})`);
	}
	const connection = {
		label,
		id,
		closed: () => closeFrame !== null,
		closeFrame: () => closeFrame,
		/** Types a command that prints `marker` and waits for it to come back: the socket still reaches the shell. */
		async echoes(marker: string): Promise<boolean> {
			const octal = [...marker].map((ch) => "\\" + ch.charCodeAt(0).toString(8).padStart(3, "0")).join("");
			ws.send(JSON.stringify({ type: "input", data: `printf '${octal}\\n'\r` }));
			return waitUntil(() => output.includes(marker), 8_000);
		},
		async end() {
			if (closeFrame === null) ws.close();
			await waitUntil(() => closeFrame !== null, 2_000);
		},
	};
	cleanups.push(() => connection.end());
	return connection;
}

async function openSse(label: string, path: string, headers: HeaderMap): Promise<Connection> {
	const abort = new AbortController();
	const res = await fetch(base + path, { headers, signal: abort.signal });
	if (!res.ok || !res.body) throw new Error(`${label}: ${String(res.status)} ${await res.text()}`);
	const reader = res.body.getReader();
	let closed = false;
	let first = false;
	const pump = (async () => {
		try {
			for (;;) {
				const { done } = await reader.read();
				if (done) break;
				first = true;
			}
		} catch {
			// aborted at cleanup
		} finally {
			closed = true;
		}
	})();
	if (!(await waitUntil(() => first || closed, 8_000)) || closed) throw new Error(`${label}: no first frame`);
	cleanups.push(async () => {
		abort.abort();
		await pump;
	});
	return { label, closed: () => closed, closeFrame: () => null };
}

const openOnes = (connections: Connection[]) => connections.filter((c) => !c.closed()).map((c) => c.label);

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = probe.port;
	probe.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (await predicate()) return true;
		await Bun.sleep(50);
	}
	return false;
}

let keeperHeaders: HeaderMap = {};

beforeAll(async () => {
	root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-terminal-window-"));
	const home = join(root, "home");
	const registryPath = join(home, "devices.json");
	cwd = join(root, "repo");
	await mkdir(home, { recursive: true, mode: 0o700 });
	await mkdir(cwd, { recursive: true });
	await writeFile(join(home, "cookie-key"), key, { mode: 0o600 });
	await saveDeviceRegistry(registryPath, {
		version: 1,
		devices: DEVICES.map((name) => ({
			name,
			platform: "macos" as const,
			fingerprintSha256: fingerprint(name),
			serial: name,
			issuedAt: "2025-01-01T00:00:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
			revokedAt: null,
		})),
	});

	const port = await freePort();
	base = `http://127.0.0.1:${String(port)}`;
	wsBase = `ws://127.0.0.1:${String(port)}`;
	server = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdout: "pipe",
		stderr: "pipe",
		env: sandboxServerEnv(root, {
			PI_WEB_PORT: String(port),
			PI_WEB_SECURE_MODE: "1",
			PI_WEB_TRUST_PROXY: "1",
			PI_WEB_PUBLIC_ORIGIN: ORIGIN,
			PI_WEB_DEVICE_REGISTRY: registryPath,
			PI_WEB_FACEID_COMMAND_MINUTES: String(COMMAND_WINDOW_MS / 60_000),
			PI_WEB_PROJECT_TRUST: "never",
			PI_WEB_TERMINALS: "on",
			PI_OFFLINE: "1",
		}),
	});
	for (const stream of [server.stdout, server.stderr]) {
		if (!(stream instanceof ReadableStream)) continue;
		void (async () => {
			for await (const chunk of stream) serverLog += new TextDecoder().decode(chunk);
		})();
	}
	const healthy = await waitUntilAsync(async () => (await fetch(`${base}/health`).catch(() => null))?.ok === true, 8_000);
	if (!healthy) throw new Error(`server did not become healthy:\n${serverLog}`);

	await passCheck("browser-enroller", "phone", "register");
	keeperHeaders = await passCheck("browser-keeper", "phone");
}, 30_000);

afterAll(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
	server?.kill();
	await server?.exited.catch(() => undefined);
	if (root) await rm(root, { recursive: true, force: true });
});

describe("an open terminal socket and the command window (secure mode)", () => {
	test("a socket whose browser has no check from the window closes; one whose browser passed a check since stays", async () => {
		const windowEndsAt = Date.now() + WINDOW_LEFT_MS;
		const checkedAt = windowEndsAt - COMMAND_WINDOW_MS;
		const idleHeaders = browser("browser-idle", "laptop", checkedAt);
		const idle = await attachTerminal("idle browser's terminal", idleHeaders);
		const idleStatus = await openSse("idle browser's canvas status", "/api/canvas/status", idleHeaders);
		const activeHeaders = browser("browser-active", "laptop", checkedAt);
		const active = await attachTerminal("active browser's terminal", activeHeaders);
		expect(await idle.echoes("idle-before")).toBe(true);

		// other browsers' checks keep every shell on the host alive, but not the idle browser's hold on its own
		await passCheck("browser-other", "laptop");
		await passCheck("browser-idle", "phone");
		// keep open, in the page the active socket belongs to: a cookie that socket never sees
		await passCheck("browser-active", "laptop");
		if (Date.now() >= windowEndsAt) throw new Error("setup ran past the command window; raise WINDOW_LEFT_MS");
		expect(openOnes([idle, idleStatus, active])).toEqual([idle.label, idleStatus.label, active.label]);

		await Bun.sleep(Math.max(0, windowEndsAt - Date.now()));
		await waitUntil(() => idle.closed(), CLOSE_BOUND_MS);
		expect(openOnes([idle, idleStatus, active])).toEqual([idleStatus.label, active.label]);
		expect(idle.closeFrame()).toEqual({ code: 4401, reason: "face id check too old" });
		expect(await active.echoes("active-after")).toBe(true);

		// a fresh attach with the same cookies meets the same rule: the idle browser is refused, the active one let in
		const refused = await request(`/api/terminals/${idle.id}`, idleHeaders);
		expect([refused.status, ((await refused.json()) as { terminalLocked?: boolean }).terminalLocked]).toEqual([401, true]);
		expect((await request(`/api/terminals/${active.id}`, activeHeaders)).status).toBe(200);
		// the socket closed, not the shell
		const { terminals } = await jsonRequest<{ terminals: Array<{ id: string }> }>("/api/terminals", keeperHeaders);
		expect(terminals.map((t) => t.id)).toContain(idle.id);
	}, 60_000);
});
