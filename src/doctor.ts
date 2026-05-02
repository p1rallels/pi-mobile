import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadDeviceRegistry, activeDevices } from "./device-registry.ts";
import { clientCaPaths } from "./certificates.ts";
import { configExists, isLoopbackBindHost, type PiWebConfig, type PiWebPaths } from "./security-config.ts";

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorCheck {
	id: string;
	level: DoctorLevel;
	message: string;
}

function check(id: string, level: DoctorLevel, message: string): DoctorCheck {
	return { id, level, message };
}

function commandExists(command: string): boolean {
	const proc = Bun.spawnSync({ cmd: ["/usr/bin/env", "sh", "-lc", `command -v ${command}`], stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0;
}

function commandOk(cmd: string[]): boolean {
	const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0;
}

async function fileMode(path: string): Promise<number | null> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch {
		return null;
	}
}

function modeIsPrivate(mode: number | null): boolean {
	return mode !== null && (mode & 0o077) === 0;
}

async function checkPrivateFile(path: string, id: string): Promise<DoctorCheck> {
	const mode = await fileMode(path);
	if (mode === null) return check(id, "error", `missing private file: ${path}`);
	if (!modeIsPrivate(mode)) return check(id, "warn", `private file is readable by group/others: ${path}`);
	return check(id, "ok", `private file permissions ok: ${path}`);
}

function hasTrackedSecretFiles(): boolean {
	if (!existsSync(join(process.cwd(), ".git"))) return false;
	const proc = Bun.spawnSync({ cmd: ["git", "ls-files"], stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) return false;
	const output = new TextDecoder().decode(proc.stdout);
	return output.split("\n").some((path) => /(^|\/)(\.tls|.*\.(key|pem|p12|pfx)|.*secret.*|.*token.*|.*credential.*)$/i.test(path));
}

export async function runDoctor(paths: PiWebPaths, config: PiWebConfig | null): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	checks.push(configExists(paths) ? check("config.exists", "ok", `config found: ${paths.configPath}`) : check("config.exists", "warn", `config not found: ${paths.configPath}`));
	checks.push(commandExists("openssl") ? check("openssl.exists", "ok", "openssl found") : check("openssl.exists", "error", "openssl not found"));
	checks.push(hasTrackedSecretFiles() ? check("git.secrets", "error", "git tracks secret-looking files") : check("git.secrets", "ok", "git does not track obvious key/cert secret files"));

	if (!config) return checks;

	if (config.secureMode) {
		checks.push(isLoopbackBindHost(config.host) ? check("bind.loopback", "ok", `pi-web binds to ${config.host}`) : check("bind.loopback", "error", `secure mode must bind pi-web to localhost, got ${config.host}`));
		checks.push(config.caddy.enabled ? check("caddy.enabled", "ok", "caddy is enabled") : check("caddy.enabled", "error", "secure mode requires caddy mtls front door"));
		checks.push(config.publicOrigins.length > 0 ? check("origins.configured", "ok", `public origins: ${config.publicOrigins.join(", ")}`) : check("origins.configured", "warn", "no public origins configured"));
	} else {
		checks.push(check("secure.mode", "warn", "secure mode is disabled"));
	}

	if (config.caddy.enabled) {
		const caddyExists = commandExists("caddy");
		const caddyfileExists = existsSync(config.caddy.caddyfile);
		checks.push(caddyExists ? check("caddy.exists", "ok", "caddy found") : check("caddy.exists", config.secureMode ? "error" : "warn", "caddy not found in PATH"));
		checks.push(caddyfileExists ? check("caddyfile.exists", "ok", `caddyfile found: ${config.caddy.caddyfile}`) : check("caddyfile.exists", config.secureMode ? "error" : "warn", `caddyfile not found: ${config.caddy.caddyfile}`));
		if (caddyfileExists && caddyExists) {
			checks.push(commandOk(["caddy", "validate", "--config", config.caddy.caddyfile]) ? check("caddyfile.valid", "ok", "caddyfile validates") : check("caddyfile.valid", "error", "caddyfile validation failed"));
		}
	}

	if (config.tailscale.required) {
		checks.push(commandExists("tailscale") ? check("tailscale.exists", "ok", "tailscale found") : check("tailscale.exists", "warn", "tailscale not found in PATH"));
		if (commandExists("tailscale")) {
			checks.push(commandOk(["tailscale", "status", "--self"]) ? check("tailscale.status", "ok", "tailscale is connected") : check("tailscale.status", "warn", "tailscale status check failed"));
		}
	}

	const ca = clientCaPaths(paths);
	if (config.secureMode || config.caddy.enabled) {
		checks.push(await checkPrivateFile(ca.keyPath, "ca.key"));
		checks.push(existsSync(ca.certPath) ? check("ca.cert", "ok", `client ca cert found: ${ca.certPath}`) : check("ca.cert", "error", `client ca cert missing: ${ca.certPath}`));
	}

	const registry = await loadDeviceRegistry(paths.devicesPath);
	const active = activeDevices(registry);
	if (config.secureMode) {
		checks.push(active.length > 0 ? check("devices.active", "ok", `${String(active.length)} active device(s) allowed`) : check("devices.active", "warn", "no active devices are allowed yet"));
	}

	return checks;
}

export function hasDoctorErrors(checks: DoctorCheck[]): boolean {
	return checks.some((entry) => entry.level === "error");
}
