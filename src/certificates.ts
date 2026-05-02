import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DevicePlatform, PiWebPaths } from "./security-config.ts";
import { normalizeFingerprint, type DeviceRecord } from "./device-registry.ts";

export interface ClientCaResult {
	keyPath: string;
	certPath: string;
	created: boolean;
}

export interface IssuedDeviceCertificate {
	device: DeviceRecord;
	keyPath: string;
	certPath: string;
	p12Path: string;
	p12Password: string;
}

function decodeBytes(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes).trim();
}

function runOpenSsl(args: string[]): string {
	const proc = Bun.spawnSync({ cmd: ["openssl", ...args], stdout: "pipe", stderr: "pipe" });
	const stdout = decodeBytes(proc.stdout);
	const stderr = decodeBytes(proc.stderr);
	if (proc.exitCode !== 0) {
		throw new Error(`openssl ${args[0] ?? ""} failed: ${stderr || stdout || `exit ${String(proc.exitCode)}`}`);
	}
	return stdout;
}

function assertDeviceName(name: string): string {
	const trimmed = name.trim();
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(trimmed)) {
		throw new Error("Device name must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores.");
	}
	return trimmed;
}

function assertPlatform(platform: string): DevicePlatform {
	const allowed = new Set<DevicePlatform>(["ios", "android", "macos", "windows", "linux", "other"]);
	return allowed.has(platform as DevicePlatform) ? (platform as DevicePlatform) : "other";
}

function addDays(now: Date, days: number): Date {
	return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function safeDays(raw: number): number {
	if (!Number.isInteger(raw) || raw <= 0 || raw > 3980) throw new Error("invalid_certificate_days");
	return raw;
}

function serialHex(): string {
	return randomBytes(16).toString("hex");
}

export function generateP12Password(): string {
	return randomBytes(24).toString("base64url");
}

export function clientCaPaths(paths: PiWebPaths): { keyPath: string; certPath: string } {
	return {
		keyPath: join(paths.caDir, "client-ca.key"),
		certPath: join(paths.caDir, "client-ca.crt"),
	};
}

export async function ensureClientCa(paths: PiWebPaths): Promise<ClientCaResult> {
	await mkdir(paths.caDir, { recursive: true, mode: 0o700 });
	await chmod(paths.caDir, 0o700).catch(() => undefined);
	const { keyPath, certPath } = clientCaPaths(paths);
	if (existsSync(keyPath) && existsSync(certPath)) return { keyPath, certPath, created: false };
	if (existsSync(keyPath) || existsSync(certPath)) {
		throw new Error(`Incomplete client ca state in ${paths.caDir}`);
	}
	runOpenSsl(["ecparam", "-genkey", "-name", "prime256v1", "-out", keyPath]);
	await chmod(keyPath, 0o600).catch(() => undefined);
	runOpenSsl(["req", "-x509", "-new", "-sha256", "-days", "3650", "-key", keyPath, "-out", certPath, "-subj", "/CN=pi-web client ca"]);
	await chmod(certPath, 0o644).catch(() => undefined);
	return { keyPath, certPath, created: true };
}

function parseFingerprint(output: string): string {
	const raw = output.split("=").pop() ?? output;
	const fingerprint = normalizeFingerprint(raw);
	if (!fingerprint) throw new Error(`Invalid certificate fingerprint: ${output}`);
	return fingerprint;
}

function parseSerial(output: string): string {
	return (output.split("=").pop() ?? output).trim().toLowerCase();
}

export async function issueDeviceCertificate(input: {
	paths: PiWebPaths;
	name: string;
	platform: string;
	days?: number;
	p12Password?: string;
}): Promise<IssuedDeviceCertificate> {
	const name = assertDeviceName(input.name);
	const platform = assertPlatform(input.platform);
	const days = safeDays(input.days ?? 365);
	const p12Password = input.p12Password && input.p12Password.length >= 12 ? input.p12Password : generateP12Password();
	const ca = await ensureClientCa(input.paths);
	await mkdir(input.paths.devicesDir, { recursive: true, mode: 0o700 });
	await chmod(input.paths.devicesDir, 0o700).catch(() => undefined);

	const keyPath = join(input.paths.devicesDir, `${name}.key`);
	const csrPath = join(input.paths.devicesDir, `${name}.csr`);
	const certPath = join(input.paths.devicesDir, `${name}.crt`);
	const p12Path = join(input.paths.devicesDir, `${name}.p12`);
	const extPath = join(input.paths.devicesDir, `${name}.client.ext`);
	const passPath = join(input.paths.devicesDir, `${name}.${process.pid}.${Date.now()}.pass`);

	for (const path of [keyPath, csrPath, certPath, p12Path]) {
		if (existsSync(path)) throw new Error(`Device certificate file already exists: ${path}`);
	}

	try {
		await writeFile(extPath, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
		await writeFile(passPath, p12Password, { encoding: "utf8", mode: 0o600, flag: "wx" });
		runOpenSsl(["ecparam", "-genkey", "-name", "prime256v1", "-out", keyPath]);
		await chmod(keyPath, 0o600).catch(() => undefined);
		runOpenSsl(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=pi-web ${name}`]);
		runOpenSsl([
			"x509",
			"-req",
			"-sha256",
			"-days",
			String(days),
			"-in",
			csrPath,
			"-CA",
			ca.certPath,
			"-CAkey",
			ca.keyPath,
			"-set_serial",
			`0x${serialHex()}`,
			"-out",
			certPath,
			"-extfile",
			extPath,
		]);
		await chmod(certPath, 0o644).catch(() => undefined);
		runOpenSsl(["pkcs12", "-export", "-inkey", keyPath, "-in", certPath, "-certfile", ca.certPath, "-out", p12Path, "-name", `pi-web ${name}`, "-passout", `file:${passPath}`]);
		await chmod(p12Path, 0o600).catch(() => undefined);
	} finally {
		await rm(passPath, { force: true }).catch(() => undefined);
		await rm(extPath, { force: true }).catch(() => undefined);
		await rm(csrPath, { force: true }).catch(() => undefined);
	}

	const fingerprint = parseFingerprint(runOpenSsl(["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"]));
	const serial = parseSerial(runOpenSsl(["x509", "-in", certPath, "-noout", "-serial"]));
	const now = new Date();
	const device: DeviceRecord = {
		name,
		platform,
		fingerprintSha256: fingerprint,
		serial,
		certPath,
		p12Path,
		issuedAt: now.toISOString(),
		expiresAt: addDays(now, days).toISOString(),
		revokedAt: null,
	};
	return { device, keyPath, certPath, p12Path, p12Password };
}
