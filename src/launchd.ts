import { join } from "node:path";

export const SERVER_LABEL = "dev.pi-web.server";
export const CADDY_LABEL = "dev.pi-web.caddy";

export interface LaunchAgentSpec {
	label: string;
	programArguments: string[];
	workingDirectory: string;
	logPath: string;
	environment: Record<string, string>;
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function stringElement(value: string): string {
	return `<string>${escapeXml(value)}</string>`;
}

export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
	const args = spec.programArguments.map((arg) => `\t\t${stringElement(arg)}`).join("\n");
	const env = Object.entries(spec.environment)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t${stringElement(value)}`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	${stringElement(spec.label)}
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>WorkingDirectory</key>
	${stringElement(spec.workingDirectory)}
	<key>EnvironmentVariables</key>
	<dict>
${env}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ExitTimeOut</key>
	<integer>30</integer>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	${stringElement(spec.logPath)}
	<key>StandardErrorPath</key>
	${stringElement(spec.logPath)}
</dict>
</plist>
`;
}

export interface ServiceLayout {
	launchAgentsDir: string;
	logsDir: string;
}

export function launchAgentPath(layout: ServiceLayout, label: string): string {
	return join(layout.launchAgentsDir, `${label}.plist`);
}

const SERVICE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "PI_WEB_HOME", "PI_CODING_AGENT_DIR"] as const;

/** `bun run` prepends every ancestor's node_modules/.bin, which would leak the checkout's dev tools into the agent's shell. */
export function servicePath(path: string): string {
	const entries = path.split(":").filter((entry) => entry !== "" && !entry.replace(/\/+$/, "").endsWith("/node_modules/.bin"));
	return [...new Set(entries)].join(":");
}

/** launchd starts agents with a bare PATH, so the agent's bash tool would miss brew, bun and friends. */
export function serviceEnvironment(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
	const picked = SERVICE_ENV_KEYS.flatMap((key) => {
		const value = key === "PATH" ? servicePath(env.PATH ?? "") : env[key];
		return value ? [[key, value] as const] : [];
	});
	return { ...Object.fromEntries(picked), ...extra };
}

export function serverAgentSpec(options: {
	bunPath: string;
	repoDir: string;
	layout: ServiceLayout;
	environment: Record<string, string>;
}): LaunchAgentSpec {
	return {
		label: SERVER_LABEL,
		programArguments: [options.bunPath, join(options.repoDir, "src", "cli.ts"), "start"],
		workingDirectory: options.repoDir,
		logPath: join(options.layout.logsDir, "server.log"),
		environment: options.environment,
	};
}

export function caddyAgentSpec(options: { caddyPath: string; caddyfile: string; layout: ServiceLayout; environment: Record<string, string> }): LaunchAgentSpec {
	return {
		label: CADDY_LABEL,
		programArguments: [options.caddyPath, "run", "--config", options.caddyfile],
		workingDirectory: options.layout.logsDir,
		logPath: join(options.layout.logsDir, "caddy.log"),
		environment: options.environment,
	};
}
