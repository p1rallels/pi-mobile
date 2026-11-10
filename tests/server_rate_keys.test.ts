import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveDeviceRegistry } from "../src/device-registry.ts";
import { FaceIdService, MAX_PENDING_CHALLENGES_PER_REQUESTER } from "../src/faceid.ts";
import { proxyAddedAddress, requesterKey } from "../src/requester-key.ts";
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

async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(await realpath(tmpdir()), "pi-web-rate-keys-"));
	tempDirs.push(home);
	return home;
}

async function startServer(home: string, port: number, env: Record<string, string>): Promise<Bun.Subprocess> {
	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server.ts"],
		stdout: "pipe",
		stderr: "pipe",
		env: { ...sandboxServerEnv(home, { PI_WEB_PORT: String(port) }), PI_WEB_HOME: home, ...env },
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

const deviceA = "aa".repeat(32);
const deviceB = "bb".repeat(32);

async function deviceRegistry(home: string): Promise<string> {
	const path = join(home, "devices.json");
	const device = (name: string, fingerprintSha256: string) => ({
		name,
		platform: "macos" as const,
		fingerprintSha256,
		serial: name,
		issuedAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2099-01-01T00:00:00.000Z",
		revokedAt: null,
	});
	await saveDeviceRegistry(path, { version: 1, devices: [device("laptop", deviceA), device("phone", deviceB)] });
	return path;
}

/** POSTs Face ID challenges the way the trusted proxy would hand them on, with whatever headers the client added. */
function challenger(port: number) {
	const base = `http://127.0.0.1:${String(port)}`;
	return async (headers: Record<string, string>): Promise<number> => {
		const res = await fetch(`${base}/api/faceid/challenge`, {
			method: "POST",
			headers: { origin: base, "content-type": "application/json", "x-forwarded-proto": "https", ...headers },
			body: JSON.stringify({ kind: "register" }),
		});
		await res.arrayBuffer();
		return res.status;
	};
}

describe("rate limit keys behind the trusted proxy", () => {
	test("rotating Cf-Connecting-Ip and the first X-Forwarded-For entry doesn't dodge a limit", async () => {
		const home = await tempHome();
		const port = await freePort();
		await startServer(home, port, { PI_WEB_TRUST_PROXY: "1" });
		const challenge = challenger(port);

		const statuses: number[] = [];
		for (let i = 0; i < 13; i += 1) {
			statuses.push(await challenge({ "cf-connecting-ip": `spoof-${String(i)}`, "x-forwarded-for": `10.9.0.${String(i)}, 100.64.0.9` }));
		}
		expect(statuses.slice(0, 12)).not.toContain(429);
		expect(statuses[12]).toBe(429);
		expect(await challenge({ "x-forwarded-for": "100.64.0.9" })).toBe(429);
		expect(await challenge({ "x-forwarded-for": "100.64.0.10" })).not.toBe(429);
	});

	test("in secure mode the verified device is the key, whatever address or headers it comes with", async () => {
		const home = await tempHome();
		const port = await freePort();
		await startServer(home, port, {
			PI_WEB_TRUST_PROXY: "1",
			PI_WEB_SECURE_MODE: "1",
			PI_WEB_DEVICE_REGISTRY: await deviceRegistry(home),
		});
		const challenge = challenger(port);
		const cert = "x-pi-web-client-cert-fingerprint";

		const statuses: number[] = [];
		for (let i = 0; i < 13; i += 1) {
			statuses.push(await challenge({ [cert]: deviceA, "cf-connecting-ip": `spoof-${String(i)}`, "x-forwarded-for": `100.64.0.${String(i + 1)}` }));
		}
		expect(statuses.slice(0, 12)).not.toContain(429);
		expect(statuses[12]).toBe(429);
		expect(await challenge({ [cert]: deviceB, "x-forwarded-for": "100.64.0.1" })).not.toBe(429);
	});
});

describe("requester key", () => {
	const signals = { device: null, trustProxy: true, forwardedFor: null, peerAddress: "127.0.0.1" };

	test("reads only the X-Forwarded-For entry the proxy added", () => {
		expect(proxyAddedAddress("100.64.0.9")).toBe("100.64.0.9");
		expect(proxyAddedAddress("6.6.6.6, 10.0.0.1,100.64.0.9 ")).toBe("100.64.0.9");
		expect(proxyAddedAddress("fd7a:115c:a1e0::9")).toBe("fd7a:115c:a1e0::9");
		expect(proxyAddedAddress("6.6.6.6, ")).toBeNull();
		expect(proxyAddedAddress("")).toBeNull();
		expect(proxyAddedAddress(null)).toBeNull();
	});

	test("a verified device keys its own limits, whatever address it comes from", () => {
		expect(requesterKey({ ...signals, device: "ab12", forwardedFor: "100.64.0.9" })).toBe("device:ab12");
		expect(requesterKey({ ...signals, device: "ab12", trustProxy: false })).toBe("device:ab12");
	});

	test("behind the trusted proxy, the address the proxy saw", () => {
		expect(requesterKey({ ...signals, forwardedFor: "spoof, 6.6.6.6, 100.64.0.9" })).toBe("ip:100.64.0.9");
		expect(requesterKey({ ...signals, forwardedFor: null })).toBe("ip:127.0.0.1");
		expect(requesterKey({ ...signals, forwardedFor: " , " })).toBe("ip:127.0.0.1");
	});

	test("without a trusted proxy, only the TCP peer", () => {
		expect(requesterKey({ ...signals, trustProxy: false, forwardedFor: "100.64.0.9" })).toBe("ip:127.0.0.1");
		expect(requesterKey({ ...signals, trustProxy: false, peerAddress: undefined })).toBe("__unknown__");
		expect(requesterKey({ ...signals, trustProxy: false, peerAddress: "" })).toBe("__unknown__");
	});
});

describe("pending face id challenges per requester", () => {
	test("a requester past its cap drops its own oldest challenge and leaves everyone else's", async () => {
		const faceId = new FaceIdService(join(await tempHome(), "faceid.json"));
		const asker = { clientId: "browser", device: null };
		const create = (requester: string) => faceId.createChallenge("register", "pi.example.test", "https://pi.example.test", requester, asker);

		const other = await create("device:other");
		const mine: string[] = [];
		for (let i = 0; i < MAX_PENDING_CHALLENGES_PER_REQUESTER + 2; i += 1) mine.push((await create("device:mine")).challengeId);

		const pending = async (challengeId: string) =>
			faceId.verify(challengeId, null, { ...asker, rpId: "pi.example.test", origin: "https://pi.example.test" }).then(
				() => "verified",
				(error: Error) => (error.message === "challenge_expired" ? "gone" : "pending"),
			);
		expect(await pending(mine[0]!)).toBe("gone");
		expect(await pending(mine[1]!)).toBe("gone");
		expect(await pending(mine[2]!)).toBe("pending");
		expect(await pending(mine.at(-1)!)).toBe("pending");
		expect(await pending(other.challengeId)).toBe("pending");
	});
});
