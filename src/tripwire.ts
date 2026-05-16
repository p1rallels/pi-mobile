import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";
import type { ApiTripwireAlert, ApiTripwireAlertsResponse, ApiTripwireCategory, ApiTripwireResponse, ApiTripwireSeverity } from "./types.ts";

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
	shouldAbort: boolean;
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

function isWithinRoot(targetPath: string, rootPath: string): boolean {
	const normalizedTarget = resolve(targetPath);
	const normalizedRoot = resolve(rootPath);
	if (normalizedRoot === sep) return true;
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
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

function lowerCasePaths(paths: string[]): string[] {
	return paths.map((path) => path.toLowerCase());
}

export class TripwireService {
	private storePath: string;
	private appStateRoot: string;
	private secretRoots: string[];
	private secretFiles: string[];
	private persistenceRoots: string[];
	private persistenceFiles: string[];
	private storePromise: Promise<TripwireStore> | null = null;
	private mutationChain: Promise<void> = Promise.resolve();
	private rateWindows = new Map<string, ToolRateWindow>();

	constructor(storePath = join(homedir(), ".pi", "agent", "pi-web", "tripwire-state.json")) {
		this.storePath = storePath;
		this.appStateRoot = resolve(homedir(), ".pi", "agent");

		this.secretRoots = [
			join(homedir(), ".ssh"),
			join(homedir(), ".aws"),
			join(homedir(), ".gnupg"),
			join(homedir(), ".docker"),
			join(homedir(), ".kube"),
			join(homedir(), ".azure"),
			join(homedir(), ".config", "gcloud"),
		].map((path) => resolve(path));
		this.secretFiles = [
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
	}

	inspectEvent(context: TripwireSessionContext, event: AgentSessionEvent): TripwireInspectionResult {
		if (!event || typeof event !== "object" || typeof event.type !== "string") {
			return { alerts: [], shouldAbort: false };
		}

		if (event.type === "tool_execution_start") {
			const toolAlert = this.inspectToolStart(context, event.toolName, event.toolCallId, event.args);
			if (toolAlert) {
				return {
					alerts: [toolAlert],
					shouldAbort: toolAlert.response === "abort_requested",
				};
			}

			const rateAlert = this.inspectToolRate(context.sessionId, event.toolName);
			if (rateAlert) {
				return { alerts: [rateAlert], shouldAbort: false };
			}
		}

		if (event.type === "tool_execution_end") {
			const failureAlert = this.inspectFailureRate(context.sessionId, Boolean(event.isError));
			if (failureAlert) {
				return { alerts: [failureAlert], shouldAbort: false };
			}
		}

		return { alerts: [], shouldAbort: false };
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
				response: "abort_requested",
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
				response: "abort_requested",
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
				response: "abort_requested",
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
				response: "abort_requested",
			});
		}

		return null;
	}

	private inspectToolPaths(context: TripwireSessionContext, toolName: string, toolCallId: string, args: unknown): StoredTripwireAlert | null {
		const rawPaths = this.extractPaths(toolName, args);
		if (rawPaths.length === 0) return null;

		const allowedRoots = [...new Set([resolve(context.cwd), this.appStateRoot, ...[...context.allowedRoots].map((root) => resolve(root))])];
		const isWriteLike = toolName === "write" || toolName === "edit";
		let observedPath: string | null = null;

		for (const rawPath of rawPaths) {
			const resolvedPath = resolveAgainstCwd(context.cwd, rawPath);

			if (this.isSecretPath(resolvedPath)) {
				return this.createAlert({
					sessionId: context.sessionId,
					severity: "critical",
					category: "secret_access",
					summary: "Tripwire: sensitive host secret path access detected.",
					detail: `Path: ${resolvedPath}`,
					toolName,
					toolCallId,
					response: "abort_requested",
				});
			}

			if (this.isPersistencePath(resolvedPath)) {
				return this.createAlert({
					sessionId: context.sessionId,
					severity: "critical",
					category: "persistence",
					summary: "Tripwire: host persistence path targeted.",
					detail: `Path: ${resolvedPath}`,
					toolName,
					toolCallId,
					response: "abort_requested",
				});
			}

			const isAllowed = allowedRoots.some((root) => isWithinRoot(resolvedPath, root));
			if (!isAllowed) {
				if (isWriteLike) {
					return this.createAlert({
						sessionId: context.sessionId,
						severity: "critical",
						category: "repo_escape",
						summary: "Tripwire: repo-external write/edit detected.",
						detail: `Path: ${resolvedPath}`,
						toolName,
						toolCallId,
						response: "abort_requested",
					});
				}
				if (!observedPath) observedPath = resolvedPath;
			}
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

	private extractPaths(toolName: string, args: unknown): string[] {
		if (!args || typeof args !== "object") return [];
		const input = args as Record<string, unknown>;

		if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName) && typeof input.path === "string") {
			return [input.path];
		}

		const rawPaths: string[] = [];
		for (const key of ["path", "from", "to", "oldPath", "newPath", "targetPath"]) {
			if (typeof input[key] === "string") rawPaths.push(input[key] as string);
		}
		return rawPaths;
	}

	private isSecretPath(path: string): boolean {
		const normalized = resolve(path);
		if (isWithinRoot(normalized, this.appStateRoot)) return false;
		if (this.secretFiles.some((file) => normalized === file)) return true;
		return this.secretRoots.some((root) => isWithinRoot(normalized, root));
	}

	private isPersistencePath(path: string): boolean {
		const normalized = resolve(path);
		if (this.persistenceFiles.some((file) => normalized === file)) return true;
		return this.persistenceRoots.some((root) => isWithinRoot(normalized, root));
	}

	private commandReferencesSecrets(command: string): boolean {
		const refs = lowerCasePaths([
			...this.secretRoots,
			...this.secretFiles,
			...this.secretRoots.map((path) => path.replace(homedir(), "$HOME")),
			...this.secretRoots.map((path) => path.replace(homedir(), "~")),
			...this.secretFiles.map((path) => path.replace(homedir(), "$HOME")),
			...this.secretFiles.map((path) => path.replace(homedir(), "~")),
		]);
		return refs.some((ref) => ref && command.includes(ref));
	}

	private commandLooksPersistent(command: string): boolean {
		if (/\b(crontab|launchctl|systemctl|service|rc-update|update-rc\.d)\b/i.test(command)) return true;
		if (/(>>?|tee(?:\s+-a)?)\s+(~\/\.(zshrc|bashrc|bash_profile|profile)|\$home\/\.(zshrc|bashrc|bash_profile|profile))/i.test(command)) {
			return true;
		}
		const refs = lowerCasePaths([
			...this.persistenceRoots,
			...this.persistenceFiles,
			...this.persistenceRoots.map((path) => path.replace(homedir(), "$HOME")),
			...this.persistenceRoots.map((path) => path.replace(homedir(), "~")),
			...this.persistenceFiles.map((path) => path.replace(homedir(), "$HOME")),
			...this.persistenceFiles.map((path) => path.replace(homedir(), "~")),
		]);
		return refs.some((ref) => ref && command.includes(ref));
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
