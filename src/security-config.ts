import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";

export type DevicePlatform = "ios" | "android" | "macos" | "windows" | "linux" | "other";

export interface PiWebPaths {
	home: string;
	configPath: string;
	devicesPath: string;
	mtlsRoot: string;
	caDir: string;
	devicesDir: string;
	caddyDir: string;
	caddyfilePath: string;
}

export interface PiWebConfig {
	version: 1;
	host: string;
	port: number;
	publicOrigins: string[];
	secureMode: boolean;
	caddy: {
		enabled: boolean;
		domain: string | null;
		listenHost: string;
		listenPort: number;
		caddyfile: string;
		clientCaCert: string;
	};
	tailscale: {
		required: boolean;
	};
}

export function resolvePiWebHome(raw = process.env.PI_WEB_HOME): string {
	const value = raw && raw.trim() ? raw.trim() : join(homedir(), ".pi-web");
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homedir(), value.slice(2));
	return resolve(value);
}

export function resolvePiWebPaths(home = resolvePiWebHome()): PiWebPaths {
	const root = resolve(home);
	const mtlsRoot = join(root, "mtls");
	const caDir = join(mtlsRoot, "ca");
	const devicesDir = join(mtlsRoot, "devices");
	const caddyDir = join(root, "caddy");
	return {
		home: root,
		configPath: join(root, "config.json"),
		devicesPath: join(root, "devices.json"),
		mtlsRoot,
		caDir,
		devicesDir,
		caddyDir,
		caddyfilePath: join(caddyDir, "Caddyfile"),
	};
}

export async function ensurePiWebDirs(paths: PiWebPaths): Promise<void> {
	for (const dir of [paths.home, paths.mtlsRoot, paths.caDir, paths.devicesDir, paths.caddyDir]) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700).catch(() => undefined);
	}
}

export function isLoopbackBindHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized.startsWith("127.");
}

export function normalizeOrigin(input: string): string {
	const parsed = new URL(input.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported origin protocol: ${parsed.protocol}`);
	}
	return parsed.origin;
}

export function defaultPublicOrigin(config: Pick<PiWebConfig, "caddy">): string | null {
	const domain = config.caddy.domain?.trim();
	if (!domain) return null;
	const port = config.caddy.listenPort === 443 ? "" : `:${String(config.caddy.listenPort)}`;
	return `https://${domain}${port}`;
}

export function defaultPiWebConfig(paths: PiWebPaths, input: Partial<PiWebConfig> = {}): PiWebConfig {
	const caddy = {
		enabled: input.caddy?.enabled ?? false,
		domain: input.caddy?.domain ?? null,
		listenHost: input.caddy?.listenHost ?? "127.0.0.1",
		listenPort: input.caddy?.listenPort ?? 8443,
		caddyfile: input.caddy?.caddyfile ?? paths.caddyfilePath,
		clientCaCert: input.caddy?.clientCaCert ?? join(paths.caDir, "client-ca.crt"),
	};
	const origin = defaultPublicOrigin({ caddy });
	return {
		version: 1,
		host: input.host ?? "127.0.0.1",
		port: input.port ?? 4317,
		publicOrigins: input.publicOrigins ?? (origin ? [normalizeOrigin(origin)] : []),
		secureMode: input.secureMode ?? false,
		caddy,
		tailscale: {
			required: input.tailscale?.required ?? false,
		},
	};
}

function readString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readNullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readPort(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : fallback;
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
	return parsed;
}

export function parsePiWebConfig(raw: unknown, paths: PiWebPaths): PiWebConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid config: ${paths.configPath}`);
	}
	const input = raw as Record<string, unknown>;
	const caddyInput = input.caddy && typeof input.caddy === "object" && !Array.isArray(input.caddy) ? (input.caddy as Record<string, unknown>) : {};
	const tailscaleInput = input.tailscale && typeof input.tailscale === "object" && !Array.isArray(input.tailscale) ? (input.tailscale as Record<string, unknown>) : {};
	const base = defaultPiWebConfig(paths);
	return defaultPiWebConfig(paths, {
		version: 1,
		host: readString(input.host, base.host),
		port: readPort(input.port, base.port),
		publicOrigins: Array.isArray(input.publicOrigins) ? input.publicOrigins.filter((origin) => typeof origin === "string").map((origin) => normalizeOrigin(origin)) : base.publicOrigins,
		secureMode: readBoolean(input.secureMode, base.secureMode),
		caddy: {
			enabled: readBoolean(caddyInput.enabled, base.caddy.enabled),
			domain: readNullableString(caddyInput.domain),
			listenHost: readString(caddyInput.listenHost, base.caddy.listenHost),
			listenPort: readPort(caddyInput.listenPort, base.caddy.listenPort),
			caddyfile: readString(caddyInput.caddyfile, base.caddy.caddyfile),
			clientCaCert: readString(caddyInput.clientCaCert, base.caddy.clientCaCert),
		},
		tailscale: {
			required: readBoolean(tailscaleInput.required, base.tailscale.required),
		},
	});
}

export async function loadPiWebConfig(paths: PiWebPaths): Promise<PiWebConfig | null> {
	try {
		return parsePiWebConfig(await readPrivateJsonFile<unknown>(paths.configPath), paths);
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw error;
	}
}

export async function savePiWebConfig(paths: PiWebPaths, config: PiWebConfig): Promise<void> {
	await ensurePiWebDirs(paths);
	await writePrivateJsonFile(paths.configPath, config);
}

export function createSecureConfig(paths: PiWebPaths, input: { domain?: string | null; listenHost?: string; listenPort?: number; port?: number; tailscaleRequired?: boolean }): PiWebConfig {
	const listenPort = input.listenPort ?? 443;
	const domain = input.domain && input.domain.trim() ? input.domain.trim() : null;
	const publicOrigin = domain ? normalizeOrigin(`https://${domain}${listenPort === 443 ? "" : `:${String(listenPort)}`}`) : null;
	return defaultPiWebConfig(paths, {
		host: "127.0.0.1",
		port: input.port ?? 4317,
		secureMode: true,
		publicOrigins: publicOrigin ? [publicOrigin] : [],
		caddy: {
			enabled: true,
			domain,
			listenHost: input.listenHost ?? "127.0.0.1",
			listenPort,
			caddyfile: paths.caddyfilePath,
			clientCaCert: join(paths.caDir, "client-ca.crt"),
		},
		tailscale: {
			required: input.tailscaleRequired ?? true,
		},
	});
}

export function configExists(paths: PiWebPaths): boolean {
	return existsSync(paths.configPath);
}
