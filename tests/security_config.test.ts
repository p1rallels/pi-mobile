import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCaddyfile, writeCaddyfile } from "../src/caddy-config.ts";
import { emptyDeviceRegistry, expiredDevices, expiringDevices, isDeviceAllowed, normalizeFingerprint, type DeviceRecord } from "../src/device-registry.ts";
import { runDoctor } from "../src/doctor.ts";
import { createSecureConfig, ensurePiWebDirs, resolvePiWebPaths } from "../src/security-config.ts";

const fingerprint = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const normalized = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const tempDirs: string[] = [];

function device(input: Partial<DeviceRecord> = {}): DeviceRecord {
	return {
		name: "phone",
		platform: "ios",
		fingerprintSha256: normalized,
		serial: "01",
		issuedAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2027-01-01T00:00:00.000Z",
		revokedAt: null,
		...input,
	};
}

async function tempHome() {
	const tempRoot = await realpath(tmpdir());
	const dir = await mkdtemp(join(tempRoot, "pi-web-security-config-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		await rm(dir, { recursive: true, force: true });
	}
});

describe("security config", () => {
	test("normalizes mtls certificate fingerprints", () => {
		expect(normalizeFingerprint(fingerprint)).toBe(normalized);
		expect(normalizeFingerprint(`SHA256 Fingerprint=${fingerprint}`)).toBe(normalized);
		expect(normalizeFingerprint("nope")).toBeNull();
	});

	test("authorizes only active registered devices", () => {
		const registry = { ...emptyDeviceRegistry(), devices: [device()] };
		expect(isDeviceAllowed(registry, fingerprint, new Date("2026-06-01T00:00:00.000Z")).allowed).toBe(true);
		expect(isDeviceAllowed(registry, null).reason).toBe("missing_fingerprint");
		expect(isDeviceAllowed(registry, "00".repeat(32)).reason).toBe("unknown_device");
		expect(isDeviceAllowed({ ...registry, devices: [device({ revokedAt: "2026-02-01T00:00:00.000Z" })] }, fingerprint).reason).toBe("revoked");
		expect(isDeviceAllowed(registry, fingerprint, new Date("2028-01-01T00:00:00.000Z")).reason).toBe("expired");
	});

	test("classifies expired and expiring devices", () => {
		const registry = {
			...emptyDeviceRegistry(),
			devices: [
				device({ name: "expired", expiresAt: "2026-01-01T00:00:00.000Z" }),
				device({ name: "soon", expiresAt: "2026-06-15T00:00:00.000Z" }),
				device({ name: "later", expiresAt: "2026-12-01T00:00:00.000Z" }),
			],
		};
		const now = new Date("2026-06-01T00:00:00.000Z");
		expect(expiredDevices(registry, now).map((entry) => entry.name)).toEqual(["expired"]);
		expect(expiringDevices(registry, 30, now).map((entry) => entry.name)).toEqual(["soon"]);
	});

	test("creates secure config and caddy mtls proxy config", () => {
		const paths = resolvePiWebPaths("/private/tmp/pi-web-test");
		const config = createSecureConfig(paths, {
			domain: "pi.example.test",
			listenHost: "100.64.0.1",
			listenPort: 443,
		});
		expect(config.secureMode).toBe(true);
		expect(config.host).toBe("127.0.0.1");
		expect(config.publicOrigins).toEqual(["https://pi.example.test"]);
		const caddyfile = buildCaddyfile(config);
		expect(caddyfile).toContain("auto_https disable_redirects");
		expect(caddyfile).toContain("tls internal");
		expect(caddyfile).toContain("client_auth");
		expect(caddyfile).toContain("mode require_and_verify");
		expect(caddyfile).toContain("reverse_proxy 127.0.0.1:4317");
		expect(caddyfile).toContain("X-PI-Web-Client-Cert-Fingerprint");
	});

	test("uses configured trusted server certificate in caddy config", () => {
		const paths = resolvePiWebPaths("/private/tmp/pi-web-test");
		const config = createSecureConfig(paths, {
			domain: "pi.example.test",
			listenHost: "100.64.0.1",
			listenPort: 443,
			serverCert: "/certs/server.crt",
			serverKey: "/certs/server.key",
		});
		const caddyfile = buildCaddyfile(config);
		expect(caddyfile).toContain('tls "/certs/server.crt" "/certs/server.key"');
		expect(caddyfile).not.toContain("tls internal");
	});

	test("doctor fails closed when secure-mode caddyfile is missing", async () => {
		const paths = resolvePiWebPaths(await tempHome());
		const config = createSecureConfig(paths, {
			domain: "pi.example.test",
			listenHost: "127.0.0.1",
			listenPort: 8443,
			tailscaleRequired: false,
		});
		const checks = await runDoctor(paths, config);
		expect(checks.find((item) => item.id === "caddyfile.exists")?.level).toBe("error");
	});

	test("doctor statically verifies generated caddy mtls config", async () => {
		const paths = resolvePiWebPaths(await tempHome());
		await ensurePiWebDirs(paths);
		const config = createSecureConfig(paths, {
			domain: "pi.example.test",
			listenHost: "127.0.0.1",
			listenPort: 8443,
			tailscaleRequired: false,
		});
		await writeCaddyfile(paths, config);
		const checks = await runDoctor(paths, config);
		expect(checks.find((item) => item.id === "caddy.mtls")?.level).toBe("ok");
		expect(checks.find((item) => item.id === "caddy.mtls.mode")?.level).toBe("ok");
		expect(checks.find((item) => item.id === "caddy.proxy.localhost")?.level).toBe("ok");
		expect(checks.find((item) => item.id === "caddy.cert.header")?.level).toBe("ok");
	});
});
