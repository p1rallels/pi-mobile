import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { activeDevices, expiredDevices, expiringDevices, loadDeviceRegistry } from "./device-registry.ts";
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

async function inspectCaddyfile(path: string, config: PiWebConfig): Promise<DoctorCheck[]> {
	const text = await readFile(path, "utf8").catch(() => "");
	if (!text) return [];
	const checks: DoctorCheck[] = [];
	checks.push(/\bclient_auth\b/.test(text) ? check("caddy.mtls", "ok", "caddyfile has client_auth block") : check("caddy.mtls", "error", "caddyfile is missing client_auth block"));
	checks.push(/\bmode\s+require_and_verify\b/.test(text) ? check("caddy.mtls.mode", "ok", "caddyfile requires verified client certificates") : check("caddy.mtls.mode", "error", "caddyfile does not require verified client certificates"));
	checks.push(text.includes("trusted_ca_cert_file") ? check("caddy.mtls.ca", "ok", "caddyfile pins a trusted client CA") : check("caddy.mtls.ca", "error", "caddyfile is missing trusted_ca_cert_file"));
	checks.push(text.includes(`reverse_proxy 127.0.0.1:${String(config.port)}`) ? check("caddy.proxy.localhost", "ok", "caddyfile proxies only to localhost pi-web") : check("caddy.proxy.localhost", "error", "caddyfile must reverse_proxy to localhost pi-web"));
	checks.push(text.includes("X-PI-Web-Client-Cert-Fingerprint") ? check("caddy.cert.header", "ok", "caddyfile forwards client certificate fingerprint") : check("caddy.cert.header", "error", "caddyfile must forward client certificate fingerprint"));
	return checks;
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
		if (caddyfileExists) {
			checks.push(...(await inspectCaddyfile(config.caddy.caddyfile, config)));
		}
		if (config.caddy.serverCert || config.caddy.serverKey) {
			if (!config.caddy.serverCert || !config.caddy.serverKey) {
				checks.push(check("caddy.server.tls", "error", "server cert and server key must be configured together"));
			} else {
				checks.push(existsSync(config.caddy.serverCert) ? check("caddy.server.cert", "ok", `server cert found: ${config.caddy.serverCert}`) : check("caddy.server.cert", "error", `server cert missing: ${config.caddy.serverCert}`));
				checks.push(await checkPrivateFile(config.caddy.serverKey, "caddy.server.key"));
			}
		} else if (config.secureMode) {
			checks.push(check("caddy.server.tls", "warn", "caddyfile uses tls internal; mobile devices must trust Caddy's local CA or you should configure a trusted server cert"));
		}
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
	const expired = expiredDevices(registry);
	const expiring = expiringDevices(registry, 30);
	if (config.secureMode) {
		checks.push(active.length > 0 ? check("devices.active", "ok", `${String(active.length)} active device(s) allowed`) : check("devices.active", "warn", "no active devices are allowed yet"));
	}
	if (expired.length > 0) {
		checks.push(check("devices.expired", "error", `${String(expired.length)} device certificate(s) expired: ${expired.map((device) => device.name).join(", ")}`));
	}
	if (expiring.length > 0) {
		checks.push(check("devices.expiring", "warn", `${String(expiring.length)} device certificate(s) expire within 30 days: ${expiring.map((device) => device.name).join(", ")}`));
	}

	return checks;
}

export function hasDoctorErrors(checks: DoctorCheck[]): boolean {
	return checks.some((entry) => entry.level === "error");
}
