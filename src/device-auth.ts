import { isDeviceAllowed, loadDeviceRegistry, type DeviceRecord } from "./device-registry.ts";

export interface DeviceAuthOptions {
	registryPath: string;
	headerName: string;
}

export interface DeviceAuthStatus {
	ok: boolean;
	status: number;
	message: string;
	device: DeviceRecord | null;
}

export function isLoopbackRemoteAddress(address: string | null | undefined): boolean {
	if (!address) return false;
	const normalized = address.trim().toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "0:0:0:0:0:0:0:1" ||
		normalized.startsWith("127.") ||
		normalized.startsWith("::ffff:127.")
	);
}

export async function verifyClientCertificateRequest(req: Request, remoteAddress: string | null | undefined, options: DeviceAuthOptions): Promise<DeviceAuthStatus> {
	if (!isLoopbackRemoteAddress(remoteAddress)) {
		return { ok: false, status: 403, message: "Secure mode only accepts requests from the trusted local proxy.", device: null };
	}

	const fingerprint = req.headers.get(options.headerName);
	const registry = await loadDeviceRegistry(options.registryPath);
	const result = isDeviceAllowed(registry, fingerprint);
	if (result.allowed) {
		return { ok: true, status: 200, message: "ok", device: result.device };
	}

	if (result.reason === "missing_fingerprint") {
		return { ok: false, status: 401, message: "Client certificate required.", device: null };
	}
	if (result.reason === "revoked") {
		return { ok: false, status: 403, message: "Client certificate device has been revoked.", device: result.device };
	}
	if (result.reason === "expired") {
		return { ok: false, status: 403, message: "Client certificate device has expired.", device: result.device };
	}
	return { ok: false, status: 403, message: "Client certificate device is not allowed.", device: null };
}
