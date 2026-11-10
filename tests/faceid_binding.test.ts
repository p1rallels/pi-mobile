import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { saveDeviceRegistry } from "../src/device-registry.ts";
import { bindingMismatch, ceremonyRefusal, FaceIdService, type ChallengeBinding } from "../src/faceid.ts";
import { sandboxServerEnv } from "./support/sandbox_env.js";

// A dummy platform authenticator: a real ES256 key pair, "none" attestation, UP+UV flags, so every WebAuthn check runs for real.

const b64 = (input: Uint8Array | string): string => Buffer.from(input).toString("base64url");
const sha256 = (input: Uint8Array | string): Buffer => createHash("sha256").update(input).digest();
const uint32 = (n: number): Buffer => {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(n);
	return out;
};

interface Authenticator {
	id: Buffer;
	privateKey: KeyObject;
	cose: Uint8Array;
	counter: number;
}

function authenticator(): Authenticator {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = publicKey.export({ format: "jwk" });
	if (!jwk.x || !jwk.y) throw new Error("missing ec coordinates");
	const cose = isoCBOR.encode(
		new Map<number, number | Uint8Array>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Buffer.from(jwk.x, "base64url")],
			[-3, Buffer.from(jwk.y, "base64url")],
		]),
	);
	return { id: randomBytes(32), privateKey, cose, counter: 0 };
}

function registration(a: Authenticator, challenge: string, rpId: string, origin: string) {
	const idLength = Buffer.alloc(2);
	idLength.writeUInt16BE(a.id.length);
	const authData = Buffer.concat([sha256(rpId), Buffer.from([0x45]), uint32(0), Buffer.alloc(16), idLength, a.id, a.cose]);
	const attestation = new Map<string, string | Uint8Array | Map<number, number>>([
		["fmt", "none"],
		["attStmt", new Map()],
		["authData", authData],
	]);
	return {
		id: b64(a.id),
		rawId: b64(a.id),
		type: "public-key",
		clientExtensionResults: {},
		response: {
			clientDataJSON: b64(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })),
			attestationObject: b64(isoCBOR.encode(attestation)),
			transports: ["internal"],
		},
	};
}

function assertion(a: Authenticator, challenge: string, rpId: string, origin: string) {
	a.counter += 1;
	const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
	const authData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), uint32(a.counter)]);
	return {
		id: b64(a.id),
		rawId: b64(a.id),
		type: "public-key",
		clientExtensionResults: {},
		response: {
			clientDataJSON: b64(clientData),
			authenticatorData: b64(authData),
			userHandle: b64("operator"),
			signature: b64(sign("sha256", Buffer.concat([authData, sha256(clientData)]), a.privateKey)),
		},
	};
}

const tempDirs: string[] = [];
const procs: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const proc of procs.splice(0)) {
		proc.kill();
		await proc.exited.catch(() => undefined);
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(await realpath(tmpdir()), "pi-web-faceid-binding-"));
	tempDirs.push(home);
	return home;
}

const errorOf = (promise: Promise<unknown>): Promise<string> =>
	promise.then(
		() => "accepted",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);

const RP = "pi.example.test";
const ORIGIN = "https://pi.example.test:8443";
const laptop: ChallengeBinding = { rpId: RP, origin: ORIGIN, clientId: "laptop-browser", device: "aa".repeat(32) };
const phone: ChallengeBinding = { rpId: RP, origin: ORIGIN, clientId: "phone-browser", device: "bb".repeat(32) };

interface Asked {
	challengeId: string;
	challenge: string;
	by: ChallengeBinding;
}

/** The authenticator's answers to a challenge, made for the RP and origin it was issued at. */
const signUp = (key: Authenticator, c: Asked) => registration(key, c.challenge, c.by.rpId, c.by.origin);
const signIn = (key: Authenticator, c: Asked) => assertion(key, c.challenge, c.by.rpId, c.by.origin);

/** A FaceIdService and its ceremonies: ask for a challenge as someone, answer it, present the answer as someone. */
async function service() {
	const faceId = new FaceIdService(join(await tempHome(), "faceid-credentials.json"));
	const ask = async (kind: "register" | "authenticate", by: ChallengeBinding): Promise<Asked> => {
		const asker = { clientId: by.clientId, device: by.device };
		const { challengeId, options } = await faceId.createChallenge(kind, by.rpId, by.origin, `device:${by.device ?? "none"}`, asker);
		return { challengeId, challenge: options.challenge, by };
	};
	const register = async (key: Authenticator, by: ChallengeBinding) => {
		const c = await ask("register", by);
		return faceId.verify(c.challengeId, signUp(key, c), by);
	};
	const authenticate = async (key: Authenticator, by: ChallengeBinding) => {
		const c = await ask("authenticate", by);
		return faceId.verify(c.challengeId, signIn(key, c), by);
	};
	return { faceId, ask, register, authenticate };
}

describe("face id challenges at verify", () => {
	test("a registration challenge issued before the first enrollment is refused after it", async () => {
		const { faceId, ask, authenticate } = await service();
		const owner = authenticator();
		const latecomer = authenticator();
		const first = await ask("register", laptop);
		const outstanding = await ask("register", phone);

		expect(await faceId.verify(first.challengeId, signUp(owner, first), laptop)).toEqual({ ok: true, kind: "register" });
		expect(await errorOf(ask("register", phone))).toBe("faceid_already_enrolled");
		expect(await errorOf(faceId.verify(outstanding.challengeId, signUp(latecomer, outstanding), phone))).toBe("faceid_already_enrolled");
		expect(await faceId.status(RP)).toEqual({ enrolled: true, credentialCount: 1 });
		expect(await errorOf(authenticate(latecomer, phone))).toBe("credential_not_registered");
		expect(await errorOf(faceId.verify(outstanding.challengeId, signUp(latecomer, outstanding), phone))).toBe("challenge_expired");
	});

	test.each([
		["another browser", { clientId: "someone-else" }],
		["another device", { device: "cc".repeat(32) }],
		["no device", { device: null }],
		["another rp", { rpId: "localhost" }],
		["another origin", { origin: "http://localhost:4317" }],
	] as const)("a challenge presented by %s is refused and spent", async (_, change) => {
		const { faceId, ask, register } = await service();
		const owner = authenticator();
		const elsewhere = { ...laptop, ...change };

		const pending = await ask("register", laptop);
		expect(await errorOf(faceId.verify(pending.challengeId, signUp(owner, pending), elsewhere))).toBe("challenge_mismatch");
		expect(await faceId.status(RP)).toEqual({ enrolled: false, credentialCount: 0 });

		await register(owner, laptop);
		const c = await ask("authenticate", laptop);
		const answer = signIn(owner, c);
		expect(await errorOf(faceId.verify(c.challengeId, answer, elsewhere))).toBe("challenge_mismatch");
		expect(await errorOf(faceId.verify(c.challengeId, answer, laptop))).toBe("challenge_expired");
	});

	test("two first enrollments verified at once: the first one in wins, the other is refused", async () => {
		const { faceId, ask, authenticate } = await service();
		const keys = [authenticator(), authenticator()] as const;
		const [mine, theirs] = await Promise.all([ask("register", laptop), ask("register", phone)]);
		const outcomes = await Promise.all([
			errorOf(faceId.verify(mine.challengeId, signUp(keys[0], mine), laptop)),
			errorOf(faceId.verify(theirs.challengeId, signUp(keys[1], theirs), phone)),
		]);

		expect(outcomes).toEqual(["accepted", "faceid_already_enrolled"]);
		expect(await faceId.status(RP)).toEqual({ enrolled: true, credentialCount: 1 });
		expect(await authenticate(keys[0], laptop)).toEqual({ ok: true, kind: "authenticate" });
		expect(await errorOf(authenticate(keys[1], phone))).toBe("credential_not_registered");
	});

	test("the normal flows still pass: enroll, then any enrolled browser authenticates, each challenge once", async () => {
		const { faceId, ask, register, authenticate } = await service();
		const owner = authenticator();

		expect(await errorOf(ask("authenticate", laptop))).toBe("faceid_not_enrolled");
		expect(await register(owner, laptop)).toEqual({ ok: true, kind: "register" });
		expect(await authenticate(owner, laptop)).toEqual({ ok: true, kind: "authenticate" });
		expect(await authenticate(owner, phone)).toEqual({ ok: true, kind: "authenticate" });

		const c = await ask("authenticate", laptop);
		const answer = signIn(owner, c);
		expect(await faceId.verify(c.challengeId, answer, laptop)).toEqual({ ok: true, kind: "authenticate" });
		expect(await errorOf(faceId.verify(c.challengeId, answer, laptop))).toBe("challenge_expired");

		const local = { rpId: "localhost", origin: "http://localhost:4317", clientId: "laptop-browser", device: null };
		expect(await register(authenticator(), local)).toEqual({ ok: true, kind: "register" });
		expect(await faceId.status("localhost")).toEqual({ enrolled: true, credentialCount: 1 });
		expect(await faceId.status(RP)).toEqual({ enrolled: true, credentialCount: 1 });
	});
});

describe("binding and first-use rules", () => {
	test("bindingMismatch names the first field that differs", () => {
		expect(bindingMismatch(laptop, { ...laptop })).toBeNull();
		expect(bindingMismatch(laptop, { ...laptop, rpId: "localhost" })).toBe("rpId");
		expect(bindingMismatch(laptop, { ...laptop, origin: "https://pi.example.test" })).toBe("origin");
		expect(bindingMismatch(laptop, { ...laptop, clientId: "other" })).toBe("clientId");
		expect(bindingMismatch(laptop, { ...laptop, device: null })).toBe("device");
		expect(bindingMismatch(laptop, phone)).toBe("clientId");
		expect(bindingMismatch({ ...laptop, device: null }, { ...laptop, device: null })).toBeNull();
	});

	test("ceremonyRefusal: registration is first use only, authentication needs an enrollment", () => {
		expect(ceremonyRefusal("register", 0)).toBeNull();
		expect(ceremonyRefusal("register", 1)).toBe("faceid_already_enrolled");
		expect(ceremonyRefusal("register", 3)).toBe("faceid_already_enrolled");
		expect(ceremonyRefusal("authenticate", 0)).toBe("faceid_not_enrolled");
		expect(ceremonyRefusal("authenticate", 1)).toBeNull();
	});
});

// The HTTP side: a secure-mode server behind the (simulated) mTLS proxy, two enrolled devices, a remote host and the loopback one.

const REMOTE_HOST = "pi.example.test:8443";
const REMOTE_ORIGIN = `https://${REMOTE_HOST}`;
const CERT_HEADER = "x-pi-web-client-cert-fingerprint";
const deviceA = "aa".repeat(32);
const deviceB = "bb".repeat(32);

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

async function secureServer(): Promise<number> {
	const home = await tempHome();
	const port = await freePort();
	const registry = join(home, "devices.json");
	const device = (name: string, fingerprintSha256: string) => ({
		name,
		platform: "macos" as const,
		fingerprintSha256,
		serial: name,
		issuedAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2099-01-01T00:00:00.000Z",
		revokedAt: null,
	});
	await saveDeviceRegistry(registry, { version: 1, devices: [device("laptop", deviceA), device("phone", deviceB)] });
	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: {
			...sandboxServerEnv(home, {
				PI_WEB_PORT: String(port),
				PI_WEB_TRUST_PROXY: "1",
				PI_WEB_SECURE_MODE: "1",
				PI_WEB_DEVICE_REGISTRY: registry,
				PI_WEB_ALLOWED_ORIGINS: REMOTE_ORIGIN,
				PI_WEB_TERMINALS: "off",
			}),
			PI_WEB_HOME: home,
		},
	});
	procs.push(proc);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const healthy = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1_000) }).then(
			(res) => res.ok,
			() => false,
		);
		if (healthy) return port;
		await Bun.sleep(50);
	}
	throw new Error("server did not become healthy");
}

interface Browser {
	device: string;
	cookie: string;
}

interface Site {
	host: string;
	origin: string;
	rpId: string;
}

const remote: Site = { host: REMOTE_HOST, origin: REMOTE_ORIGIN, rpId: "pi.example.test" };
const loopback = (port: number): Site => ({ host: `localhost:${String(port)}`, origin: `http://localhost:${String(port)}`, rpId: "localhost" });

interface Issued {
	challengeId: string;
	challenge: string;
	site: Site;
}

const signUpAt = (key: Authenticator, c: Issued) => registration(key, c.challenge, c.site.rpId, c.site.origin);
const signInAt = (key: Authenticator, c: Issued) => assertion(key, c.challenge, c.site.rpId, c.site.origin);

/**
 * Requests the way the mTLS proxy hands them on: the verified device's fingerprint, https, the browser's host and origin.
 * The loopback site is a process on this host, which comes in directly: no forwarding header.
 */
function client(port: number) {
	const call = async (path: string, as: Browser, site: Site, body?: unknown) => {
		const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
			method: body === undefined ? "GET" : "POST",
			signal: AbortSignal.timeout(5_000),
			headers: {
				host: site.host,
				origin: site.origin,
				"content-type": "application/json",
				...(site.rpId === "localhost" ? {} : { "x-forwarded-proto": "https" }),
				[CERT_HEADER]: as.device,
				...(as.cookie ? { cookie: as.cookie } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const setCookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
		return { status: res.status, body: (await res.json()) as Record<string, unknown>, setCookie };
	};
	const browser = async (device: string): Promise<Browser> => {
		const res = await call("/api/client", { device, cookie: "" }, remote, {});
		expect(res.status).toBe(200);
		return { device, cookie: res.setCookie };
	};
	const challenge = async (kind: "register" | "authenticate", as: Browser, site: Site): Promise<Issued> => {
		const res = await call("/api/faceid/challenge", as, site, { kind });
		expect(res.status).toBe(200);
		const body = res.body as { challengeId: string; options: { challenge: string } };
		return { challengeId: body.challengeId, challenge: body.options.challenge, site };
	};
	/** Presents an answer to a challenge as a browser, at a site (the challenge's own by default). */
	const verify = (c: Issued, credential: unknown, as: Browser, site = c.site) =>
		call("/api/faceid/verify", as, site, { challengeId: c.challengeId, credential });
	return { call, browser, challenge, verify };
}

describe("face id challenge binding over http (secure mode)", () => {
	test("device B's registration challenge from before the owner enrolled doesn't add a passkey after", async () => {
		const { call, browser, challenge, verify } = client(await secureServer());
		const laptopBrowser = await browser(deviceA);
		const phoneBrowser = await browser(deviceB);
		const owner = authenticator();
		const latecomer = authenticator();

		expect((await call("/api/repos", phoneBrowser, remote)).status).toBe(401);
		const ownerChallenge = await challenge("register", laptopBrowser, remote);
		const pending = await challenge("register", phoneBrowser, remote);
		expect((await verify(ownerChallenge, signUpAt(owner, ownerChallenge), laptopBrowser)).status).toBe(200);
		expect((await call("/api/faceid/challenge", phoneBrowser, remote, { kind: "register" })).status).toBe(403);

		const late = await verify(pending, signUpAt(latecomer, pending), phoneBrowser);
		expect([late.status, late.body.error]).toEqual([400, "faceid_already_enrolled"]);
		expect((await call("/api/faceid/status", phoneBrowser, remote)).body.credentialCount).toBe(1);

		const auth = await challenge("authenticate", phoneBrowser, remote);
		const attempt = await verify(auth, signInAt(latecomer, auth), phoneBrowser);
		expect([attempt.status, attempt.setCookie]).toEqual([400, ""]);
		expect((await call("/api/repos", phoneBrowser, remote)).status).toBe(401);
	});

	test("device B presenting device A's challenge gets no cookie, and the challenge is spent", async () => {
		const { call, browser, challenge, verify } = client(await secureServer());
		const laptopBrowser = await browser(deviceA);
		const phoneBrowser = await browser(deviceB);
		const owner = authenticator();
		const enroll = await challenge("register", laptopBrowser, remote);
		expect((await verify(enroll, signUpAt(owner, enroll), laptopBrowser)).status).toBe(200);

		const mine = await challenge("authenticate", laptopBrowser, remote);
		const answer = signInAt(owner, mine);
		const stolen = await verify(mine, answer, phoneBrowser);
		expect([stolen.status, stolen.body.error, stolen.setCookie]).toEqual([400, "challenge_mismatch", ""]);
		expect((await verify(mine, answer, laptopBrowser)).body.error).toBe("challenge_expired");

		const fresh = await challenge("authenticate", laptopBrowser, remote);
		const passed = await verify(fresh, signInAt(owner, fresh), laptopBrowser);
		expect(passed.status).toBe(200);
		expect(passed.setCookie).toStartWith("pi_web_faceid=");
		const unlocked = { ...laptopBrowser, cookie: `${laptopBrowser.cookie}; ${passed.setCookie}` };
		expect((await call("/api/repos", unlocked, remote)).status).toBe(200);
		expect((await call("/api/faceid/challenge", { device: deviceA, cookie: "" }, remote, { kind: "authenticate" })).status).toBe(401);
	});

	test("a challenge from the loopback RP or another browser on the same device doesn't verify at the remote host", async () => {
		const port = await secureServer();
		const { browser, challenge, verify } = client(port);
		const local = loopback(port);
		const laptopBrowser = await browser(deviceA);
		const secondTab = await browser(deviceA);
		const phoneBrowser = await browser(deviceB);
		const localKey = authenticator();
		const enroll = await challenge("register", laptopBrowser, local);
		expect((await verify(enroll, signUpAt(localKey, enroll), laptopBrowser)).status).toBe(200);

		const remoteHostLocalOrigin = { ...remote, origin: local.origin };
		for (const [as, site] of [
			[laptopBrowser, remoteHostLocalOrigin],
			[phoneBrowser, remoteHostLocalOrigin],
			[secondTab, local],
		] as const) {
			const c = await challenge("authenticate", laptopBrowser, local);
			const res = await verify(c, signInAt(localKey, c), as, site);
			expect([res.status, res.body.error, res.setCookie]).toEqual([400, "challenge_mismatch", ""]);
		}

		const c = await challenge("authenticate", laptopBrowser, local);
		expect((await verify(c, signInAt(localKey, c), laptopBrowser)).status).toBe(200);
	});
});
