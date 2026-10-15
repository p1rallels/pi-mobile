import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type InlineExtension,
	type PromptOptions,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { createExtensionUiBridge, type ApiExtensionUiResponse, type ExtensionUiBridge } from "./extension-ui.ts";
import { EMPTY_LIVE_SNAPSHOT, reduceLiveSnapshot, type LiveSnapshot } from "./live-snapshot.ts";
import {
	applyProjectTrustChoice,
	DEFAULT_PROJECT_TRUST_MODE,
	ProjectTrustRequiredError,
	projectTrustPrompt,
	resolveProjectTrust,
	type ApiProjectTrust,
	type ApiProjectTrustChoice,
	type ProjectTrustMode,
} from "./project-trust.ts";
import { createSessionIndex, type SessionSummary } from "./session-index.ts";
import { announcedEntryId, transcriptPage, transcriptSince, type TranscriptPage } from "./transcript.ts";
import { TripwireService, type TripwireMode } from "./tripwire.ts";
import { toWireEvent } from "./wire-events.ts";
import type {
	ApiCommandRequest,
	ApiCommandResponse,
	ApiCreateSessionRequest,
	ApiPromptDisposition,
	ApiModelInfo,
	ApiResyncTranscript,
	ApiSessionState,
	ApiSessionStatus,
	ApiSessionSummary,
	ClientRole,
	ApiSessionPatch,
	ApiTripwireAlertsResponse,
	SseEvent,
} from "./types.ts";
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";

export interface SessionClient {
	connectionId: string;
	clientId: string;
	/** `id` is the entry cursor a reconnect can resume from. */
	send(event: SseEvent, id?: string): void;
	close(): void;
}

export type InitSseEvent = Extract<SseEvent, { type: "init" }>;

interface RunningSession {
	session: AgentSession;
	ui: ExtensionUiBridge;
	projectTrust: ApiProjectTrust;
	cwd: string;
	sessionFile: string | null;
	createdAtMs: number;
	modifiedAtMs: number;
	lastSeenAtMs: number;
	controllerClientId: string | null;
	controllerHandoffTimer: ReturnType<typeof setTimeout> | null;
	clients: Map<string, SessionClient>;
	unsubscribe: (() => void) | null;
	tripwireAllowedRoots: Set<string>;
	tripwireStopRequested: boolean;
	live: LiveSnapshot;
	outbox: SseEvent[];
	flushScheduled: boolean;
}

interface PiWebRuntimeOptions {
	maxRunningSessions?: number;
	maxClientsPerSession?: number;
	idleSessionTtlMs?: number;
	controllerGraceMs?: number;
	modelRuntime?: ModelRuntime;
	projectTrustMode?: ProjectTrustMode;
	tripwire?: TripwireMode;
}

interface DetachedSession {
	sessionId: string;
	size: number;
	mtimeMs: number;
	detachedAtMs: number;
	/** The trust decision the session ran with, so an unanswered "ask" never comes back on re-attach. */
	projectTrusted?: boolean;
}

const DETACHED_RECORD_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_DETACHED_RECORDS = 500;

function parseDetachedRecords(raw: unknown): Array<[string, DetachedSession]> {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((record): Array<[string, DetachedSession]> => {
		if (!record || typeof record !== "object") return [];
		const { path, sessionId, size, mtimeMs, detachedAtMs, projectTrusted } = record as Record<string, unknown>;
		if (typeof path !== "string" || typeof sessionId !== "string" || typeof size !== "number" || typeof mtimeMs !== "number") return [];
		return [
			[
				path,
				{
					sessionId,
					size,
					mtimeMs,
					detachedAtMs: typeof detachedAtMs === "number" ? detachedAtMs : Date.now(),
					...(typeof projectTrusted === "boolean" ? { projectTrusted } : {}),
				},
			],
		];
	});
}

const DEFAULT_IDLE_SESSION_TTL_MS = 15 * 60_000;
const DEFAULT_CONTROLLER_GRACE_MS = 10_000;

function fileFingerprint(path: string): { size: number; mtimeMs: number } | null {
	try {
		const info = statSync(path);
		return { size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}
const IDLE_SWEEP_INTERVAL_MS = 60_000;

type SessionThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

const INITIAL_TRANSCRIPT_MESSAGES = 150;
const INITIAL_TRANSCRIPT_BYTES = 600_000;
const TRANSCRIPT_PAGE_MESSAGES = 200;
const MAX_TRANSCRIPT_PAGE_MESSAGES = 500;
const TRANSCRIPT_PAGE_BYTES = 1_000_000;

const STATE_PATCH_EVENTS: ReadonlySet<AgentSessionEvent["type"]> = new Set<AgentSessionEvent["type"]>([
	"agent_start",
	"agent_end",
	"agent_settled",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"session_info_changed",
	"thinking_level_changed",
]);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly SessionThinkingLevel[];

function isThinkingLevel(value: string): value is SessionThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
		.map((c) => (c as { text: string }).text)
		.join("");
}

const FIRST_MESSAGE_CHARS = 280;

function trimFirstMessage(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > FIRST_MESSAGE_CHARS ? `${collapsed.slice(0, FIRST_MESSAGE_CHARS - 1)}…` : collapsed;
}

/** First user text in raw history; the model projection loses it after a compaction. */
function computeFirstMessage(session: AgentSession): string {
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractTextContent(entry.message.content);
		if (text.trim().length > 0) return trimFirstMessage(text);
	}
	return "(no messages)";
}

function toIso(ms: number): string {
	return new Date(ms).toISOString();
}

function safeModelSnapshot(session: AgentSession): ApiSessionState["model"] {
	const model = session.model;
	if (!model) return null;
	const name = typeof (model as { name?: unknown }).name === "string" ? (model as { name: string }).name : undefined;
	return { provider: model.provider, id: model.id, name };
}

function safeContextUsageSnapshot(session: AgentSession): ApiSessionState["contextUsage"] {
	try {
		const usage = session.getContextUsage();
		if (!usage) return null;
		return {
			tokens: typeof usage.tokens === "number" ? usage.tokens : null,
			contextWindow: usage.contextWindow,
			percent: typeof usage.percent === "number" ? usage.percent : null,
		};
	} catch {
		return null;
	}
}

function safeStatsSnapshot(session: AgentSession): ApiSessionState["stats"] {
	try {
		const stats = session.getSessionStats();
		return { tokens: stats.tokens, cost: stats.cost };
	} catch {
		return null;
	}
}

function safeQueuedMessagesSnapshot(session: AgentSession): ApiSessionState["queuedMessages"] {
	try {
		return {
			steering: [...session.getSteeringMessages()],
			followUp: [...session.getFollowUpMessages()],
		};
	} catch {
		return { steering: [], followUp: [] };
	}
}

const INITIAL_TRANSCRIPT_LIMITS = { maxMessages: INITIAL_TRANSCRIPT_MESSAGES, maxBytes: INITIAL_TRANSCRIPT_BYTES };

function buildState(session: AgentSession, cwd: string, projectTrust: ApiProjectTrust): ApiSessionState {
	const transcript = transcriptPage(session.sessionManager.getBranch(), INITIAL_TRANSCRIPT_LIMITS);
	return { ...buildStatus(session, cwd, projectTrust), messages: transcript.messages, hasOlderMessages: transcript.hasOlder };
}

function buildResyncTranscript(session: AgentSession, since: string | undefined): ApiResyncTranscript {
	const branch = session.sessionManager.getBranch();
	const missing = since === undefined ? null : transcriptSince(branch, since, INITIAL_TRANSCRIPT_LIMITS);
	if (since !== undefined && missing !== null) return { mode: "append", since, messages: missing };
	const page = transcriptPage(branch, INITIAL_TRANSCRIPT_LIMITS);
	return { mode: "replace", messages: page.messages, hasOlder: page.hasOlder };
}

function buildStatus(session: AgentSession, cwd: string, projectTrust: ApiProjectTrust): ApiSessionStatus {
	return {
		sessionId: session.sessionId,
		projectTrust,
		cwd,
		sessionFile: session.sessionFile ?? null,
		sessionName: session.sessionName,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		retryAttempt: session.retryAttempt,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessages: safeQueuedMessagesSnapshot(session),
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
	};
}

function buildPatch(session: AgentSession): ApiSessionPatch {
	return {
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		retryAttempt: session.retryAttempt,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		sessionName: session.sessionName,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessages: safeQueuedMessagesSnapshot(session),
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
	};
}

async function ensureDirectory(path: string): Promise<void> {
	let info: { isDirectory(): boolean };
	try {
		info = await stat(path);
	} catch {
		throw new Error(`cwd does not exist: ${path}`);
	}
	if (!info.isDirectory()) {
		throw new Error(`cwd is not a directory: ${path}`);
	}
}

function normalizeCwd(input: string): string {
	return resolve(input.trim());
}

function parseCompactCommandText(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === "/compact") return "";
	if (trimmed.startsWith("/compact ")) return trimmed.slice(9).trim();
	return null;
}

function parseQueueCommandText(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === "/queue") return "";
	if (trimmed.startsWith("/queue ")) return trimmed.slice(7).trim();
	return null;
}

/** Extension commands run to completion before pi acknowledges them, and may wait on a dialog for minutes. */
function isExtensionCommand(session: AgentSession, text: string): boolean {
	if (!text.startsWith("/")) return false;
	const name = text.slice(1).split(/\s/, 1)[0] ?? "";
	return name.length > 0 && session.extensionRunner.getCommand(name) !== undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves once pi accepted the prompt (started, queued or handled by an extension command) instead
 * of when the whole run finishes. Failures after acceptance go to onLateError.
 */
function promptUntilAccepted(
	session: AgentSession,
	text: string,
	options: Omit<PromptOptions, "preflightResult">,
	onLateError: (error: unknown) => void,
): Promise<ApiPromptDisposition> {
	return new Promise((resolve, reject) => {
		let accepted = false;
		const accept = (disposition: ApiPromptDisposition) => {
			if (accepted) return;
			accepted = true;
			resolve(disposition);
		};
		session.prompt(text, { ...options, preflightResult: accept }).then(
			// prompts submitted while agent_settled listeners run are deferred until they finish
			() => accept("queued"),
			(error: unknown) => {
				if (accepted) {
					onLateError(error);
				} else {
					reject(error);
				}
			},
		);
	});
}

function serializeSessionSummary(entry: SessionSummary, isRunning: boolean): ApiSessionSummary {
	return {
		id: entry.id,
		path: entry.path,
		cwd: entry.cwd,
		name: entry.name,
		firstMessage: entry.firstMessage || "(no messages)",
		created: entry.created,
		modified: entry.modified,
		messageCount: entry.messageCount,
		isRunning,
	};
}

export class PiWebRuntime {
	private runningById = new Map<string, RunningSession>();
	private runningByPath = new Map<string, string>();
	private resumingByPath = new Map<string, Promise<RunningSession>>();
	private detachedByPath = new Map<string, DetachedSession>();
	private agentDir = getAgentDir();
	private sessionIndex = createSessionIndex(join(this.agentDir, "sessions"));
	private detachedStorePath = join(this.agentDir, "pi-web", "detached-sessions.json");
	private detachedWrites: Promise<void> = Promise.resolve();
	private modelRuntimePromise: Promise<ModelRuntime>;
	private repoStorePath = join(this.agentDir, "pi-web", "repos.json");
	private internalStateRoot = this.agentDir;
	private tripwireService = new TripwireService(join(this.agentDir, "pi-web", "tripwire-state.json"));
	private maxRunningSessions: number;
	private maxClientsPerSession: number;
	private idleSessionTtlMs: number;
	private controllerGraceMs: number;
	private projectTrustMode: ProjectTrustMode;
	private tripwireMode: TripwireMode;
	private trustStore = new ProjectTrustStore(this.agentDir);

	constructor(options: PiWebRuntimeOptions = {}) {
		this.maxRunningSessions = options.maxRunningSessions ?? 24;
		this.maxClientsPerSession = options.maxClientsPerSession ?? 8;
		this.idleSessionTtlMs = options.idleSessionTtlMs ?? DEFAULT_IDLE_SESSION_TTL_MS;
		this.controllerGraceMs = options.controllerGraceMs ?? DEFAULT_CONTROLLER_GRACE_MS;
		this.projectTrustMode = options.projectTrustMode ?? DEFAULT_PROJECT_TRUST_MODE;
		this.tripwireMode = options.tripwire ?? "on";
		this.modelRuntimePromise = options.modelRuntime
			? Promise.resolve(options.modelRuntime)
			: ModelRuntime.create({ authPath: join(this.agentDir, "auth.json"), modelsPath: join(this.agentDir, "models.json") });
	}

	private async loadReposFromDisk(): Promise<string[]> {
		try {
			const parsed = await readPrivateJsonFile<unknown>(this.repoStorePath);
			if (!Array.isArray(parsed)) {
				throw new Error(`Invalid repo store: ${this.repoStorePath}`);
			}
			return parsed.filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean);
		} catch (error) {
			if (isMissingFileError(error)) return [];
			throw error;
		}
	}

	private async saveReposToDisk(repos: string[]): Promise<void> {
		await writePrivateJsonFile(this.repoStorePath, repos);
	}

	private async refreshModelRuntime(): Promise<ModelRuntime> {
		const modelRuntime = await this.modelRuntimePromise;
		await modelRuntime.refresh({ allowNetwork: false });
		return modelRuntime;
	}

	/**
	 * trust.json first, then PI_WEB_PROJECT_TRUST. A re-attach reuses the decision the session ran with
	 * instead of asking again; "ask" without an answer is reported so the page can prompt and retry.
	 */
	private decideProjectTrust(cwd: string, choice?: ApiProjectTrustChoice, restored?: boolean): ApiProjectTrust {
		const resolved = resolveProjectTrust(cwd, this.trustStore, this.projectTrustMode);
		if (resolved) return resolved;
		if (restored !== undefined) return { trusted: restored, gated: true, source: "restored" };
		if (choice) return applyProjectTrustChoice(cwd, choice, this.trustStore);
		throw new ProjectTrustRequiredError(projectTrustPrompt(cwd));
	}

	private async createRuntimeSession(
		cwd: string,
		sessionManager: SessionManager,
		projectTrust: ApiProjectTrust,
	): Promise<{ session: AgentSession; ui: ExtensionUiBridge }> {
		const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: projectTrust.trusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			settingsManager,
			extensionFactories: this.tripwireMode === "on" ? [this.tripwireGuard()] : [],
		});
		const modelRuntime = await this.refreshModelRuntime();
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			sessionManager,
			modelRuntime,
			settingsManager,
			resourceLoader,
		});
		const ui = createExtensionUiBridge({
			emit: (event) => this.broadcast(session.sessionId, event),
			fallback: session.extensionRunner.getUIContext(),
		});
		await session.bindExtensions({
			uiContext: ui.context,
			mode: "rpc",
			onError: (error) => {
				console.error(`[pi-web extension] ${error.extensionPath} ${error.event}: ${error.error}`);
			},
		});
		return { session, ui };
	}

	private tripwireGuard(): InlineExtension {
		return {
			name: "pi-web-tripwire",
			hidden: true,
			factory: (pi) => {
				pi.on("tool_call", (event, ctx) => this.guardToolCall(ctx.sessionManager.getSessionId(), ctx.cwd, event));
			},
		};
	}

	/** Blocks critical tool calls before they run and stops the run for a human to look. */
	private guardToolCall(sessionId: string, cwd: string, event: ToolCallEvent): ToolCallEventResult | undefined {
		const runtime = this.runningById.get(sessionId);
		const context = runtime
			? { sessionId, cwd: runtime.cwd, allowedRoots: runtime.tripwireAllowedRoots }
			: { sessionId, cwd, allowedRoots: [cwd, this.internalStateRoot] };
		const inspection = this.tripwireService.inspectToolCall(context, event.toolName, event.toolCallId, event.input);
		for (const alert of inspection.alerts) {
			this.broadcast(sessionId, { type: "tripwire_alert", alert: this.tripwireService.toApiAlert(alert) });
		}
		void this.tripwireService.recordAlerts(sessionId, inspection.alerts);
		const blocking = inspection.shouldBlock ? inspection.alerts[0] : undefined;
		if (!blocking) return undefined;
		if (runtime && !runtime.tripwireStopRequested) {
			runtime.tripwireStopRequested = true;
			// aborting inside the handler would replace the block reason with "Operation aborted"
			setTimeout(() => void runtime.session.abort().catch(() => {}), 0);
		}
		const detail = blocking.detail ? ` ${blocking.detail}` : "";
		return { block: true, terminate: true, reason: `Blocked by the pi-web tripwire: ${blocking.summary}${detail}` };
	}

	async listRepos(): Promise<string[]> {
		const repos = new Set<string>();
		repos.add(resolve(process.cwd()));

		for (const repo of await this.loadReposFromDisk()) {
			repos.add(repo);
		}

		for (const runtime of this.runningById.values()) {
			if (runtime.cwd.trim()) repos.add(runtime.cwd.trim());
		}

		return [...repos].sort((a, b) => a.localeCompare(b));
	}

	async addRepo(rawCwd: string): Promise<void> {
		const cwd = normalizeCwd(rawCwd);
		await ensureDirectory(cwd);

		const repos = new Set(await this.loadReposFromDisk());
		repos.add(cwd);
		await this.saveReposToDisk([...repos].sort((a, b) => a.localeCompare(b)));

		for (const runtime of this.runningById.values()) {
			runtime.tripwireAllowedRoots.add(cwd);
		}
	}

	listActiveSessions(): ApiSessionSummary[] {
		const sessions: ApiSessionSummary[] = [];
		for (const runtime of this.runningById.values()) {
			sessions.push({
				id: runtime.session.sessionId,
				path: runtime.sessionFile && existsSync(runtime.sessionFile) ? runtime.sessionFile : null,
				cwd: runtime.cwd,
				name: runtime.session.sessionName,
				firstMessage: computeFirstMessage(runtime.session),
				created: toIso(runtime.createdAtMs),
				modified: toIso(runtime.modifiedAtMs),
				messageCount: runtime.session.messages.length,
				isRunning: true,
			});
		}
		sessions.sort((a, b) => b.modified.localeCompare(a.modified));
		return sessions;
	}

	async listSessions(options: { cwd?: string; limit?: number; offset?: number } = {}): Promise<{ sessions: ApiSessionSummary[]; hasMore: boolean }> {
		const saved = await this.sessionIndex.list({ cwd: options.cwd }).catch(() => []);
		const byId = new Map<string, ApiSessionSummary>();

		for (const entry of saved) {
			byId.set(entry.id, serializeSessionSummary(entry, this.runningByPath.has(resolve(entry.path))));
		}

		for (const [sessionId, runtime] of this.runningById.entries()) {
			if (options.cwd !== undefined && runtime.cwd !== options.cwd) continue;
			// If the saved list already contains this session id, just mark it running and move on.
			const existing = byId.get(sessionId);
			if (existing) {
				existing.isRunning = true;
				existing.modified = toIso(runtime.modifiedAtMs);
				existing.messageCount = runtime.session.messages.length;
				continue;
			}

			// Running session may not have flushed to disk yet (no assistant message).
			const path = runtime.sessionFile;
			const createdAt = runtime.createdAtMs;
			const modifiedAt = runtime.modifiedAtMs;
			byId.set(sessionId, {
				id: sessionId,
				path: path && existsSync(path) ? path : null,
				cwd: runtime.cwd,
				name: runtime.session.sessionName,
				firstMessage: computeFirstMessage(runtime.session),
				created: toIso(createdAt),
				modified: toIso(modifiedAt),
				messageCount: runtime.session.messages.length,
				isRunning: true,
			});
		}

		const sessions = [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
		const offset = Math.max(0, Math.floor(options.offset ?? 0));
		const limit = Math.max(1, Math.floor(options.limit ?? sessions.length));
		return { sessions: sessions.slice(offset, offset + limit), hasMore: offset + limit < sessions.length };
	}

	private async assertAllowedCwd(rawCwd: string): Promise<string> {
		const cwd = normalizeCwd(rawCwd);
		await ensureDirectory(cwd);

		const allowed = new Set(await this.listRepos());
		if (!allowed.has(cwd)) {
			throw new Error(`cwd_not_allowed: ${cwd}`);
		}

		return cwd;
	}

	/** Session files live one directory below the sessions root, like SessionManager.listAll() finds them. */
	private assertAllowedResumePath(rawPath: string): string {
		const path = resolve(rawPath.trim());
		const sessionsDir = resolve(this.agentDir, "sessions");
		const isRunning = this.runningByPath.has(path);
		if (!isRunning && (dirname(dirname(path)) !== sessionsDir || extname(path) !== ".jsonl")) {
			throw new Error(`session_path_not_allowed: ${path}`);
		}
		return path;
	}

	async listModels(): Promise<ApiModelInfo[]> {
		const modelRuntime = await this.refreshModelRuntime();
		return modelRuntime.getAvailableSnapshot().map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	}

	isRunning(sessionId: string): boolean {
		return this.runningById.has(sessionId);
	}

	getHealth(): { runningSessions: number; busySessions: number; viewers: number; detachedSessions: number; tripwire: TripwireMode; projectTrust: ProjectTrustMode } {
		const runtimes = [...this.runningById.values()];
		return {
			tripwire: this.tripwireMode,
			projectTrust: this.projectTrustMode,
			runningSessions: runtimes.length,
			busySessions: runtimes.filter((runtime) => !runtime.session.isIdle).length,
			viewers: runtimes.reduce((total, runtime) => total + runtime.clients.size, 0),
			detachedSessions: this.detachedByPath.size,
		};
	}

	getSessionState(sessionId: string): ApiSessionState {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		return buildState(runtime.session, runtime.cwd, runtime.projectTrust);
	}

	getTranscriptPage(sessionId: string, request: { before?: string; limit?: number }): TranscriptPage {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		const limit = Math.min(Math.max(1, Math.floor(request.limit ?? TRANSCRIPT_PAGE_MESSAGES)), MAX_TRANSCRIPT_PAGE_MESSAGES);
		return transcriptPage(runtime.session.sessionManager.getBranch(), {
			before: request.before,
			maxMessages: limit,
			maxBytes: TRANSCRIPT_PAGE_BYTES,
		});
	}

	async getTripwireAlerts(sessionId: string, clientId: string): Promise<ApiTripwireAlertsResponse> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		return this.tripwireService.consumeAlerts(sessionId, clientId);
	}

	getSessionRole(sessionId: string, clientId: string): { role: ClientRole; controllerClientId: string | null } {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		const controllerClientId = runtime.controllerClientId;
		const role: ClientRole = controllerClientId === clientId ? "controller" : "viewer";
		return { role, controllerClientId };
	}

	addClient(sessionId: string, client: SessionClient): { role: ClientRole; controllerClientId: string | null } {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		if (!runtime.clients.has(client.connectionId) && runtime.clients.size >= this.maxClientsPerSession) {
			throw new Error("too_many_clients");
		}
		runtime.clients.set(client.connectionId, client);
		runtime.lastSeenAtMs = Date.now();
		if (client.clientId === runtime.controllerClientId) this.cancelControllerHandoff(runtime);
		this.claimControllerIfVacant(runtime, client.clientId);
		return this.getSessionRole(sessionId, client.clientId);
	}

	/**
	 * Registers a viewer and builds its init event in one synchronous step, after delivering queued events
	 * to the existing viewers, so the snapshot and the live stream that follows neither overlap nor leave a gap.
	 */
	connectClient(sessionId: string, client: SessionClient, since?: string): { init: InitSseEvent; cursor: string | undefined } {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		this.flushOutbox(runtime);
		const transcript = buildResyncTranscript(runtime.session, since);
		const cursor = runtime.session.sessionManager.getLeafId();
		const live = runtime.live;
		const { role, controllerClientId } = this.addClient(sessionId, client);
		return {
			init: {
				type: "init",
				state: buildStatus(runtime.session, runtime.cwd, runtime.projectTrust),
				transcript,
				live,
				ui: runtime.ui.snapshot(),
				cursor,
				yourClientId: client.clientId,
				controllerClientId,
				role,
			},
			cursor: cursor ?? undefined,
		};
	}

	removeClient(sessionId: string, connectionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		runtime.clients.delete(connectionId);
		runtime.lastSeenAtMs = Date.now();
		if (!this.isControllerConnected(runtime)) this.scheduleControllerHandoff(runtime);
	}

	private isControllerConnected(runtime: RunningSession): boolean {
		return [...runtime.clients.values()].some((client) => client.clientId === runtime.controllerClientId);
	}

	private cancelControllerHandoff(runtime: RunningSession): void {
		if (runtime.controllerHandoffTimer) clearTimeout(runtime.controllerHandoffTimer);
		runtime.controllerHandoffTimer = null;
	}

	/**
	 * A controller whose device dropped (phone locked, network gone) would otherwise strand the run:
	 * after a short grace period control moves to the most recent other viewer, or is left vacant.
	 */
	private scheduleControllerHandoff(runtime: RunningSession): void {
		if (runtime.controllerHandoffTimer || runtime.controllerClientId === null) return;
		runtime.controllerHandoffTimer = setTimeout(() => {
			runtime.controllerHandoffTimer = null;
			if (this.runningById.get(runtime.session.sessionId) !== runtime || this.isControllerConnected(runtime)) return;
			const next = [...runtime.clients.values()].at(-1)?.clientId ?? null;
			this.setController(runtime, next);
		}, this.controllerGraceMs);
		runtime.controllerHandoffTimer.unref?.();
	}

	private setController(runtime: RunningSession, clientId: string | null): void {
		this.cancelControllerHandoff(runtime);
		if (runtime.controllerClientId === clientId) return;
		runtime.controllerClientId = clientId;
		this.broadcast(runtime.session.sessionId, { type: "controller_changed", controllerClientId: clientId });
	}

	async startSession(request: ApiCreateSessionRequest): Promise<{ sessionId: string }> {
		const clientId = request.clientId ?? randomUUID();

		if (request.resumeSessionPath) {
			const runtime = await this.resumeSession(this.assertAllowedResumePath(request.resumeSessionPath), clientId, { choice: request.projectTrust });
			return { sessionId: runtime.session.sessionId };
		}

		const cwd = await this.assertAllowedCwd(request.cwd ?? process.cwd());
		const projectTrust = this.decideProjectTrust(cwd, request.projectTrust);
		this.ensureCapacity();
		const sessionManager = SessionManager.create(cwd);
		const { session, ui } = await this.createRuntimeSession(cwd, sessionManager, projectTrust);
		const tripwireAllowedRoots = await this.buildTripwireAllowedRoots(cwd);
		const runtime = this.registerSession(session, ui, projectTrust, cwd, clientId, tripwireAllowedRoots);
		return { sessionId: runtime.session.sessionId };
	}

	/**
	 * Brings back a session pi-web disposed for idling, as long as nothing else (e.g. the pi CLI)
	 * wrote to its file since. Released sessions and files changed elsewhere need an explicit reopen.
	 */
	async attachSession(sessionId: string, rawPath: string | undefined, clientId: string): Promise<void> {
		if (this.runningById.has(sessionId)) return;
		if (!rawPath) throw new Error("session_not_running");
		const path = this.assertAllowedResumePath(rawPath);
		if (!this.resumingByPath.has(path) && !this.isUnchangedSinceDetach(path, sessionId)) {
			throw new Error("session_not_attachable");
		}
		await this.resumeSession(path, clientId, { expectedSessionId: sessionId, restoredTrust: this.detachedByPath.get(path)?.projectTrusted });
	}

	private isUnchangedSinceDetach(path: string, sessionId: string): boolean {
		const detached = this.detachedByPath.get(path);
		const current = fileFingerprint(path);
		return Boolean(
			detached && current && detached.sessionId === sessionId && detached.size === current.size && detached.mtimeMs === current.mtimeMs,
		);
	}

	private rememberDetached(runtime: RunningSession): void {
		const fingerprint = runtime.sessionFile ? fileFingerprint(runtime.sessionFile) : null;
		if (!runtime.sessionFile || !fingerprint) return;
		this.detachedByPath.set(runtime.sessionFile, {
			sessionId: runtime.session.sessionId,
			...fingerprint,
			detachedAtMs: Date.now(),
			projectTrusted: runtime.projectTrust.trusted,
		});
		this.persistDetached();
	}

	/** Restores re-attach records written before a restart, keeping only files nobody touched since. */
	async loadDetachedSessions(now = Date.now()): Promise<number> {
		let raw: unknown = [];
		try {
			raw = await readPrivateJsonFile<unknown>(this.detachedStorePath);
		} catch (error) {
			if (!isMissingFileError(error)) console.error(`[pi-web] ignoring unreadable ${this.detachedStorePath}: ${errorMessage(error)}`);
		}
		for (const [path, record] of parseDetachedRecords(raw)) {
			const current = fileFingerprint(path);
			const fresh = now - record.detachedAtMs < DETACHED_RECORD_TTL_MS;
			if (fresh && current && current.size === record.size && current.mtimeMs === record.mtimeMs) {
				this.detachedByPath.set(path, record);
			}
		}
		return this.detachedByPath.size;
	}

	private persistDetached(): void {
		this.detachedWrites = this.detachedWrites
			.then(() => {
				const records = [...this.detachedByPath.entries()]
					.sort(([, a], [, b]) => b.detachedAtMs - a.detachedAtMs)
					.slice(0, MAX_DETACHED_RECORDS)
					.map(([path, record]) => ({ path, ...record }));
				return writePrivateJsonFile(this.detachedStorePath, records);
			})
			.catch((error: unknown) => {
				console.error(`[pi-web] failed to save ${this.detachedStorePath}: ${errorMessage(error)}`);
			});
	}

	/** Stops runs, records every session for re-attach after the restart, and disposes them. */
	async shutdown(timeoutMs = 5_000): Promise<void> {
		const runtimes = [...this.runningById.values()];
		const stopped = Promise.allSettled(
			runtimes.map(async (runtime) => {
				runtime.session.abortCompaction();
				await runtime.session.abort();
			}),
		);
		await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
		for (const runtime of runtimes) {
			this.rememberDetached(runtime);
			this.disposeRuntime(runtime);
		}
		await this.detachedWrites;
	}

	private async resumeSession(
		path: string,
		clientId: string,
		options: { expectedSessionId?: string; choice?: ApiProjectTrustChoice; restoredTrust?: boolean } = {},
	): Promise<RunningSession> {
		const { expectedSessionId } = options;
		const existingId = this.runningByPath.get(path);
		const existing = existingId ? this.runningById.get(existingId) : undefined;
		if (existing) {
			if (expectedSessionId !== undefined && existing.session.sessionId !== expectedSessionId) {
				throw new Error("session_path_mismatch");
			}
			this.claimControllerIfVacant(existing, clientId);
			return existing;
		}

		const pending = this.resumingByPath.get(path);
		if (pending) {
			const runtime = await pending;
			if (expectedSessionId !== undefined && runtime.session.sessionId !== expectedSessionId) {
				throw new Error("session_path_mismatch");
			}
			return runtime;
		}

		this.ensureCapacity();
		const resuming = this.openSessionFile(path, clientId, options)
			.then((runtime) => {
				if (this.detachedByPath.delete(path)) this.persistDetached();
				return runtime;
			})
			.finally(() => {
				this.resumingByPath.delete(path);
			});
		this.resumingByPath.set(path, resuming);
		return resuming;
	}

	private async openSessionFile(
		path: string,
		clientId: string,
		options: { expectedSessionId?: string; choice?: ApiProjectTrustChoice; restoredTrust?: boolean },
	): Promise<RunningSession> {
		if (!existsSync(path)) {
			throw new Error(`session file does not exist: ${path}`);
		}
		const sessionManager = SessionManager.open(path);
		if (options.expectedSessionId !== undefined && sessionManager.getSessionId() !== options.expectedSessionId) {
			throw new Error("session_path_mismatch");
		}
		const cwd = sessionManager.getCwd();
		const projectTrust = this.decideProjectTrust(cwd, options.choice, options.restoredTrust);
		const { session, ui } = await this.createRuntimeSession(cwd, sessionManager, projectTrust);
		const tripwireAllowedRoots = await this.buildTripwireAllowedRoots(cwd);
		return this.registerSession(session, ui, projectTrust, cwd, clientId, tripwireAllowedRoots);
	}

	private claimControllerIfVacant(runtime: RunningSession, clientId: string): void {
		if (runtime.controllerClientId !== null) return;
		this.setController(runtime, clientId);
	}

	private lastActivityAtMs(runtime: RunningSession): number {
		return Math.max(runtime.modifiedAtMs, runtime.lastSeenAtMs);
	}

	private isEvictable(runtime: RunningSession): boolean {
		return runtime.clients.size === 0 && runtime.session.isIdle;
	}

	/** Frees a slot by disposing the least recently used idle session nobody is watching. */
	private ensureCapacity(): void {
		if (this.runningById.size + this.resumingByPath.size < this.maxRunningSessions) return;
		const victim = [...this.runningById.values()]
			.filter((runtime) => this.isEvictable(runtime))
			.sort((a, b) => this.lastActivityAtMs(a) - this.lastActivityAtMs(b))[0];
		if (!victim) throw new Error("too_many_active_sessions");
		this.rememberDetached(victim);
		this.disposeRuntime(victim);
	}

	/** Disposes idle sessions without viewers; their jsonl is already persisted, so attaching resumes them. */
	evictIdleSessions(now = Date.now()): string[] {
		const expired = [...this.runningById.values()].filter(
			(runtime) =>
				this.isEvictable(runtime) &&
				runtime.sessionFile !== null &&
				existsSync(runtime.sessionFile) &&
				now - this.lastActivityAtMs(runtime) >= this.idleSessionTtlMs,
		);
		for (const runtime of expired) {
			this.rememberDetached(runtime);
			this.disposeRuntime(runtime);
		}
		return expired.map((runtime) => runtime.session.sessionId);
	}

	startIdleSweep(intervalMs = IDLE_SWEEP_INTERVAL_MS): () => void {
		const timer = setInterval(() => {
			for (const sessionId of this.evictIdleSessions()) {
				console.log(`[pi-web] disposed idle session ${sessionId}`);
			}
		}, intervalMs);
		timer.unref?.();
		return () => clearInterval(timer);
	}

	private disposeRuntime(runtime: RunningSession): void {
		const sessionId = runtime.session.sessionId;
		this.cancelControllerHandoff(runtime);
		runtime.ui.dispose();
		this.flushOutbox(runtime);
		for (const client of runtime.clients.values()) {
			client.close();
		}
		try {
			runtime.session.dispose();
		} catch {
			// best effort
		}
		try {
			runtime.unsubscribe?.();
		} catch {
			// best effort
		}
		this.runningById.delete(sessionId);
		if (runtime.sessionFile) {
			this.runningByPath.delete(runtime.sessionFile);
		}
		this.tripwireService.forgetSession(sessionId);
	}

	private startManualCompaction(runtime: RunningSession, customInstructions: string | undefined): void {
		if (runtime.session.isCompacting) return;
		if (runtime.session.messages.length < 2) {
			throw new Error("Nothing to compact (no messages yet)");
		}
		const trimmedInstructions = typeof customInstructions === "string" ? customInstructions.trim() : "";
		void runtime.session.compact(trimmedInstructions || undefined).catch(() => {});
	}

	async handleCommand(sessionId: string, command: ApiCommandRequest): Promise<ApiCommandResponse> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}

		if (command.type === "abort") {
			// stopping a run is always allowed: every viewer is the same user behind mTLS + WebAuthn
			runtime.session.abortCompaction();
			await runtime.session.abort();
			return { ok: true };
		}

		if (command.type === "compact") {
			this.assertController(runtime, command.clientId);
			this.startManualCompaction(runtime, command.customInstructions);
			return { ok: true };
		}

		if (command.type === "prompt") {
			this.assertController(runtime, command.clientId);
			const text = command.text.trim();
			if (text.length === 0) return { ok: true, disposition: "handled" };
			const customInstructions = parseCompactCommandText(text);
			if (customInstructions !== null) {
				this.startManualCompaction(runtime, customInstructions);
				return { ok: true, disposition: "handled" };
			}
			const queuedText = parseQueueCommandText(text);
			const promptText = (queuedText ?? text).trim();
			if (promptText.length === 0) return { ok: true, disposition: "handled" };
			const streamingBehavior = queuedText !== null ? "followUp" : (command.deliverAs ?? "steer");
			if (isExtensionCommand(runtime.session, promptText)) {
				void runtime.session.prompt(promptText, { streamingBehavior }).catch((error: unknown) => {
					this.broadcast(sessionId, { type: "command_error", command: "prompt", message: errorMessage(error) });
				});
				return { ok: true, disposition: "handled" };
			}
			const disposition = await promptUntilAccepted(runtime.session, promptText, { streamingBehavior }, (error) => {
				this.broadcast(sessionId, { type: "command_error", command: "prompt", message: errorMessage(error) });
			});
			return { ok: true, disposition };
		}

		if (command.type === "set_model") {
			this.assertController(runtime, command.clientId);
			const provider = command.provider.trim();
			const modelId = command.modelId.trim();
			if (!provider || !modelId) throw new Error("invalid_model");
			const modelRuntime = await this.refreshModelRuntime();
			const model = modelRuntime.getAvailableSnapshot().find((m) => m.provider === provider && m.id === modelId);
			if (!model) throw new Error(`model_not_available: ${provider}/${modelId}`);
			await runtime.session.setModel(model);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return { ok: true };
		}

		if (command.type === "set_thinking_level") {
			this.assertController(runtime, command.clientId);
			const level = command.level.trim();
			if (!isThinkingLevel(level)) throw new Error(`invalid_thinking_level: ${level}`);
			runtime.session.setThinkingLevel(level);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return { ok: true };
		}

		if (command.type === "set_steering_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_steering_mode: ${String(mode)}`);
			runtime.session.setSteeringMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return { ok: true };
		}

		if (command.type === "set_follow_up_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_follow_up_mode: ${String(mode)}`);
			runtime.session.setFollowUpMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return { ok: true };
		}

		if (command.type === "set_auto_compaction") {
			this.assertController(runtime, command.clientId);
			runtime.session.setAutoCompactionEnabled(Boolean(command.enabled));
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return { ok: true };
		}

		if (command.type === "set_session_name") {
			this.assertController(runtime, command.clientId);
			const name = command.name.trim();
			if (!name) throw new Error("invalid_session_name");
			runtime.session.setSessionName(name);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return { ok: true };
		}

		throw new Error(`unknown_command: ${String((command as { type?: unknown }).type)}`);
	}

	/** Any viewer may answer: every device is the same user behind mTLS + WebAuthn. */
	answerExtensionUi(sessionId: string, response: ApiExtensionUiResponse): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		const result = runtime.ui.respond(response);
		if (result === "unknown") throw new Error("unknown_dialog");
		if (result === "invalid") throw new Error("invalid_dialog_answer");
	}

	takeover(sessionId: string, request: { clientId: string }): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		this.setController(runtime, request.clientId);
	}

	async release(sessionId: string, request: { clientId: string }): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		this.assertController(runtime, request.clientId);

		this.broadcast(sessionId, { type: "released", byClientId: request.clientId });

		try {
			runtime.session.abortCompaction();
			await runtime.session.abort();
		} catch {
			// best effort
		}
		this.disposeRuntime(runtime);
	}

	private async buildTripwireAllowedRoots(cwd: string): Promise<Set<string>> {
		const roots = new Set<string>();
		roots.add(resolve(cwd));
		roots.add(resolve(process.cwd()));
		roots.add(resolve(this.internalStateRoot));

		for (const repo of await this.loadReposFromDisk()) {
			roots.add(resolve(repo));
		}

		return roots;
	}

	private registerSession(
		session: AgentSession,
		ui: ExtensionUiBridge,
		projectTrust: ApiProjectTrust,
		cwd: string,
		controllerClientId: string,
		tripwireAllowedRoots: Set<string>,
	): RunningSession {
		const sessionId = session.sessionId;
		const sessionFile = session.sessionFile ? resolve(session.sessionFile) : null;

		if ((sessionFile && this.runningByPath.has(sessionFile)) || this.runningById.has(sessionId)) {
			ui.dispose();
			session.dispose();
			throw new Error("session_already_running");
		}

		const createdAtMs = Date.now();
		const runtime: RunningSession = {
			session,
			ui,
			projectTrust,
			cwd,
			sessionFile,
			createdAtMs,
			modifiedAtMs: createdAtMs,
			lastSeenAtMs: createdAtMs,
			controllerClientId,
			controllerHandoffTimer: null,
			clients: new Map(),
			unsubscribe: null,
			tripwireAllowedRoots,
			tripwireStopRequested: false,
			live: EMPTY_LIVE_SNAPSHOT,
			outbox: [],
			flushScheduled: false,
		};

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			runtime.modifiedAtMs = Date.now();
			runtime.live = reduceLiveSnapshot(runtime.live, event);
			const inspection =
				this.tripwireMode === "on"
					? this.tripwireService.inspectEvent({ sessionId, cwd: runtime.cwd, allowedRoots: runtime.tripwireAllowedRoots }, event)
					: { alerts: [] };
			this.broadcast(sessionId, { type: "agent_event", event: toWireEvent(event) });

			if (inspection.alerts.length > 0) {
				for (const alert of inspection.alerts) {
					this.broadcast(sessionId, { type: "tripwire_alert", alert: this.tripwireService.toApiAlert(alert) });
				}
				void this.tripwireService.recordAlerts(sessionId, inspection.alerts);
			}

			if (event.type === "agent_start" || event.type === "agent_settled") {
				runtime.tripwireStopRequested = false;
			}
			if (STATE_PATCH_EVENTS.has(event.type)) {
				const patch = buildPatch(session);
				// auto-compaction releases its abort controller only after compaction_end listeners ran
				if (event.type === "compaction_end") patch.isCompacting = false;
				this.broadcast(sessionId, { type: "state_patch", patch });
			}
		});
		runtime.unsubscribe = unsubscribe;

		this.runningById.set(sessionId, runtime);
		if (sessionFile) {
			this.runningByPath.set(sessionFile, sessionId);
		}

		return runtime;
	}

	private assertController(runtime: RunningSession, clientId: string): void {
		this.claimControllerIfVacant(runtime, clientId);
		if (runtime.controllerClientId !== clientId) {
			throw new Error("not_controller");
		}
	}

	/**
	 * Queues an event for every viewer. Delivery waits for the emitting call stack to unwind because pi
	 * persists a message only after its message_end listeners ran, and the frame should carry its entry id.
	 */
	private broadcast(sessionId: string, event: SseEvent): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		runtime.outbox.push(event);
		if (runtime.flushScheduled) return;
		runtime.flushScheduled = true;
		queueMicrotask(() => this.flushOutbox(runtime));
	}

	private flushOutbox(runtime: RunningSession): void {
		runtime.flushScheduled = false;
		for (const queued of runtime.outbox.splice(0)) {
			const entryId = queued.type === "agent_event" ? announcedEntryId(runtime.session.sessionManager, queued.event) : undefined;
			const event: SseEvent = entryId && queued.type === "agent_event" ? { ...queued, entryId } : queued;
			for (const client of runtime.clients.values()) {
				try {
					client.send(event, entryId);
				} catch {
					// ignore broken clients
				}
			}
		}
	}
}
