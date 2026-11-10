import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cutoffsFile,
	isLoggedOut,
	loadCutoffs,
	openFaceIdLogouts,
	parseCutoffsFile,
	pruneCutoffs,
	withLogout,
} from "../src/faceid-logout.ts";
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

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-faceid-logout-"));
	tempDirs.push(dir);
	return dir;
}

const HOUR = 3_600_000;

describe("face id logout cutoffs", () => {
	test("a cutoff ends checks at or before it, for its browser only", () => {
		const cutoffs = new Map([["a", 1_000]]);
		expect(isLoggedOut(cutoffs, "a", 999)).toBe(true);
		expect(isLoggedOut(cutoffs, "a", 1_000)).toBe(true);
		expect(isLoggedOut(cutoffs, "a", 1_001)).toBe(false);
		expect(isLoggedOut(cutoffs, "b", 0)).toBe(false);
	});

	test("a logout only moves a cutoff forward and leaves the old map alone", () => {
		const before = new Map([["a", 2_000]]);
		const after = withLogout(before, ["a", "b"], 1_500);
		expect([...after]).toEqual([
			["a", 2_000],
			["b", 1_500],
		]);
		expect([...withLogout(after, ["a"], 3_000)]).toEqual([
			["a", 3_000],
			["b", 1_500],
		]);
		expect([...before]).toEqual([["a", 2_000]]);
	});

	test("a cutoff goes once every check it covers has run out", () => {
		const cutoffs = new Map([
			["old", 10_000],
			["new", 20_000],
		]);
		expect([...pruneCutoffs(cutoffs, 10_000 + HOUR - 1, HOUR).keys()]).toEqual(["old", "new"]);
		expect([...pruneCutoffs(cutoffs, 10_000 + HOUR, HOUR).keys()]).toEqual(["new"]);
		expect([...pruneCutoffs(cutoffs, 20_000 + HOUR, HOUR).keys()]).toEqual([]);
	});

	test("the file format round-trips and anything else is refused", () => {
		const cutoffs = new Map([["a", 1_000]]);
		expect([...parseCutoffsFile(JSON.parse(JSON.stringify(cutoffsFile(cutoffs))))]).toEqual([["a", 1_000]]);
		const bad = [
			null,
			[],
			"x",
			{},
			{ version: 2, cutoffs: {} },
			{ version: 1 },
			{ version: 1, cutoffs: [] },
			{ version: 1, cutoffs: { a: "1" } },
			{ version: 1, cutoffs: { a: null } },
			{ version: 1, cutoffs: { "": 1 } },
		];
		for (const raw of bad) expect(() => parseCutoffsFile(raw)).toThrow();
	});

	test("no file means no logouts; an unreadable one throws instead of starting over", async () => {
		const dir = await tempDir();
		const path = join(dir, "faceid-logouts.json");
		expect((await loadCutoffs(path)).size).toBe(0);
		await writeFile(path, "{", { mode: 0o600 });
		await expect(loadCutoffs(path)).rejects.toThrow(path);
		await writeFile(path, JSON.stringify({ version: 1, cutoffs: { a: "soon" } }), { mode: 0o600 });
		await expect(loadCutoffs(path)).rejects.toThrow("Face ID logouts");
		await rm(path);
		await mkdir(path);
		await expect(loadCutoffs(path)).rejects.toThrow(path);
		await expect(openFaceIdLogouts(path, HOUR)).rejects.toThrow(path);
	});

	test("a home under a symlinked folder starts with no logouts but won't read one there", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "real"));
		await symlink(join(dir, "real"), join(dir, "link"));
		const path = join(dir, "link", "faceid-logouts.json");
		expect((await loadCutoffs(path)).size).toBe(0);
		await writeFile(path, JSON.stringify(cutoffsFile(new Map([["a", 1]]))), { mode: 0o600 });
		await expect(loadCutoffs(path)).rejects.toThrow("symlinked");
	});

	test("logouts are saved, survive a reopen and drop out once they can't matter", async () => {
		const path = join(await tempDir(), "faceid-logouts.json");
		const now = Date.now();
		const first = await openFaceIdLogouts(path, HOUR, now);
		await first.logOut(["a"], now - HOUR);
		await first.logOut(["b"], now);
		expect(first.isLoggedOut("b", now)).toBe(true);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, cutoffs: { b: now } });

		await writeFile(path, JSON.stringify(cutoffsFile(new Map([["stale", now - HOUR], ["b", now]]))), { mode: 0o600 });
		const reopened = await openFaceIdLogouts(path, HOUR, now);
		expect(reopened.isLoggedOut("b", now)).toBe(true);
		expect(reopened.isLoggedOut("b", now + 1)).toBe(false);
		expect(reopened.isLoggedOut("stale", now - HOUR)).toBe(false);
		await reopened.logOut([], now);
		await reopened.logOut(["c"], now + 1);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, cutoffs: { b: now, c: now + 1 } });
	});

	test("logouts at once are all saved", async () => {
		const path = join(await tempDir(), "faceid-logouts.json");
		const now = Date.now();
		const logouts = await openFaceIdLogouts(path, HOUR, now);
		const ids = Array.from({ length: 20 }, (_, i) => `client-${String(i)}`);
		await Promise.all(ids.map((id, i) => logouts.logOut([id], now + i)));
		expect(Object.keys(cutoffsFile(await loadCutoffs(path)).cutoffs).sort()).toEqual([...ids].sort());
	});

	test("a logout that can't be saved says so and still holds until a restart", async () => {
		const path = join(await tempDir(), "faceid-logouts.json");
		const now = Date.now();
		const logouts = await openFaceIdLogouts(path, HOUR, now);
		await mkdir(path);
		await expect(logouts.logOut(["a"], now)).rejects.toThrow();
		expect(logouts.isLoggedOut("a", now)).toBe(true);
		await rm(path, { recursive: true });
		await logouts.logOut(["b"], now);
		expect(Object.keys(cutoffsFile(await loadCutoffs(path)).cutoffs).sort()).toEqual(["a", "b"]);
	});
});

// A secure-mode server behind a pretend proxy (mTLS fingerprints in a header) with two enrolled devices and a dummy
// P-256 platform authenticator, so every Face ID cookie below comes from a real /api/faceid/verify.
const RP = "cookie-review.example";
const ORIGIN = `https://${RP}`;
const DEVICE_A = "a".repeat(64);
const DEVICE_B = "b".repeat(64);

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

interface Authenticator {
	credentialId: string;
	privateKey: KeyObject;
	counter: number;
}

async function enroll(root: string): Promise<Authenticator> {
	const home = join(root, "home");
	const agentPiWeb = join(root, "agent", "pi-web");
	await mkdir(home, { recursive: true, mode: 0o700 });
	await mkdir(agentPiWeb, { recursive: true, mode: 0o700 });
	const devices = [DEVICE_A, DEVICE_B].map((fingerprintSha256, i) => ({
		name: `dummy-device-${String(i)}`,
		platform: "ios",
		fingerprintSha256,
		serial: String(i + 1),
		issuedAt: "2025-01-01T00:00:00Z",
		expiresAt: "2099-01-01T00:00:00Z",
		revokedAt: null,
	}));
	await writeFile(join(home, "devices.json"), JSON.stringify({ version: 1, devices }), { mode: 0o600 });
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = publicKey.export({ format: "jwk" });
	if (!jwk.x || !jwk.y) throw new Error("no P-256 point");
	const cose = Buffer.concat([
		Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
		Buffer.from(jwk.x, "base64url"),
		Buffer.from([0x22, 0x58, 0x20]),
		Buffer.from(jwk.y, "base64url"),
	]);
	const credentialId = Buffer.from("dummy-logout-credential").toString("base64url");
	const credential = { id: credentialId, publicKey: cose.toString("base64url"), counter: 0, transports: ["internal"], createdAt: "2025-01-01T00:00:00Z", lastUsedAt: "2025-01-01T00:00:00Z" };
	await writeFile(join(agentPiWeb, "faceid-credentials.json"), JSON.stringify({ version: 2, rpCredentials: { [RP]: [credential] } }), { mode: 0o600 });
	return { credentialId, privateKey, counter: 0 };
}

async function secureServer() {
	const root = await tempDir();
	const port = await freePort();
	const base = `http://127.0.0.1:${String(port)}`;
	const authenticator = await enroll(root);
	const env = sandboxServerEnv(root, {
		PI_WEB_PORT: String(port),
		PI_WEB_PUBLIC_ORIGIN: ORIGIN,
		PI_WEB_TRUST_PROXY: "1",
		PI_WEB_SECURE_MODE: "1",
		PI_WEB_TERMINALS: "off",
		PI_OFFLINE: "1",
	});
	let proc: Bun.Subprocess<"ignore", "ignore", "pipe"> | null = null;

	const request = (path: string, init: { cookie?: string; device?: string; method?: string; body?: unknown } = {}) =>
		fetch(`${base}${path}`, {
			method: init.method ?? "GET",
			redirect: "error",
			signal: AbortSignal.timeout(5_000),
			headers: {
				host: RP,
				origin: ORIGIN,
				"x-forwarded-proto": "https",
				"x-pi-web-client-cert-fingerprint": init.device ?? DEVICE_A,
				...(init.cookie ? { cookie: init.cookie } : {}),
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});

	const spawn = () => {
		const next = Bun.spawn({ cmd: [process.execPath, "src/server.ts"], env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
		procs.push(next);
		proc = next;
		return next;
	};

	return {
		root,
		home: join(root, "home"),
		async start(): Promise<void> {
			const started = spawn();
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (started.exitCode !== null) throw new Error(`server exited ${String(started.exitCode)}: ${await new Response(started.stderr).text()}`);
				try {
					if ((await request("/health")).ok) return;
				} catch {
					// not listening yet
				}
				await Bun.sleep(50);
			}
			throw new Error("server did not become healthy");
		},
		/** Starts a server that should refuse to: its exit code and what it said. */
		async startRefused(): Promise<{ code: number; stderr: string }> {
			const refused = spawn();
			const timer = setTimeout(() => refused.kill("SIGKILL"), 10_000);
			const code = await refused.exited;
			clearTimeout(timer);
			return { code, stderr: await new Response(refused.stderr).text() };
		},
		async stop(): Promise<void> {
			const running = proc;
			if (!running) return;
			running.kill("SIGTERM");
			const timer = setTimeout(() => running.kill("SIGKILL"), 3_000);
			await running.exited;
			clearTimeout(timer);
			procs.splice(procs.indexOf(running), 1);
			proc = null;
		},
		/** A new browser on `device`: its client cookie. */
		async browser(device = DEVICE_A): Promise<string> {
			const created = await request("/api/client", { method: "POST", device });
			expect(created.status).toBe(200);
			await created.body?.cancel();
			return created.headers.get("set-cookie")?.split(";")[0] ?? "";
		},
		/** A Face ID check from this browser: its client and Face ID cookies together. */
		async verify(clientCookie: string, device = DEVICE_A): Promise<string> {
			const challenge = await request("/api/faceid/challenge", { cookie: clientCookie, device, method: "POST", body: { kind: "authenticate" } });
			expect(challenge.status).toBe(200);
			const { challengeId, options } = (await challenge.json()) as { challengeId: string; options: { challenge: string } };
			const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
			const counter = Buffer.alloc(4);
			counter.writeUInt32BE((authenticator.counter += 1));
			const authData = Buffer.concat([createHash("sha256").update(RP).digest(), Buffer.from([0x05]), counter]);
			const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), authenticator.privateKey);
			const verified = await request("/api/faceid/verify", {
				cookie: clientCookie,
				device,
				method: "POST",
				body: {
					challengeId,
					credential: {
						id: authenticator.credentialId,
						rawId: authenticator.credentialId,
						type: "public-key",
						clientExtensionResults: {},
						authenticatorAttachment: "platform",
						response: {
							clientDataJSON: clientData.toString("base64url"),
							authenticatorData: authData.toString("base64url"),
							signature: signature.toString("base64url"),
						},
					},
				},
			});
			expect(verified.status).toBe(200);
			await verified.body?.cancel();
			const faceIdCookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
			expect(faceIdCookie.startsWith("pi_web_faceid=")).toBe(true);
			return `${clientCookie}; ${faceIdCookie}`;
		},
		async logout(cookies: string, device = DEVICE_A): Promise<{ status: number; cleared: boolean }> {
			const response = await request("/api/faceid/logout", { cookie: cookies, device, method: "POST" });
			await response.body?.cancel();
			return { status: response.status, cleared: response.headers.get("set-cookie")?.includes("Max-Age=0") ?? false };
		},
		/** A Face ID-protected route (a folder listing) with these cookies. */
		async protectedStatus(cookies: string, device = DEVICE_A): Promise<number> {
			const response = await request(`/api/dirs?path=${encodeURIComponent(`${root}/`)}`, { cookie: cookies, device });
			await response.body?.cancel();
			return response.status;
		},
	};
}

describe("face id logout on the server", () => {
	test("a logged-out check stays logged out across a restart, and a new check works", async () => {
		const server = await secureServer();
		await server.start();
		const browser = await server.browser();
		const checked = await server.verify(browser);
		expect(await server.protectedStatus(checked)).toBe(200);

		expect(await server.logout(checked)).toEqual({ status: 200, cleared: true });
		expect(await server.protectedStatus(checked)).toBe(401);

		await server.stop();
		await server.start();
		expect(await server.protectedStatus(checked)).toBe(401);
		const again = await server.verify(browser);
		expect(await server.protectedStatus(again)).toBe(200);
	}, 30_000);

	test("logout ends every earlier check from that browser and no other browser's", async () => {
		const server = await secureServer();
		await server.start();
		const browser = await server.browser();
		const earlier = await server.verify(browser);
		const latest = await server.verify(browser);
		expect(earlier).not.toBe(latest);
		const neighbour = await server.verify(await server.browser());
		const otherDevice = await server.verify(await server.browser(DEVICE_B), DEVICE_B);

		expect(await server.logout(latest)).toEqual({ status: 200, cleared: true });
		expect(await server.protectedStatus(latest)).toBe(401);
		expect(await server.protectedStatus(earlier)).toBe(401);
		expect(await server.protectedStatus(neighbour)).toBe(200);
		expect(await server.protectedStatus(otherDevice, DEVICE_B)).toBe(200);

		const after = await server.verify(browser);
		expect(await server.protectedStatus(after)).toBe(200);
	}, 30_000);

	test("a logout that can't be saved is an error, and unreadable logouts stop the next start", async () => {
		const server = await secureServer();
		await server.start();
		const checked = await server.verify(await server.browser());
		await mkdir(join(server.home, "faceid-logouts.json"));

		expect(await server.logout(checked)).toEqual({ status: 500, cleared: true });
		expect(await server.protectedStatus(checked)).toBe(401);

		await server.stop();
		const refused = await server.startRefused();
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("faceid-logouts.json");
	}, 30_000);
});
