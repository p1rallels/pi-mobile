#!/usr/bin/env bun
import { emptyDeviceRegistry, loadDeviceRegistry, revokeDevice, saveDeviceRegistry, upsertDevice } from "./device-registry.ts";
import { ensureClientCa, issueDeviceCertificate } from "./certificates.ts";
import { writeCaddyfile } from "./caddy-config.ts";
import { hasDoctorErrors, runDoctor, type DoctorCheck } from "./doctor.ts";
import { createSecureConfig, defaultPiWebConfig, ensurePiWebDirs, loadPiWebConfig, resolvePiWebPaths, savePiWebConfig, type PiWebConfig } from "./security-config.ts";

interface ParsedArgs {
	positionals: string[];
	flags: Map<string, string | true>;
}

function usage(): string {
	return `pi-web

Usage:
  pi-web start
  pi-web doctor
  pi-web secure init [--domain <domain>] [--listen-host <host>] [--listen-port <port>] [--port <port>]
  pi-web device issue <name> [--platform ios|android|macos|windows|linux|other] [--days <days>]
  pi-web device list
  pi-web device revoke <name>

Env:
  PI_WEB_HOME   defaults to ~/.pi-web
`;
}

function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			flags.set(key, next);
			i += 1;
		} else {
			flags.set(key, true);
		}
	}
	return { positionals, flags };
}

function flagString(flags: Map<string, string | true>, key: string): string | null {
	const value = flags.get(key);
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function flagInt(flags: Map<string, string | true>, key: string, fallback: number): number {
	const value = flagString(flags, key);
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed)) throw new Error(`Invalid --${key}: ${value}`);
	return parsed;
}

function printChecks(checks: DoctorCheck[]): void {
	for (const item of checks) {
		const label = item.level === "ok" ? "ok" : item.level === "warn" ? "warn" : "error";
		console.log(`${label.padEnd(5)} ${item.id.padEnd(22)} ${item.message}`);
	}
}

function runSync(cmd: string[]): { ok: boolean; stdout: string; stderr: string } {
	const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
	const stdout = new TextDecoder().decode(proc.stdout).trim();
	const stderr = new TextDecoder().decode(proc.stderr).trim();
	return { ok: proc.exitCode === 0, stdout, stderr };
}

function detectTailscaleHost(): { ip: string | null; dnsName: string | null } {
	const ip = runSync(["tailscale", "ip", "-4"]);
	const status = runSync(["tailscale", "status", "--self", "--json"]);
	let dnsName: string | null = null;
	if (status.ok && status.stdout) {
		try {
			const parsed = JSON.parse(status.stdout) as { Self?: { DNSName?: unknown } };
			const raw = parsed.Self?.DNSName;
			if (typeof raw === "string" && raw.trim()) dnsName = raw.trim().replace(/\.$/, "");
		} catch {
			dnsName = null;
		}
	}
	return { ip: ip.ok && ip.stdout ? ip.stdout.split("\n")[0]!.trim() : null, dnsName };
}

async function commandSecureInit(args: ParsedArgs): Promise<void> {
	const paths = resolvePiWebPaths();
	await ensurePiWebDirs(paths);
	const detected = detectTailscaleHost();
	const domain = flagString(args.flags, "domain") ?? detected.dnsName;
	const listenHost = flagString(args.flags, "listen-host") ?? detected.ip ?? "127.0.0.1";
	const listenPort = flagInt(args.flags, "listen-port", 443);
	const port = flagInt(args.flags, "port", 4317);
	const config = createSecureConfig(paths, { domain, listenHost, listenPort, port, tailscaleRequired: Boolean(detected.ip || detected.dnsName) });
	await savePiWebConfig(paths, config);
	const ca = await ensureClientCa(paths);
	if (!(await loadDeviceRegistry(paths.devicesPath)).devices.length) {
		await saveDeviceRegistry(paths.devicesPath, emptyDeviceRegistry());
	}
	await writeCaddyfile(paths, config);
	console.log(`config: ${paths.configPath}`);
	console.log(`client ca: ${ca.certPath}${ca.created ? " (created)" : ""}`);
	console.log(`caddyfile: ${paths.caddyfilePath}`);
	if (config.publicOrigins.length > 0) console.log(`url: ${config.publicOrigins[0]}`);
	console.log("next: pi-web device issue <name> --platform ios|android|macos|windows|linux");
}

async function commandDoctor(): Promise<void> {
	const paths = resolvePiWebPaths();
	const config = await loadPiWebConfig(paths);
	const checks = await runDoctor(paths, config);
	printChecks(checks);
	if (hasDoctorErrors(checks)) process.exit(1);
}

async function commandDeviceIssue(args: ParsedArgs): Promise<void> {
	const name = args.positionals[2];
	if (!name) throw new Error("Missing device name.");
	const paths = resolvePiWebPaths();
	await ensurePiWebDirs(paths);
	const issued = await issueDeviceCertificate({
		paths,
		name,
		platform: flagString(args.flags, "platform") ?? "other",
		days: flagInt(args.flags, "days", 365),
	});
	await upsertDevice(paths.devicesPath, issued.device);
	console.log(`device: ${issued.device.name}`);
	console.log(`platform: ${issued.device.platform}`);
	console.log(`fingerprint: ${issued.device.fingerprintSha256}`);
	console.log(`p12: ${issued.p12Path}`);
	console.log(`p12 password: ${issued.p12Password}`);
	console.log("install the .p12 on the target device, then remove temporary transfer copies.");
}

async function commandDeviceList(): Promise<void> {
	const paths = resolvePiWebPaths();
	const registry = await loadDeviceRegistry(paths.devicesPath);
	if (registry.devices.length === 0) {
		console.log("no devices");
		return;
	}
	for (const device of registry.devices) {
		const status = device.revokedAt ? `revoked ${device.revokedAt}` : Date.parse(device.expiresAt) <= Date.now() ? "expired" : "active";
		console.log(`${device.name}\t${device.platform}\t${status}\t${device.fingerprintSha256}`);
	}
}

async function commandDeviceRevoke(args: ParsedArgs): Promise<void> {
	const name = args.positionals[2];
	if (!name) throw new Error("Missing device name.");
	const paths = resolvePiWebPaths();
	const device = await revokeDevice(paths.devicesPath, name);
	console.log(`revoked: ${device.name}`);
}

function envForServer(config: PiWebConfig, paths = resolvePiWebPaths()): Record<string, string> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	env.PI_WEB_HOST = config.host;
	env.PI_WEB_PORT = String(config.port);
	env.PI_WEB_TRUST_PROXY = config.caddy.enabled ? "1" : env.PI_WEB_TRUST_PROXY ?? "0";
	env.PI_WEB_SECURE_MODE = config.secureMode ? "1" : "0";
	env.PI_WEB_DEVICE_REGISTRY = paths.devicesPath;
	if (config.publicOrigins.length > 0) {
		env.PI_WEB_PUBLIC_ORIGIN = config.publicOrigins[0]!;
		env.PI_WEB_ALLOWED_ORIGINS = config.publicOrigins.slice(1).join(",");
	}
	delete env.PI_WEB_TOKEN;
	return env;
}

function ensureCaddy(config: PiWebConfig): void {
	if (!config.caddy.enabled) return;
	const validate = runSync(["caddy", "validate", "--config", config.caddy.caddyfile]);
	if (!validate.ok) throw new Error(validate.stderr || validate.stdout || "caddy validation failed");
	const reload = runSync(["caddy", "reload", "--config", config.caddy.caddyfile]);
	if (reload.ok) return;
	const start = runSync(["caddy", "start", "--config", config.caddy.caddyfile]);
	if (!start.ok) throw new Error(start.stderr || start.stdout || "caddy start failed");
}

async function commandStart(): Promise<void> {
	const paths = resolvePiWebPaths();
	const config = (await loadPiWebConfig(paths)) ?? defaultPiWebConfig(paths);
	if (config.secureMode) {
		const checks = await runDoctor(paths, config);
		printChecks(checks);
		if (hasDoctorErrors(checks)) throw new Error("doctor failed; refusing to start secure mode");
	}
	ensureCaddy(config);
	const proc = Bun.spawn({
		cmd: [Bun.execPath, new URL("./server.ts", import.meta.url).pathname],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: envForServer(config, paths),
	});
	const exitCode = await proc.exited;
	process.exit(exitCode);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const [cmd, subcmd] = args.positionals;
	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
		console.log(usage());
		return;
	}
	if (cmd === "start") return commandStart();
	if (cmd === "doctor") return commandDoctor();
	if (cmd === "secure" && subcmd === "init") return commandSecureInit(args);
	if (cmd === "device" && subcmd === "issue") return commandDeviceIssue(args);
	if (cmd === "device" && subcmd === "list") return commandDeviceList();
	if (cmd === "device" && subcmd === "revoke") return commandDeviceRevoke(args);
	throw new Error(`Unknown command: ${args.positionals.join(" ")}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
