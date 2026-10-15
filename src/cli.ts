#!/usr/bin/env bun
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emptyDeviceRegistry, loadDeviceRegistry, revokeDevice, saveDeviceRegistry, upsertDevice } from "./device-registry.ts";
import { ensureClientCa, issueDeviceCertificate } from "./certificates.ts";
import { writeCaddyfile } from "./caddy-config.ts";
import {
	CADDY_LABEL,
	caddyAgentSpec,
	launchAgentPath,
	renderLaunchAgentPlist,
	SERVER_LABEL,
	serverAgentSpec,
	serviceEnvironment,
	type LaunchAgentSpec,
	type ServiceLayout,
} from "./launchd.ts";
import { hasDoctorErrors, runDoctor, type DoctorCheck } from "./doctor.ts";
import { loadHostRegistry, removeHost, upsertHost, type HostRecord } from "./host-registry.ts";
import { refreshModelCatalogs } from "./model-catalog.ts";
import { createSecureConfig, defaultPiWebConfig, ensurePiWebDirs, loadPiWebConfig, resolvePiWebPaths, savePiWebConfig, type PiWebConfig } from "./security-config.ts";

interface ParsedArgs {
	positionals: string[];
	flags: Map<string, string | true>;
}

function usage(): string {
	return `pi-web

Usage:
  pi-web start
  pi-web config [set tripwire on|off | set project-trust always|ask|never]
  pi-web service install [--no-caddy] [--force] | uninstall | status | print [--no-caddy]
  pi-web doctor
  pi-web update --models [--timeout <seconds>]
  pi-web secure init [--domain <domain>] [--listen-host <host>] [--listen-port <port>] [--port <port>] [--server-cert <path>] [--server-key <path>] [--device <name>] [--platform <platform>]
  pi-web device issue <name> [--platform ios|android|macos|windows|linux|other] [--days <days>]
  pi-web device list
  pi-web device revoke <name>
  pi-web host add <id> <url> [--label <label>] [--tailscale-name <name>] [--tailscale-ip <ip>]
  pi-web host list
  pi-web host remove <id>
  pi-web host discover [--port <port>] [--add]

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

function tailscaleNodes(): Array<{ id: string; label: string; dnsName: string; ip: string | undefined; online: boolean }> {
	const status = runSync(["tailscale", "status", "--json"]);
	if (!status.ok || !status.stdout) return [];
	try {
		const parsed = JSON.parse(status.stdout) as {
			Self?: Record<string, unknown>;
			Peer?: Record<string, Record<string, unknown>>;
		};
		const rawNodes = [parsed.Self, ...Object.values(parsed.Peer ?? {})].filter((node): node is Record<string, unknown> => Boolean(node));
		return rawNodes.flatMap((node) => {
			const dnsRaw = typeof node.DNSName === "string" ? node.DNSName.trim().replace(/\.$/, "") : "";
			if (!dnsRaw) return [];
			const dnsLabel = dnsRaw.split(".")[0] || dnsRaw;
			const hostName = typeof node.HostName === "string" && node.HostName.trim() && node.HostName.trim() !== "localhost" ? node.HostName.trim() : dnsLabel;
			const ips = Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs : [];
			const ip = ips.find((value): value is string => typeof value === "string" && value.includes("."));
			return [{ id: dnsLabel.toLowerCase(), label: hostName, dnsName: dnsRaw, ip, online: node.Online === true }];
		});
	} catch {
		return [];
	}
}

async function commandSecureInit(args: ParsedArgs): Promise<void> {
	const paths = resolvePiWebPaths();
	await ensurePiWebDirs(paths);
	const detected = detectTailscaleHost();
	const domain = flagString(args.flags, "domain") ?? detected.dnsName;
	const listenHost = flagString(args.flags, "listen-host") ?? detected.ip ?? "127.0.0.1";
	const listenPort = flagInt(args.flags, "listen-port", 443);
	const port = flagInt(args.flags, "port", 4317);
	const serverCert = flagString(args.flags, "server-cert");
	const serverKey = flagString(args.flags, "server-key");
	if (Boolean(serverCert) !== Boolean(serverKey)) {
		throw new Error("--server-cert and --server-key must be provided together.");
	}
	const config = createSecureConfig(paths, { domain, listenHost, listenPort, port, tailscaleRequired: Boolean(detected.ip || detected.dnsName), serverCert, serverKey });
	await savePiWebConfig(paths, config);
	const ca = await ensureClientCa(paths);
	if (!(await loadDeviceRegistry(paths.devicesPath)).devices.length) {
		await saveDeviceRegistry(paths.devicesPath, emptyDeviceRegistry());
	}
	await writeCaddyfile(paths, config);
	const firstDeviceName = flagString(args.flags, "device");
	let issued: Awaited<ReturnType<typeof issueDeviceCertificate>> | null = null;
	if (firstDeviceName) {
		issued = await issueDeviceCertificate({
			paths,
			name: firstDeviceName,
			platform: flagString(args.flags, "platform") ?? "other",
			days: flagInt(args.flags, "days", 365),
		});
		await upsertDevice(paths.devicesPath, issued.device);
	}
	console.log(`config: ${paths.configPath}`);
	console.log(`client ca: ${ca.certPath}${ca.created ? " (created)" : ""}`);
	console.log(`caddyfile: ${paths.caddyfilePath}`);
	if (config.publicOrigins.length > 0) console.log(`url: ${config.publicOrigins[0]}`);
	if (issued) {
		console.log(`device: ${issued.device.name}`);
		console.log(`platform: ${issued.device.platform}`);
		console.log(`fingerprint: ${issued.device.fingerprintSha256}`);
		console.log(`p12: ${issued.p12Path}`);
		console.log(`p12 password file: ${issued.p12PasswordPath}`);
	} else {
		console.log("next: pi-web device issue <name> --platform ios|android|macos|windows|linux");
	}
}

async function commandDoctor(): Promise<void> {
	const paths = resolvePiWebPaths();
	const config = await loadPiWebConfig(paths);
	const checks = await runDoctor(paths, config);
	printChecks(checks);
	if (hasDoctorErrors(checks)) process.exit(1);
}

async function commandUpdate(args: ParsedArgs): Promise<void> {
	const supportedFlags = new Set(["models", "timeout"]);
	if (args.positionals.length !== 1 || args.flags.get("models") !== true || [...args.flags.keys()].some((flag) => !supportedFlags.has(flag))) {
		throw new Error("Usage: pi-web update --models [--timeout <seconds>]");
	}
	if (args.flags.get("timeout") === true) throw new Error("Missing value for --timeout");
	const timeoutSeconds = flagInt(args.flags, "timeout", 15);
	if (timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error("Invalid --timeout: expected 1 to 300 seconds");
	await refreshModelCatalogs({ timeoutMs: timeoutSeconds * 1_000 });
	console.log("model catalogs refreshed");
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
	console.log(`p12 password file: ${issued.p12PasswordPath}`);
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
		const expiresAtMs = Date.parse(device.expiresAt);
		const expiresSoon = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() && expiresAtMs <= Date.now() + 30 * 24 * 60 * 60 * 1000;
		const status = device.revokedAt ? `revoked ${device.revokedAt}` : expiresAtMs <= Date.now() ? "expired" : expiresSoon ? "expiring" : "active";
		console.log(`${device.name}\t${device.platform}\t${status}\texpires=${device.expiresAt}\t${device.fingerprintSha256}`);
	}
}

async function commandDeviceRevoke(args: ParsedArgs): Promise<void> {
	const name = args.positionals[2];
	if (!name) throw new Error("Missing device name.");
	const paths = resolvePiWebPaths();
	const device = await revokeDevice(paths.devicesPath, name);
	console.log(`revoked: ${device.name}`);
}

function printHost(host: HostRecord): void {
	const bits = [host.id, host.label, host.enabled ? "enabled" : "disabled", host.url];
	if (host.tailscaleName) bits.push(`ts=${host.tailscaleName}`);
	if (host.tailscaleIp) bits.push(`ip=${host.tailscaleIp}`);
	console.log(bits.join("\t"));
}

async function commandHostAdd(args: ParsedArgs): Promise<void> {
	const id = args.positionals[2];
	const url = args.positionals[3];
	if (!id || !url) throw new Error("Usage: pi-web host add <id> <url>");
	const paths = resolvePiWebPaths();
	await ensurePiWebDirs(paths);
	const registry = await upsertHost(paths.hostsPath, {
		id,
		url,
		label: flagString(args.flags, "label") ?? undefined,
		tailscaleName: flagString(args.flags, "tailscale-name") ?? undefined,
		tailscaleIp: flagString(args.flags, "tailscale-ip") ?? undefined,
	});
	const host = registry.hosts.find((entry) => entry.id === id.toLowerCase());
	if (host) printHost(host);
}

async function commandHostList(): Promise<void> {
	const paths = resolvePiWebPaths();
	const registry = await loadHostRegistry(paths.hostsPath);
	if (registry.hosts.length === 0) {
		console.log("no hosts");
		return;
	}
	for (const host of registry.hosts) printHost(host);
}

async function commandHostRemove(args: ParsedArgs): Promise<void> {
	const id = args.positionals[2];
	if (!id) throw new Error("Usage: pi-web host remove <id>");
	const paths = resolvePiWebPaths();
	const host = await removeHost(paths.hostsPath, id);
	console.log(`removed: ${host.id}`);
}

async function commandHostDiscover(args: ParsedArgs): Promise<void> {
	const paths = resolvePiWebPaths();
	const port = flagInt(args.flags, "port", 8443);
	const shouldAdd = args.flags.get("add") === true;
	const nodes = tailscaleNodes();
	if (nodes.length === 0) {
		console.log("no tailscale nodes discovered");
		return;
	}
	if (shouldAdd) await ensurePiWebDirs(paths);
	for (const node of nodes) {
		const url = `https://${node.dnsName}${port === 443 ? "" : `:${String(port)}`}`;
		if (shouldAdd) {
			await upsertHost(paths.hostsPath, {
				id: node.id,
				label: node.label,
				url,
				tailscaleName: node.label,
				tailscaleIp: node.ip,
			});
			console.log(`added ${node.id}\t${node.online ? "online" : "offline"}\t${url}`);
		} else {
			console.log(`pi-web host add ${node.id} ${url} --label ${JSON.stringify(node.label)} --tailscale-name ${JSON.stringify(node.label)}${node.ip ? ` --tailscale-ip ${JSON.stringify(node.ip)}` : ""} # ${node.online ? "online" : "offline"}`);
		}
	}
}

function envForServer(config: PiWebConfig, paths = resolvePiWebPaths()): Record<string, string> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	env.PI_WEB_HOST = config.host;
	env.PI_WEB_PORT = String(config.port);
	env.PI_WEB_TRUST_PROXY = config.caddy.enabled ? "1" : env.PI_WEB_TRUST_PROXY ?? "0";
	env.PI_WEB_SECURE_MODE = config.secureMode ? "1" : "0";
	env.PI_WEB_DEVICE_REGISTRY = paths.devicesPath;
	env.PI_WEB_HOST_REGISTRY = paths.hostsPath;
	if (config.publicOrigins.length > 0) {
		env.PI_WEB_PUBLIC_ORIGIN = config.publicOrigins[0]!;
		env.PI_WEB_ALLOWED_ORIGINS = config.publicOrigins.slice(1).join(",");
	}
	env.PI_WEB_TRIPWIRE = env.PI_WEB_TRIPWIRE?.trim() || config.tripwire;
	env.PI_WEB_PROJECT_TRUST = env.PI_WEB_PROJECT_TRUST?.trim() || config.projectTrust;
	delete env.PI_WEB_TOKEN;
	return env;
}

const CONFIG_SETTINGS = {
	tripwire: { key: "tripwire", values: ["on", "off"] },
	"project-trust": { key: "projectTrust", values: ["always", "ask", "never"] },
} as const;

async function commandConfig(args: ParsedArgs): Promise<void> {
	const paths = resolvePiWebPaths();
	const config = (await loadPiWebConfig(paths)) ?? defaultPiWebConfig(paths);
	const [, action, name, value] = args.positionals;
	if (action === undefined) {
		console.log(`tripwire: ${config.tripwire}\nproject-trust: ${config.projectTrust}\nconfig: ${paths.configPath}`);
		return;
	}
	const setting = name && name in CONFIG_SETTINGS ? CONFIG_SETTINGS[name as keyof typeof CONFIG_SETTINGS] : null;
	if (action !== "set" || !setting || !setting.values.some((allowed) => allowed === value)) {
		throw new Error("Usage: pi-web config [set tripwire on|off | set project-trust always|ask|never]");
	}
	await savePiWebConfig(paths, { ...config, [setting.key]: value });
	console.log(`${name}: ${String(value)} (restart pi-web to apply)`);
}

function tailLines(text: string, count: number): string {
	return text.trim().split("\n").slice(-count).join("\n");
}

// `caddy start` leaves a background `caddy run` holding our stdio, so piped output never reaches EOF.
function startCaddy(caddyfile: string): { ok: boolean; output: string } {
	const logPath = join(dirname(caddyfile), "caddy.log");
	const fd = openSync(logPath, "w", 0o600);
	try {
		const proc = Bun.spawnSync({ cmd: ["caddy", "start", "--config", caddyfile], stdout: fd, stderr: fd });
		return { ok: proc.exitCode === 0, output: tailLines(readFileSync(logPath, "utf8"), 20) };
	} finally {
		closeSync(fd);
	}
}

function ensureCaddy(config: PiWebConfig): void {
	if (!config.caddy.enabled) return;
	if (process.env.PI_WEB_MANAGE_CADDY === "0") return;
	const validate = runSync(["caddy", "validate", "--config", config.caddy.caddyfile]);
	if (!validate.ok) throw new Error(validate.stderr || validate.stdout || "caddy validation failed");
	const reload = runSync(["caddy", "reload", "--config", config.caddy.caddyfile]);
	if (reload.ok) return;
	const start = startCaddy(config.caddy.caddyfile);
	if (!start.ok) throw new Error(start.output || "caddy start failed");
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
		cmd: [process.execPath, new URL("./server.ts", import.meta.url).pathname],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: envForServer(config, paths),
	});
	// launchd and tmux stop the cli process; the server needs the signal to save its sessions
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, () => proc.kill(signal === "SIGHUP" ? "SIGTERM" : signal));
	}
	const exitCode = await proc.exited;
	process.exit(exitCode);
}

function serviceLayout(paths = resolvePiWebPaths()): ServiceLayout {
	return { launchAgentsDir: join(homedir(), "Library", "LaunchAgents"), logsDir: join(paths.home, "logs") };
}

function launchdDomain(): string {
	return `gui/${String(process.getuid?.() ?? 501)}`;
}

function whichCommand(command: string): string | null {
	const found = runSync(["/usr/bin/which", command]);
	return found.ok && found.stdout ? found.stdout.split("\n")[0]!.trim() : null;
}

async function serviceSpecs(args: ParsedArgs): Promise<LaunchAgentSpec[]> {
	const paths = resolvePiWebPaths();
	const config = (await loadPiWebConfig(paths)) ?? defaultPiWebConfig(paths);
	const layout = serviceLayout(paths);
	const withCaddy = config.caddy.enabled && args.flags.get("no-caddy") !== true;
	const caddyPath = withCaddy ? whichCommand("caddy") : null;
	if (withCaddy && !caddyPath) throw new Error("caddy not found in PATH; install it or pass --no-caddy");
	const environment = serviceEnvironment(process.env);
	const server = serverAgentSpec({
		bunPath: process.execPath,
		repoDir: resolve(import.meta.dir, ".."),
		layout,
		environment: { ...environment, PI_WEB_MANAGE_CADDY: withCaddy ? "0" : "1" },
	});
	return caddyPath ? [server, caddyAgentSpec({ caddyPath, caddyfile: config.caddy.caddyfile, layout, environment })] : [server];
}

async function serverResponds(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1_000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function commandService(args: ParsedArgs): Promise<void> {
	const action = args.positionals[1];
	const layout = serviceLayout();
	if (action === "print") {
		for (const spec of await serviceSpecs(args)) {
			console.log(`# ${launchAgentPath(layout, spec.label)}\n${renderLaunchAgentPlist(spec)}`);
		}
		return;
	}
	if (action === "install") {
		if (process.platform !== "darwin") throw new Error("pi-web service uses launchd and only supports macOS.");
		const config = (await loadPiWebConfig(resolvePiWebPaths())) ?? defaultPiWebConfig(resolvePiWebPaths());
		if (args.flags.get("force") !== true && (await serverResponds(config.port))) {
			throw new Error(`something already answers on port ${String(config.port)}; stop the manually started pi-web first (or pass --force)`);
		}
		const specs = await serviceSpecs(args);
		if (specs.some((spec) => spec.label === CADDY_LABEL) && runSync(["caddy", "stop"]).ok) {
			console.log("stopped the caddy instance pi-web started earlier; launchd runs it from now on");
		}
		await mkdir(layout.launchAgentsDir, { recursive: true });
		await mkdir(layout.logsDir, { recursive: true, mode: 0o700 });
		for (const spec of [...specs].reverse()) {
			const plistPath = launchAgentPath(layout, spec.label);
			await writeFile(plistPath, renderLaunchAgentPlist(spec), { mode: 0o644 });
			runSync(["launchctl", "bootout", `${launchdDomain()}/${spec.label}`]);
			const loaded = runSync(["launchctl", "bootstrap", launchdDomain(), plistPath]);
			if (!loaded.ok) throw new Error(`launchctl bootstrap ${spec.label} failed: ${loaded.stderr || loaded.stdout}`);
			console.log(`installed ${spec.label} -> ${plistPath}`);
		}
		console.log(`logs: ${layout.logsDir}`);
		return;
	}
	if (action === "uninstall") {
		for (const label of [SERVER_LABEL, CADDY_LABEL]) {
			const plistPath = launchAgentPath(layout, label);
			runSync(["launchctl", "bootout", `${launchdDomain()}/${label}`]);
			if (existsSync(plistPath)) {
				await rm(plistPath);
				console.log(`removed ${label}`);
			}
		}
		return;
	}
	if (action === "status") {
		for (const label of [SERVER_LABEL, CADDY_LABEL]) {
			const printed = runSync(["launchctl", "print", `${launchdDomain()}/${label}`]);
			const state = /^\s*state = (.+)$/m.exec(printed.stdout)?.[1] ?? (existsSync(launchAgentPath(layout, label)) ? "not loaded" : "not installed");
			const pid = /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1];
			console.log(`${label.padEnd(20)} ${state}${pid ? ` (pid ${pid})` : ""}`);
		}
		const config = (await loadPiWebConfig(resolvePiWebPaths())) ?? defaultPiWebConfig(resolvePiWebPaths());
		try {
			const res = await fetch(`http://127.0.0.1:${String(config.port)}/health`, { signal: AbortSignal.timeout(2_000) });
			console.log(`health ${JSON.stringify(await res.json())}`);
		} catch (error) {
			console.log(`health unreachable on port ${String(config.port)}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return;
	}
	throw new Error("Usage: pi-web service install|uninstall|status|print");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const [cmd, subcmd] = args.positionals;
	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
		console.log(usage());
		return;
	}
	if (cmd === "start") return commandStart();
	if (cmd === "config") return commandConfig(args);
	if (cmd === "service") return commandService(args);
	if (cmd === "doctor") return commandDoctor();
	if (cmd === "update") return commandUpdate(args);
	if (cmd === "secure" && subcmd === "init") return commandSecureInit(args);
	if (cmd === "device" && subcmd === "issue") return commandDeviceIssue(args);
	if (cmd === "device" && subcmd === "list") return commandDeviceList();
	if (cmd === "device" && subcmd === "revoke") return commandDeviceRevoke(args);
	if (cmd === "host" && subcmd === "add") return commandHostAdd(args);
	if (cmd === "host" && subcmd === "list") return commandHostList();
	if (cmd === "host" && subcmd === "remove") return commandHostRemove(args);
	if (cmd === "host" && subcmd === "discover") return commandHostDiscover(args);
	throw new Error(`Unknown command: ${args.positionals.join(" ")}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
