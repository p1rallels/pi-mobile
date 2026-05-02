import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";
import type { DevicePlatform } from "./security-config.ts";

export interface DeviceRecord {
	name: string;
	platform: DevicePlatform;
	fingerprintSha256: string;
	serial: string;
	certPath?: string;
	p12Path?: string;
	issuedAt: string;
	expiresAt: string;
	revokedAt: string | null;
}

export interface DeviceRegistry {
	version: 1;
	devices: DeviceRecord[];
}

export interface DeviceAuthResult {
	allowed: boolean;
	reason: "allowed" | "missing_fingerprint" | "unknown_device" | "revoked" | "expired";
	device: DeviceRecord | null;
}

export function emptyDeviceRegistry(): DeviceRegistry {
	return { version: 1, devices: [] };
}

export function normalizeFingerprint(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const normalized = raw.trim().toLowerCase().replace(/^sha256 fingerprint=/, "").replace(/^sha256:/, "").replaceAll(":", "").replaceAll(" ", "");
	if (!/^[a-f0-9]{64}$/.test(normalized)) return null;
	return normalized;
}

export function parseDeviceRegistry(raw: unknown, path: string): DeviceRegistry {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid device registry: ${path}`);
	}
	const input = raw as Partial<DeviceRegistry>;
	if (input.version !== 1 || !Array.isArray(input.devices)) {
		throw new Error(`Invalid device registry: ${path}`);
	}
	return {
		version: 1,
		devices: input.devices.filter((device): device is DeviceRecord => {
			if (!device || typeof device !== "object") return false;
			const candidate = device as Partial<DeviceRecord>;
			return (
				typeof candidate.name === "string" &&
				typeof candidate.platform === "string" &&
				typeof candidate.fingerprintSha256 === "string" &&
				typeof candidate.serial === "string" &&
				typeof candidate.issuedAt === "string" &&
				typeof candidate.expiresAt === "string" &&
				(candidate.revokedAt === null || typeof candidate.revokedAt === "string")
			);
		}),
	};
}

export async function loadDeviceRegistry(path: string): Promise<DeviceRegistry> {
	try {
		return parseDeviceRegistry(await readPrivateJsonFile<unknown>(path), path);
	} catch (error) {
		if (isMissingFileError(error)) return emptyDeviceRegistry();
		throw error;
	}
}

export async function saveDeviceRegistry(path: string, registry: DeviceRegistry): Promise<void> {
	await writePrivateJsonFile(path, registry);
}

export async function upsertDevice(path: string, device: DeviceRecord): Promise<DeviceRegistry> {
	const registry = await loadDeviceRegistry(path);
	const fingerprint = normalizeFingerprint(device.fingerprintSha256);
	if (!fingerprint) throw new Error("invalid_device_fingerprint");
	const nextDevice = { ...device, fingerprintSha256: fingerprint };
	const devices = registry.devices.filter((entry) => entry.name !== device.name && normalizeFingerprint(entry.fingerprintSha256) !== fingerprint);
	devices.push(nextDevice);
	devices.sort((a, b) => a.name.localeCompare(b.name));
	const next = { version: 1 as const, devices };
	await saveDeviceRegistry(path, next);
	return next;
}

export async function revokeDevice(path: string, name: string, now = new Date()): Promise<DeviceRecord> {
	const registry = await loadDeviceRegistry(path);
	const idx = registry.devices.findIndex((device) => device.name === name);
	if (idx < 0) throw new Error(`device_not_found: ${name}`);
	const current = registry.devices[idx]!;
	const revoked = { ...current, revokedAt: current.revokedAt ?? now.toISOString() };
	registry.devices[idx] = revoked;
	await saveDeviceRegistry(path, registry);
	return revoked;
}

export function activeDevices(registry: DeviceRegistry, now = new Date()): DeviceRecord[] {
	return registry.devices.filter((device) => isDeviceAllowed(registry, device.fingerprintSha256, now).allowed);
}

export function expiredDevices(registry: DeviceRegistry, now = new Date()): DeviceRecord[] {
	return registry.devices.filter((device) => !device.revokedAt && Date.parse(device.expiresAt) <= now.getTime());
}

export function expiringDevices(registry: DeviceRegistry, days = 30, now = new Date()): DeviceRecord[] {
	const windowMs = days * 24 * 60 * 60 * 1000;
	return registry.devices.filter((device) => {
		if (device.revokedAt) return false;
		const expiresAtMs = Date.parse(device.expiresAt);
		return Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime() && expiresAtMs <= now.getTime() + windowMs;
	});
}

export function isDeviceAllowed(registry: DeviceRegistry, rawFingerprint: string | null | undefined, now = new Date()): DeviceAuthResult {
	const fingerprint = normalizeFingerprint(rawFingerprint);
	if (!fingerprint) return { allowed: false, reason: "missing_fingerprint", device: null };
	const device = registry.devices.find((entry) => normalizeFingerprint(entry.fingerprintSha256) === fingerprint) ?? null;
	if (!device) return { allowed: false, reason: "unknown_device", device: null };
	if (device.revokedAt) return { allowed: false, reason: "revoked", device };
	const expiresAtMs = Date.parse(device.expiresAt);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
		return { allowed: false, reason: "expired", device };
	}
	return { allowed: true, reason: "allowed", device };
}
