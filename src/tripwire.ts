import { type AgentSessionEvent, getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";
import { resolvePiWebHome } from "./security-config.ts";
import { CASE_INSENSITIVE_FS, isWithin, pathForms, readVariants, realTarget, toolPath } from "./tripwire-paths.ts";
import type { ApiTripwireAlert, ApiTripwireAlertsResponse, ApiTripwireCategory, ApiTripwireResponse, ApiTripwireSeverity } from "./types.ts";

/** PI_WEB_TRIPWIRE: `on` blocks critical tool calls and logs the rest, `off` inspects nothing. */
export type TripwireMode = "on" | "off";

export function parseTripwireMode(raw: string | undefined): TripwireMode {
	const value = raw?.trim().toLowerCase();
	if (!value || value === "on") return "on";
	if (value === "off") return "off";
	throw new Error(`PI_WEB_TRIPWIRE must be on or off (got ${JSON.stringify(raw)}).`);
}

interface StoredTripwireAlert {
	id: string;
	sessionId: string;
	createdAtMs: number;
	severity: ApiTripwireSeverity;
	category: ApiTripwireCategory;
	summary: string;
	detail?: string;
	toolName?: string;
	toolCallId?: string;
	response: ApiTripwireResponse;
}

interface StoredTripwireSession {
	alerts: StoredTripwireAlert[];
	lastReadByClientId: Record<string, number>;
	modifiedAtMs: number;
}

interface TripwireStore {
	version: 1;
	sessions: Record<string, StoredTripwireSession>;
}

interface ToolRateWindow {
	startedAtMs: number;
	toolCount: number;
	bashCount: number;
	lastAlertAtMs: number;
	failureTimestamps: number[];
	lastFailureAlertAtMs: number;
}

export interface TripwireSessionContext {
	sessionId: string;
	cwd: string;
	allowedRoots: Iterable<string>;
}

export interface TripwireInspectionResult {
	alerts: StoredTripwireAlert[];
	shouldBlock: boolean;
}

const TRIPWIRE_STORE_VERSION = 1;
const MAX_ALERTS_PER_SESSION = 200;
const MAX_TRACKED_SESSIONS = 256;
const MAX_TRACKED_CLIENTS_PER_SESSION = 64;
const RECENT_ALERT_LIMIT = 50;
const TOOL_RATE_WINDOW_MS = 60_000;
const TOOL_RATE_THRESHOLD = 30;
const BASH_RATE_THRESHOLD = 15;
const FAILURE_RATE_WINDOW_MS = 5 * 60_000;
const FAILURE_RATE_THRESHOLD = 6;

/**
 * What a future session in the agent dir runs or reads into its prompt: models.json (an `!cmd` API key runs as a shell
 * command, a baseUrl gets every prompt), settings.json (tools, packages), mcp.json (the MCP servers it spawns), trust.json
 * (project trust), the global context and system prompt files, extensions/ and the packages installed in npm/ and git/
 * (code it loads), skills/ and prompts/ (read into the prompt), and bin/ (first on bash's PATH, and find's and grep's fd
 * and rg). The owner's agents edit these on request, so changing them is logged, not blocked.
 */
const AGENT_CONFIG = [
	"models.json",
	"settings.json",
	"mcp.json",
	"trust.json",
	"AGENTS.md",
	"AGENTS.override.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"extensions",
	"skills",
	"prompts",
	"npm",
	"git",
	"bin",
];

/**
 * What bash naming them can't flag: skills and prompts are run and read by name all day (a skill's own scripts, by the
 * absolute path its SKILL.md gives), and bash can't tell that from a write. Their writes through the file tools still log.
 */
const BASH_UNFLAGGED_CONFIG = new Set(["skills", "prompts"]);

/** The built-in tools that only read: they open the agent's config without changing it. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/**
 * Where custom and MCP tools name paths: the SDK's spellings, their snake_case, file_path, and the MCP filesystem server's
 * move_file (source, destination) and read_multiple_files (paths). A path under any other name goes unchecked.
 */
const CUSTOM_PATH_KEYS = ["path", "from", "to", "oldPath", "newPath", "targetPath", "file_path", "filePath", "old_path", "new_path", "target_path", "source", "destination"];
const CUSTOM_PATH_LIST_KEYS = ["paths"];

function toIso(ms: number): string {
	return new Date(ms).toISOString();
}

function clipText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function resolveAgainstCwd(cwd: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) return resolve(cwd);
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return resolve(homedir(), trimmed.slice(2));
	}
	return resolve(cwd, trimmed);
}

/** Every path a tool given `rawPath` may open: the SDK's spelling and read's fallbacks, plus the plain one (a custom tool's, and the fallback when the SDK's can't be resolved). */
function candidatePaths(cwd: string, rawPath: string): string[] {
	let sdkPaths: string[] = [];
	try {
		sdkPaths = readVariants(toolPath(cwd, rawPath));
	} catch {
		// a file URL the SDK can't take either: the tool fails, the plain spelling is still checked
	}
	return unique([resolveAgainstCwd(cwd, rawPath), ...sdkPaths]);
}

/** The path arguments of a tool call: the built-ins' `path` (grep, find and ls default to the session's folder), a custom or MCP tool's by the keys above. */
export function toolPathArgs(toolName: string, args: unknown): string[] {
	if (!args || typeof args !== "object") return [];
	const input = args as Record<string, unknown>;

	if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName) && typeof input.path === "string") {
		return [input.path];
	}
	if (["grep", "find", "ls"].includes(toolName) && input.path === undefined) return ["."];

	const single = CUSTOM_PATH_KEYS.map((key) => input[key]).filter((value): value is string => typeof value === "string");
	const listed = CUSTOM_PATH_LIST_KEYS.flatMap((key) => (Array.isArray(input[key]) ? (input[key] as unknown[]) : [])).filter((value): value is string => typeof value === "string");
	return [...single, ...listed];
}

function unique(paths: string[]): string[] {
	return [...new Set(paths)];
}

function keepNewestEntries<T>(entries: [string, T][], limit: number): Record<string, T> {
	if (entries.length <= limit) return Object.fromEntries(entries);
	return Object.fromEntries(entries.slice(-limit));
}

function serializeAlert(alert: StoredTripwireAlert): ApiTripwireAlert {
	return {
		id: alert.id,
		sessionId: alert.sessionId,
		created: toIso(alert.createdAtMs),
		severity: alert.severity,
		category: alert.category,
		summary: alert.summary,
		detail: alert.detail,
		toolName: alert.toolName,
		toolCallId: alert.toolCallId,
		response: alert.response,
	};
}

/** How a bash command may name protected paths: each as configured and where it really lands, also as $HOME/… and ~/…, lowercased. */
function commandRefs(paths: string[]): string[] {
	const forms = unique(paths.flatMap((path) => pathForms(path)));
	return unique(forms.flatMap((path) => [path, path.replace(homedir(), "$HOME"), path.replace(homedir(), "~")]).map((path) => path.toLowerCase()));
}

export class TripwireService {
	private storePath: string;
	private appStateRoots: string[];
	private secretRoots: string[];
	private secretFiles: string[];
	private persistenceRoots: string[];
	private persistenceFiles: string[];
	private agentConfig: string[];
	private bashFlaggedConfig: string[];
	private storePromise: Promise<TripwireStore> | null = null;
	private mutationChain: Promise<void> = Promise.resolve();
	private rateWindows = new Map<string, ToolRateWindow>();

	constructor(storePath = join(getAgentDir(), "pi-web", "tripwire-state.json")) {
		this.storePath = storePath;
		// the agent's state is open to it (it edits skills, extensions and settings there), except the secrets below; changing what the next session runs is logged (agentConfig)
		this.appStateRoots = unique([join(homedir(), ".pi", "agent"), getAgentDir()].map((path) => resolve(path)));

		this.secretRoots = [
			// the cookie key and the device registry: enough to pass as a browser, and to reach a terminal tile's shell
			resolvePiWebHome(),
			// pi-web's own state under the agent dir: the Face ID credentials (emptied, first-use enrollment reopens), this tripwire's alerts, the saved repos it allows writes in
			...this.appStateRoots.map((root) => join(root, "pi-web")),
			join(homedir(), ".ssh"),
			join(homedir(), ".aws"),
			join(homedir(), ".gnupg"),
			join(homedir(), ".docker"),
			join(homedir(), ".kube"),
			join(homedir(), ".azure"),
			join(homedir(), ".config", "gcloud"),
		].map((path) => resolve(path));
		this.secretFiles = [
			// the agent's provider API keys and OAuth tokens
			...this.appStateRoots.map((root) => join(root, "auth.json")),
			storePath,
			join(homedir(), ".netrc"),
			join(homedir(), ".npmrc"),
			join(homedir(), ".pypirc"),
			join(homedir(), ".terraformrc"),
		].map((path) => resolve(path));
		this.persistenceRoots = [
			join(homedir(), "Library", "LaunchAgents"),
			"/Library/LaunchAgents",
			"/Library/LaunchDaemons",
			"/etc/systemd",
			join(homedir(), ".config", "systemd"),
			"/etc/cron.d",
			"/var/spool/cron",
			join(homedir(), ".config", "autostart"),
		].map((path) => resolve(path));
		this.persistenceFiles = [
			join(homedir(), ".zshrc"),
			join(homedir(), ".bashrc"),
			join(homedir(), ".bash_profile"),
			join(homedir(), ".profile"),
			join(homedir(), ".config", "fish", "config.fish"),
		].map((path) => resolve(path));
		this.agentConfig = unique(this.appStateRoots.flatMap((root) => AGENT_CONFIG.map((name) => resolve(root, name))));
		this.bashFlaggedConfig = unique(
			this.appStateRoots.flatMap((root) => AGENT_CONFIG.filter((name) => !BASH_UNFLAGGED_CONFIG.has(name)).map((name) => resolve(root, name))),
		);
	}

	/**
	 * Runs from a `tool_call` handler, after argument validation and before the tool executes, for
	 * model-issued and nested (codemode, MCP) calls alike. Critical findings block the call.
	 */
	inspectToolCall(context: TripwireSessionContext, toolName: string, toolCallId: string, input: unknown): TripwireInspectionResult {
		const toolAlert = this.inspectToolStart(context, toolName, toolCallId, input);
		if (toolAlert) {
			return { alerts: [toolAlert], shouldBlock: toolAlert.response === "blocked" };
		}
		const rateAlert = this.inspectToolRate(context.sessionId, toolName);
		return { alerts: rateAlert ? [rateAlert] : [], shouldBlock: false };
	}

	inspectEvent(context: TripwireSessionContext, event: AgentSessionEvent): TripwireInspectionResult {
		if (event.type === "tool_execution_end") {
			const failureAlert = this.inspectFailureRate(context.sessionId, Boolean(event.isError));
			if (failureAlert) {
				return { alerts: [failureAlert], shouldBlock: false };
			}
		}
		return { alerts: [], shouldBlock: false };
	}

	async recordAlerts(sessionId: string, alerts: StoredTripwireAlert[]): Promise<void> {
		if (alerts.length === 0) return;

		await this.mutateStore((store) => {
			const session = this.ensureSessionStore(store, sessionId);
			session.alerts.push(...alerts);
			session.alerts = session.alerts.slice(-MAX_ALERTS_PER_SESSION);
			session.modifiedAtMs = Date.now();
			this.pruneStore(store);
		});
	}

	async consumeAlerts(sessionId: string, clientId: string): Promise<ApiTripwireAlertsResponse> {
		return this.mutateStore((store) => {
			const session = this.ensureSessionStore(store, sessionId);
			const lastReadAtMs = session.lastReadByClientId[clientId] ?? 0;
			const unreadAlerts = session.alerts.filter((alert) => alert.createdAtMs > lastReadAtMs);
			const recentAlerts = session.alerts.slice(-RECENT_ALERT_LIMIT);
			const latestSeenAtMs = unreadAlerts.length > 0 ? unreadAlerts[unreadAlerts.length - 1]!.createdAtMs : lastReadAtMs;

			if (latestSeenAtMs > lastReadAtMs) {
				session.lastReadByClientId[clientId] = latestSeenAtMs;
				session.modifiedAtMs = Date.now();
			}

			this.pruneSessionReaders(session);

			return {
				alerts: recentAlerts.map(serializeAlert),
				unreadAlerts: unreadAlerts.map(serializeAlert),
				unreadCount: unreadAlerts.length,
			};
		});
	}

	forgetSession(sessionId: string): void {
		this.rateWindows.delete(sessionId);
	}

	toApiAlert(alert: StoredTripwireAlert): ApiTripwireAlert {
		return serializeAlert(alert);
	}

	private inspectToolStart(context: TripwireSessionContext, toolName: string, toolCallId: string, args: unknown): StoredTripwireAlert | null {
		const pathAlert = this.inspectToolPaths(context, toolName, toolCallId, args);
		if (pathAlert) return pathAlert;
		if (toolName !== "bash") return null;

		const command = typeof (args as { command?: unknown })?.command === "string" ? (args as { command: string }).command : "";
		if (!command.trim()) return null;

		const preview = clipText(command, 180);
		const lowerCommand = command.toLowerCase();

		if (this.commandReferencesSecrets(lowerCommand)) {
			return this.createAlert({
				sessionId: context.sessionId,
				severity: "critical",
				category: "secret_access",
				summary: "Tripwire: sensitive host secret path referenced from bash.",
				detail: `Command: ${preview}`,
				toolName,
				toolCallId,
				response: "blocked",
			});
		}

		if (this.commandLooksPersistent(lowerCommand)) {
			return this.createAlert({
				sessionId: context.sessionId,
				severity: "critical",
				category: "persistence",
				summary: "Tripwire: host persistence command detected.",
				detail: `Command: ${preview}`,
				toolName,
				toolCallId,
				response: "blocked",
			});
		}

		if (this.commandLooksDestructive(lowerCommand)) {
			return this.createAlert({
				sessionId: context.sessionId,
				severity: "critical",
				category: "destructive",
				summary: "Tripwire: host-destructive bash pattern detected.",
				detail: `Command: ${preview}`,
				toolName,
				toolCallId,
				response: "blocked",
			});
		}

		if (this.commandLooksLikeUploadOrDownloadExec(lowerCommand)) {
			return this.createAlert({
				sessionId: context.sessionId,
				severity: "critical",
				category: "network",
				summary: "Tripwire: suspicious upload or download-and-exec bash pattern detected.",
				detail: `Command: ${preview}`,
				toolName,
				toolCallId,
				response: "blocked",
			});
		}

		const configPath = this.agentConfigNamed(lowerCommand);
		if (configPath) {
			return this.createAlert({
				sessionId: context.sessionId,
				severity: "observe",
				category: "persistence",
				summary: "Tripwire: agent config named from bash (the next session runs or applies it).",
				detail: `Path: ${configPath} Command: ${preview}`,
				toolName,
				toolCallId,
				response: "logged",
			});
		}

		return null;
	}

	/**
	 * Checks where each path really lands, the way the SDK's file tools resolve it (a leading `@`, `file://`, `~`, read's
	 * fallbacks) with symlinks followed, as well as the path as written.
	 */
	private inspectToolPaths(context: TripwireSessionContext, toolName: string, toolCallId: string, args: unknown): StoredTripwireAlert | null {
		const rawPaths = toolPathArgs(toolName, args);
		if (rawPaths.length === 0) return null;

		const allowedRoots = unique([context.cwd, ...this.appStateRoots, ...context.allowedRoots].flatMap((root) => pathForms(root)));
		const secretPaths = unique([...this.secretRoots, ...this.secretFiles].flatMap((path) => pathForms(path)));
		const persistencePaths = unique([...this.persistenceRoots, ...this.persistenceFiles].flatMap((path) => pathForms(path)));
		const configPaths = unique(this.agentConfig.flatMap((path) => pathForms(path)));
		const isWriteLike = toolName === "write" || toolName === "edit";
		const mayChange = !READ_ONLY_TOOLS.includes(toolName);
		let observedPath: string | null = null;
		let configDetail: string | null = null;

		for (const rawPath of rawPaths) {
			const candidates = candidatePaths(context.cwd, rawPath);
			const forms = unique(candidates.flatMap((path) => pathForms(path)));
			const written = (path: string) => (path === rawPath ? "" : ` (written ${JSON.stringify(clipText(rawPath, 180))})`);

			const secretPath = forms.find((path) => secretPaths.some((root) => isWithin(path, root, CASE_INSENSITIVE_FS)));
			if (secretPath) {
				return this.createAlert({
					sessionId: context.sessionId,
					severity: "critical",
					category: "secret_access",
					summary: "Tripwire: sensitive host secret path access detected.",
					detail: `Path: ${secretPath}${written(secretPath)}`,
					toolName,
					toolCallId,
					response: "blocked",
				});
			}

			const persistencePath = forms.find((path) => persistencePaths.some((root) => isWithin(path, root, CASE_INSENSITIVE_FS)));
			if (persistencePath) {
				return this.createAlert({
					sessionId: context.sessionId,
					severity: "critical",
					category: "persistence",
					summary: "Tripwire: host persistence path targeted.",
					detail: `Path: ${persistencePath}${written(persistencePath)}`,
					toolName,
					toolCallId,
					response: "blocked",
				});
			}

			const configPath = mayChange ? forms.find((path) => configPaths.some((root) => isWithin(path, root, CASE_INSENSITIVE_FS))) : undefined;
			if (configPath && !configDetail) configDetail = `Path: ${configPath}${written(configPath)}`;

			// where the write lands decides: a symlink in the repo that points out of it is a repo escape
			const escapedPath = candidates.map((path) => realTarget(path)).find((path) => !allowedRoots.some((root) => isWithin(path, root)));
			if (escapedPath) {
				if (isWriteLike) {
					return this.createAlert({
						sessionId: context.sessionId,
						severity: "critical",
						category: "repo_escape",
						summary: "Tripwire: repo-external write/edit detected.",
						detail: `Path: ${escapedPath}${written(escapedPath)}`,
						toolName,
						toolCallId,
						response: "blocked",
					});
				}
				if (!observedPath) observedPath = escapedPath;
			}
		}

		if (configDetail) {
			return this.createAlert({
				sessionId: context.sessionId,
				severity: "observe",
				category: "persistence",
				summary: "Tripwire: agent config targeted (the next session runs or applies it).",
				detail: configDetail,
				toolName,
				toolCallId,
				response: "logged",
			});
		}
		if (!observedPath) return null;
		return this.createAlert({
			sessionId: context.sessionId,
			severity: "observe",
			category: "repo_escape",
			summary: "Tripwire: repo-external read/search detected.",
			detail: `Path: ${observedPath}`,
			toolName,
			toolCallId,
			response: "logged",
		});
	}

	private inspectToolRate(sessionId: string, toolName: string): StoredTripwireAlert | null {
		const now = Date.now();
		const window = this.ensureRateWindow(sessionId, now);
		window.toolCount += 1;
		if (toolName === "bash") window.bashCount += 1;

		const overLimit = window.toolCount >= TOOL_RATE_THRESHOLD || window.bashCount >= BASH_RATE_THRESHOLD;
		if (!overLimit || now - window.lastAlertAtMs < TOOL_RATE_WINDOW_MS) return null;

		window.lastAlertAtMs = now;
		return this.createAlert({
			sessionId,
			severity: "observe",
			category: "runaway",
			summary: "Tripwire: unusually high tool execution rate detected.",
			detail: `${String(window.toolCount)} tool calls (${String(window.bashCount)} bash) in the last 60s.`,
			response: "logged",
		});
	}

	private inspectFailureRate(sessionId: string, isError: boolean): StoredTripwireAlert | null {
		if (!isError) return null;

		const now = Date.now();
		const window = this.ensureRateWindow(sessionId, now);
		window.failureTimestamps = window.failureTimestamps.filter((timestamp) => now - timestamp <= FAILURE_RATE_WINDOW_MS);
		window.failureTimestamps.push(now);

		if (window.failureTimestamps.length < FAILURE_RATE_THRESHOLD || now - window.lastFailureAlertAtMs < FAILURE_RATE_WINDOW_MS) {
			return null;
		}

		window.lastFailureAlertAtMs = now;
		return this.createAlert({
			sessionId,
			severity: "observe",
			category: "runaway",
			summary: "Tripwire: repeated tool failures detected.",
			detail: `${String(window.failureTimestamps.length)} failed tool executions in the last 5m.`,
			response: "logged",
		});
	}

	private ensureRateWindow(sessionId: string, now: number): ToolRateWindow {
		const existing = this.rateWindows.get(sessionId);
		if (!existing || now - existing.startedAtMs > TOOL_RATE_WINDOW_MS) {
			const fresh: ToolRateWindow = {
				startedAtMs: now,
				toolCount: 0,
				bashCount: 0,
				lastAlertAtMs: 0,
				failureTimestamps: existing?.failureTimestamps.filter((timestamp) => now - timestamp <= FAILURE_RATE_WINDOW_MS) ?? [],
				lastFailureAlertAtMs: existing?.lastFailureAlertAtMs ?? 0,
			};
			this.rateWindows.set(sessionId, fresh);
			return fresh;
		}
		return existing;
	}

	private createAlert(input: {
		sessionId: string;
		severity: ApiTripwireSeverity;
		category: ApiTripwireCategory;
		summary: string;
		detail?: string;
		toolName?: string;
		toolCallId?: string;
		response: ApiTripwireResponse;
	}): StoredTripwireAlert {
		return {
			id: randomUUID(),
			sessionId: input.sessionId,
			createdAtMs: Date.now(),
			severity: input.severity,
			category: input.category,
			summary: input.summary,
			detail: input.detail,
			toolName: input.toolName,
			toolCallId: input.toolCallId,
			response: input.response,
		};
	}

	private commandReferencesSecrets(command: string): boolean {
		return commandRefs([...this.secretRoots, ...this.secretFiles]).some((ref) => ref && command.includes(ref));
	}

	/** The agent config file or folder a bash command names, spelled like the secret refs (skills and prompts aside). */
	private agentConfigNamed(command: string): string | undefined {
		return this.bashFlaggedConfig.find((path) => commandRefs([path]).some((ref) => ref && command.includes(ref)));
	}

	private commandLooksPersistent(command: string): boolean {
		if (/\b(crontab|launchctl|systemctl|service|rc-update|update-rc\.d)\b/i.test(command)) return true;
		if (/(>>?|tee(?:\s+-a)?)\s+(~\/\.(zshrc|bashrc|bash_profile|profile)|\$home\/\.(zshrc|bashrc|bash_profile|profile))/i.test(command)) {
			return true;
		}
		return commandRefs([...this.persistenceRoots, ...this.persistenceFiles]).some((ref) => ref && command.includes(ref));
	}

	private commandLooksDestructive(command: string): boolean {
		if (/\b(mkfs|fdisk|shutdown|reboot|halt)\b/i.test(command)) return true;
		if (/\bdiskutil\s+erase(disk|volume)\b/i.test(command)) return true;
		if (/\bdd\b[^\n]*\bof=\/dev\//i.test(command)) return true;
		if (/\brm\b[^\n]*(-rf|-fr|--recursive)[^\n]*(?:\s|['"])(?:\/(?:\s|$)|~(?:\s|$)|\$home(?:\s|$)|\/etc(?:\/|\s|$)|\/var(?:\/|\s|$)|\/usr(?:\/|\s|$)|\/opt(?:\/|\s|$)|\/system(?:\/|\s|$))/i.test(command)) {
			return true;
		}
		return /\b(chmod|chown)\b[^\n]*(-r|-R|--recursive)[^\n]*(?:\s|['"])(?:\/(?:\s|$)|~(?:\s|$)|\$home(?:\s|$)|\/etc(?:\/|\s|$)|\/var(?:\/|\s|$)|\/usr(?:\/|\s|$)|\/opt(?:\/|\s|$)|\/system(?:\/|\s|$))/i.test(command);
	}

	private commandLooksLikeUploadOrDownloadExec(command: string): boolean {
		if (/\b(curl|wget)\b[\s\S]{0,240}\|\s*(bash|sh|zsh)\b/i.test(command)) return true;
		if (/\b(scp|rsync)\b[^\n]*(\w+@[^\s:]+:|\b[a-z0-9.-]+:)/i.test(command)) return true;
		if (/\bcurl\b[^\n]*(--data(?:-binary|-raw)?|--form|-F|--upload-file|-T)\b/i.test(command)) return true;
		return false;
	}

	private async mutateStore<T>(mutator: (store: TripwireStore) => T | Promise<T>): Promise<T> {
		let result!: T;
		const run = async () => {
			const store = await this.getStore();
			result = await mutator(store);
			await writePrivateJsonFile(this.storePath, store);
		};

		const pending = this.mutationChain.then(run, run);
		this.mutationChain = pending.then(
			() => undefined,
			() => undefined,
		);
		await pending;
		return result;
	}

	private async getStore(): Promise<TripwireStore> {
		if (!this.storePromise) {
			this.storePromise = this.loadStore();
		}
		return this.storePromise;
	}

	private async loadStore(): Promise<TripwireStore> {
		try {
			const parsed = await readPrivateJsonFile<unknown>(this.storePath);
			if (!parsed || typeof parsed !== "object") {
				throw new Error(`Invalid tripwire store: ${this.storePath}`);
			}
			const store = parsed as Partial<TripwireStore>;
			if (store.version !== TRIPWIRE_STORE_VERSION || !store.sessions || typeof store.sessions !== "object" || Array.isArray(store.sessions)) {
				throw new Error(`Invalid tripwire store: ${this.storePath}`);
			}
			return {
				version: TRIPWIRE_STORE_VERSION,
				sessions: store.sessions as Record<string, StoredTripwireSession>,
			};
		} catch (error) {
			if (isMissingFileError(error)) {
				return { version: TRIPWIRE_STORE_VERSION, sessions: {} };
			}
			throw error;
		}
	}

	private ensureSessionStore(store: TripwireStore, sessionId: string): StoredTripwireSession {
		const existing = store.sessions[sessionId];
		if (existing) return existing;
		const created: StoredTripwireSession = { alerts: [], lastReadByClientId: {}, modifiedAtMs: Date.now() };
		store.sessions[sessionId] = created;
		return created;
	}

	private pruneSessionReaders(session: StoredTripwireSession): void {
		const sorted = Object.entries(session.lastReadByClientId).sort((a, b) => a[1] - b[1]);
		session.lastReadByClientId = keepNewestEntries(sorted, MAX_TRACKED_CLIENTS_PER_SESSION);
	}

	private pruneStore(store: TripwireStore): void {
		for (const session of Object.values(store.sessions)) {
			session.alerts = session.alerts.slice(-MAX_ALERTS_PER_SESSION);
			this.pruneSessionReaders(session);
		}

		const sortedSessions = Object.entries(store.sessions).sort((a, b) => a[1].modifiedAtMs - b[1].modifiedAtMs);
		store.sessions = keepNewestEntries(sortedSessions, MAX_TRACKED_SESSIONS);
	}
}
