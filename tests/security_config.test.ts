import { describe, expect, test } from "bun:test";
import { buildCaddyfile } from "../src/caddy-config.ts";
import { emptyDeviceRegistry, isDeviceAllowed, normalizeFingerprint, type DeviceRecord } from "../src/device-registry.ts";
import { createSecureConfig, resolvePiWebPaths } from "../src/security-config.ts";

const fingerprint = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const normalized = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

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

	test("creates secure config and caddy mtls proxy config", () => {
		const paths = resolvePiWebPaths("/tmp/pi-web-test");
		const config = createSecureConfig(paths, {
			domain: "pi.example.test",
			listenHost: "100.64.0.1",
			listenPort: 443,
		});
		expect(config.secureMode).toBe(true);
		expect(config.host).toBe("127.0.0.1");
		expect(config.publicOrigins).toEqual(["https://pi.example.test"]);
		const caddyfile = buildCaddyfile(config);
		expect(caddyfile).toContain("client_auth");
		expect(caddyfile).toContain("mode require_and_verify");
		expect(caddyfile).toContain("reverse_proxy 127.0.0.1:4317");
		expect(caddyfile).toContain("X-PI-Web-Client-Cert-Fingerprint");
	});
});
