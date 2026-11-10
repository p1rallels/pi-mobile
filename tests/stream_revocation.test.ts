// Open streams and sockets lose their access with the browser, device or Face ID session that let them in: a logout,
// a device revoked or removed from the registry, a Face ID session that runs out. A secure-mode server behind a stand-in
// for the trusted proxy (the fingerprint header), with signed dummy cookies, a hosted and a followed dummy session and
// terminal shells.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeviceRegistry, revokeDevice, saveDeviceRegistry } from "../src/device-registry.ts";
import { STREAM_SWEEP_MS } from "../src/open-streams.ts";
import { createCookieSigner } from "../src/signed-cookies.ts";
import { sandboxServerEnv } from "./support/sandbox_env.js";

const HOST = "streams.example";
const CERT_HEADER = "x-pi-web-client-cert-fingerprint";
/** A sweep may have just run when access goes: the next one is a full interval away, plus slack for a loaded machine. */
const CLOSE_BOUND_MS = STREAM_SWEEP_MS + 2_500;
const DEVICES = ["laptop", "revoked", "removed", "expired", "keeper"] as const;
type DeviceName = (typeof DEVICES)[number];
const fingerprint = (name: DeviceName) => (DEVICES.indexOf(name) + 1).toString(16).repeat(64);
const liveId = "01a13c00-0000-7000-8000-00000000e301";
const followId = "01a13c00-0000-7000-8000-00000000e302";

const key = Buffer.alloc(32, 0x53);
const signer = createCookieSigner(key);
let root = "";
let cwd = "";
let registryPath = "";
let followPath = "";
let base = "";
let wsBase = "";
let server: Bun.Subprocess | null = null;
let serverLog = "";
let lastFollowEntry = "a0000000";
let followEntries = 0;
const cleanups: Array<() => Promise<void> | void> = [];

type HeaderMap = Record<string, string>;

/** A browser's requests as the proxy hands them on: its device's fingerprint, its client and Face ID cookies. */
function browser(clientId: string, device: DeviceName, faceId: { exp?: number } = {}): HeaderMap {
	const dev = fingerprint(device);
	const verifiedAt = Date.now();
	const client = signer.sign({ kind: "client", clientId, dev, exp: Date.now() + 86_400_000 });
	const face = signer.sign({ kind: "faceid", clientId, dev, rpId: HOST, verifiedAt, exp: faceId.exp ?? verifiedAt + 3_600_000, jti: `jti-${clientId}` });
	return { host: HOST, origin: `http://${HOST}`, [CERT_HEADER]: dev, cookie: `pi_web_client=${client}; pi_web_faceid=${face}` };
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
	/** Everything received so far, as text. */
	received(): string;
	/** A terminal socket's close code and reason, once closed. */
	closeFrame(): { code: number; reason: string } | null;
	end(): Promise<void>;
}

async function openSse(label: string, path: string, headers: HeaderMap): Promise<Connection> {
	const abort = new AbortController();
	const res = await fetch(base + path, { headers, signal: abort.signal });
	if (!res.ok || !res.body) throw new Error(`${label}: ${String(res.status)} ${await res.text()}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let closed = false;
	const pump = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
		} catch {
			// aborted by end()
		} finally {
			closed = true;
		}
	})();
	if (!(await waitUntil(() => text.includes("data: ") || closed, 8_000)) || closed) throw new Error(`${label}: no first frame`);
	const connection: Connection = {
		label,
		closed: () => closed,
		received: () => text,
		closeFrame: () => null,
		async end() {
			abort.abort();
			await pump;
		},
	};
	cleanups.push(() => connection.end());
	return connection;
}

async function openTerminal(label: string, headers: HeaderMap): Promise<Connection & { input(data: string): void; id: string }> {
	const { id } = await jsonRequest<{ id: string }>("/api/terminals", headers, "POST", { cwd });
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
		received: () => output,
		closeFrame: () => closeFrame,
		input: (data: string) => ws.send(JSON.stringify({ type: "input", data })),
		async end() {
			if (closeFrame === null) ws.close();
			await waitUntil(() => closeFrame !== null, 2_000);
		},
	};
	cleanups.push(() => connection.end());
	return connection;
}

interface BrowserConnections {
	events: Connection;
	follow: Connection;
	canvas: Connection;
	terminal: Awaited<ReturnType<typeof openTerminal>>;
}

/** What a canvas page holds open: a hosted session's events, a followed one, the status stream and a shell. */
async function openAll(name: string, headers: HeaderMap): Promise<BrowserConnections> {
	const [events, follow, canvas, terminal] = await Promise.all([
		openSse(`${name} events`, `/api/sessions/${liveId}/events`, headers),
		openSse(`${name} follow`, `/api/sessions/${followId}/follow?path=${encodeURIComponent(followPath)}`, headers),
		openSse(`${name} canvas status`, "/api/canvas/status", headers),
		openTerminal(`${name} terminal`, headers),
	]);
	return { events, follow, canvas, terminal };
}

const all = (c: BrowserConnections): Connection[] => [c.events, c.follow, c.canvas, c.terminal];
const openOnes = (connections: Connection[]) => connections.filter((c) => !c.closed()).map((c) => c.label);

/** Live viewers of hosted sessions: a closed events stream that still counted would mean its cleanup never ran. */
async function viewers(): Promise<number> {
	return ((await (await fetch(`${base}/health`)).json()) as { viewers: number }).viewers;
}

async function expectAllClosedWithin(connections: Connection[], ms: number): Promise<void> {
	await waitUntil(() => connections.every((c) => c.closed()), ms);
	expect(openOnes(connections)).toEqual([]);
}

/** Each kind of connection still gets news: a renamed session, a new follow entry, a status frame, shell output. */
async function expectStillDelivering(c: BrowserConnections, marker: string): Promise<void> {
	const statusFrames = () => c.canvas.received().split('"type":"canvas_status"').length;
	const canvasBefore = statusFrames();
	await jsonRequest(`/api/sessions/${liveId}/command`, keeperHeaders, "POST", { type: "set_session_name", name: `renamed-${marker}` });
	const entryId = `u${String(++followEntries).padStart(7, "0")}`;
	await appendFile(followPath, JSON.stringify(userMessage(entryId, lastFollowEntry, `follow-${marker}`)) + "\n");
	lastFollowEntry = entryId;
	// a new viewer changes the status the canvas stream reports
	const viewer = await openSse(`${marker} extra viewer`, `/api/sessions/${liveId}/events`, keeperHeaders);
	const shellMarker = `shell-${marker}`;
	const octal = [...shellMarker].map((ch) => "\\" + ch.charCodeAt(0).toString(8).padStart(3, "0")).join("");
	c.terminal.input(`printf '${octal}\\n'\r`);
	await waitUntil(
		() =>
			c.events.received().includes(`renamed-${marker}`) &&
			c.follow.received().includes(`follow-${marker}`) &&
			statusFrames() > canvasBefore &&
			c.terminal.received().includes(shellMarker),
		8_000,
	);
	expect({
		events: c.events.received().includes(`renamed-${marker}`),
		follow: c.follow.received().includes(`follow-${marker}`),
		canvas: statusFrames() > canvasBefore,
		terminal: c.terminal.received().includes(shellMarker),
	}).toEqual({ events: true, follow: true, canvas: true, terminal: true });
	await viewer.end();
}

function userMessage(id: string, parentId: string | null, text: string) {
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } };
}

async function writeSession(dir: string, id: string): Promise<string> {
	const path = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const lines = [
		{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
		userMessage("u0000000", null, "initial dummy transcript"),
		{
			type: "message",
			id: "a0000000",
			parentId: "u0000000",
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "initial dummy answer" }], api: "anthropic-messages", provider: "anthropic", model: "dummy", usage, stopReason: "stop", timestamp: Date.now() },
		},
	];
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = probe.port;
	probe.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

let keeperHeaders: HeaderMap = {};
let keeper: BrowserConnections;

beforeAll(async () => {
	root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-stream-revocation-"));
	const home = join(root, "home");
	const agent = join(root, "agent");
	cwd = join(root, "repo");
	registryPath = join(home, "devices.json");
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
	const sessionsDir = join(agent, "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(sessionsDir, { recursive: true });
	const livePath = await writeSession(sessionsDir, liveId);
	followPath = await writeSession(sessionsDir, followId);

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
			PI_WEB_PUBLIC_ORIGIN: `http://${HOST}`,
			PI_WEB_DEVICE_REGISTRY: registryPath,
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

	keeperHeaders = browser("browser-keeper", "keeper");
	await jsonRequest("/api/sessions", keeperHeaders, "POST", { resumeSessionPath: livePath });
	keeper = await openAll("keeper", keeperHeaders);
}, 30_000);

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (await predicate()) return true;
		await Bun.sleep(50);
	}
	return false;
}

afterAll(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
	server?.kill();
	await server?.exited.catch(() => undefined);
	if (root) await rm(root, { recursive: true, force: true });
});

describe("open streams and sockets lose access with what let them in (secure mode)", () => {
	test("a logout closes that browser's streams and terminal socket at once; another browser on the same device keeps its own", async () => {
		const leaving = browser("browser-leaving", "laptop");
		const staying = browser("browser-staying", "laptop");
		const left = await openAll("logged-out browser", leaving);
		const stayed = await openAll("other browser", staying);
		const watching = await viewers();

		expect((await request("/api/faceid/logout", leaving, "POST")).status).toBe(200);
		await expectAllClosedWithin(all(left), CLOSE_BOUND_MS);
		// closed by the logout itself, not by a sweep that found its token revoked
		expect(left.terminal.closeFrame()).toEqual({ code: 4401, reason: "logged out" });
		expect(await viewers()).toBe(watching - 1);
		// what a reconnect gets: the page lands on its Face ID prompt
		expect((await request(`/api/sessions/${liveId}/events`, leaving)).status).toBe(401);

		// a sweep or two later the other browser's connections are still open and still get news
		await Bun.sleep(STREAM_SWEEP_MS + 500);
		expect(openOnes(all(stayed))).toEqual(all(stayed).map((c) => c.label));
		await expectStillDelivering(stayed, "after-logout");
		await Promise.all(all(stayed).map((c) => c.end()));
	}, 45_000);

	test("a device revoked, or removed from the registry, loses its open streams and shells within a sweep", async () => {
		const revoked = await openAll("revoked device", browser("browser-revoked", "revoked"));
		const removed = await openAll("removed device", browser("browser-removed", "removed"));
		const watching = await viewers();

		await revokeDevice(registryPath, "revoked");
		const registry = await loadDeviceRegistry(registryPath);
		await saveDeviceRegistry(registryPath, { ...registry, devices: registry.devices.filter((device) => device.name !== "removed") });

		await expectAllClosedWithin([...all(revoked), ...all(removed)], CLOSE_BOUND_MS);
		const deviceGone = { code: 4403, reason: "device not allowed" };
		expect([revoked.terminal.closeFrame(), removed.terminal.closeFrame()]).toEqual([deviceGone, deviceGone]);
		expect(await viewers()).toBe(watching - 2);
		expect((await request("/api/canvas/status", browser("browser-revoked", "revoked"))).status).toBe(403);
	}, 45_000);

	test("a Face ID session that runs out while its streams are open closes them", async () => {
		const exp = Date.now() + 3_000;
		const expiring = await openAll("expiring Face ID", browser("browser-expiring", "expired", { exp }));
		expect(openOnes(all(expiring))).toHaveLength(4);

		await Bun.sleep(Math.max(0, exp - Date.now()));
		await expectAllClosedWithin(all(expiring), CLOSE_BOUND_MS);
		expect(expiring.terminal.closeFrame()).toEqual({ code: 4401, reason: "face id ended" });
	}, 45_000);

	test("control: nothing closes without a cause; the keeper's connections, open through every sweep above, still deliver", async () => {
		expect(openOnes(all(keeper))).toEqual(all(keeper).map((c) => c.label));
		await expectStillDelivering(keeper, "control");
		expect(openOnes(all(keeper))).toEqual(all(keeper).map((c) => c.label));
	}, 30_000);
});
