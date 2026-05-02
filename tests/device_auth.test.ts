import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveDeviceRegistry } from "../src/device-registry.ts";
import { verifyClientCertificateRequest } from "../src/device-auth.ts";

const tempDirs: string[] = [];
const fingerprint = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

async function registryPath() {
	const tempRoot = await realpath(tmpdir());
	const dir = await mkdtemp(join(tempRoot, "pi-web-device-auth-"));
	tempDirs.push(dir);
	const path = join(dir, "devices.json");
	await saveDeviceRegistry(path, {
		version: 1,
		devices: [
			{
				name: "laptop",
				platform: "macos",
				fingerprintSha256: fingerprint,
				serial: "01",
				issuedAt: "2026-01-01T00:00:00.000Z",
				expiresAt: "2027-01-01T00:00:00.000Z",
				revokedAt: null,
			},
		],
	});
	return path;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		await rm(dir, { recursive: true, force: true });
	}
});

describe("device auth", () => {
	test("requires a trusted local proxy", async () => {
		const path = await registryPath();
		const req = new Request("http://localhost/", { headers: { "x-device": fingerprint } });
		const result = await verifyClientCertificateRequest(req, "100.64.0.2", { registryPath: path, headerName: "x-device" });
		expect(result.ok).toBe(false);
		expect(result.status).toBe(403);
	});

	test("requires a registered fingerprint", async () => {
		const path = await registryPath();
		const missing = await verifyClientCertificateRequest(new Request("http://localhost/"), "127.0.0.1", { registryPath: path, headerName: "x-device" });
		expect(missing.ok).toBe(false);
		expect(missing.status).toBe(401);
		const allowed = await verifyClientCertificateRequest(new Request("http://localhost/", { headers: { "x-device": fingerprint } }), "::1", {
			registryPath: path,
			headerName: "x-device",
		});
		expect(allowed.ok).toBe(true);
		expect(allowed.device?.name).toBe("laptop");
	});
});
