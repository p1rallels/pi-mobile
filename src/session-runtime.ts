import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { TripwireService } from "./tripwire.ts";
import { toWireEvent } from "./wire-events.ts";
import type {
	ApiCommandRequest,
	ApiCreateSessionRequest,
	ApiModelInfo,
	ApiSessionState,
	ApiSessionSummary,
	ClientRole,
	ApiSessionPatch,
	ApiTripwireAlertsResponse,
	SseEvent,
} from "./types.ts";
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";

export interface SessionClient {
	clientId: string;
	send(event: SseEvent): void;
	close(): void;
}

interface RunningSession {
	session: AgentSession;
	cwd: string;
	sessionFile: string | null;
	createdAtMs: number;
	modifiedAtMs: number;
	controllerClientId: string | null;
	clients: Map<string, SessionClient>;
	unsubscribe: (() => void) | null;
	tripwireAllowedRoots: Set<string>;
	tripwireAbortRequested: boolean;
}

interface PiWebRuntimeOptions {
	maxRunningSessions?: number;
	maxClientsPerSession?: number;
}

type SessionThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

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

function computeFirstMessage(messages: AgentSession["messages"]): string {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "user") continue;
		const text = extractTextContent((message as { content?: unknown }).content);
		if (text.trim().length > 0) return text;
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

function buildState(session: AgentSession, cwd: string): ApiSessionState {
	return {
		sessionId: session.sessionId,
		cwd,
		sessionFile: session.sessionFile ?? null,
		sessionName: session.sessionName,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessages: safeQueuedMessagesSnapshot(session),
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
		messages: session.messages,
	};
}

function buildPatch(session: AgentSession, options: { includeMessages?: boolean } = {}): ApiSessionPatch {
	return {
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		...(options.includeMessages ? { messages: session.messages } : {}),
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

function serializeSessionSummary(entry: {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage?: string;
}): ApiSessionSummary {
	return {
		id: entry.id,
		path: entry.path,
		cwd: entry.cwd,
		name: entry.name,
		firstMessage: entry.firstMessage ?? "(no messages)",
		created: entry.created.toISOString(),
		modified: entry.modified.toISOString(),
		messageCount: entry.messageCount,
		isRunning: false,
	};
}

export class PiWebRuntime {
	private runningById = new Map<string, RunningSession>();
	private runningByPath = new Map<string, string>();
	private agentDir = getAgentDir();
	private modelRuntimePromise = ModelRuntime.create({
		authPath: join(this.agentDir, "auth.json"),
		modelsPath: join(this.agentDir, "models.json"),
	});
	private repoStorePath = join(this.agentDir, "pi-web", "repos.json");
	private internalStateRoot = this.agentDir;
	private tripwireService = new TripwireService();
	private maxRunningSessions: number;
	private maxClientsPerSession: number;

	constructor(options: PiWebRuntimeOptions = {}) {
		this.maxRunningSessions = options.maxRunningSessions ?? 24;
		this.maxClientsPerSession = options.maxClientsPerSession ?? 8;
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

	private async createRuntimeSession(cwd: string, sessionManager: SessionManager): Promise<AgentSession> {
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: this.agentDir, settingsManager });
		const modelRuntime = await this.refreshModelRuntime();
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			sessionManager,
			modelRuntime,
			settingsManager,
			resourceLoader,
		});
		await session.bindExtensions({
			onError: (error) => {
				console.error(`[pi-web extension] ${error.extensionPath} ${error.event}: ${error.error}`);
			},
		});
		return session;
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
				firstMessage: computeFirstMessage(runtime.session.messages),
				created: toIso(runtime.createdAtMs),
				modified: toIso(runtime.modifiedAtMs),
				messageCount: runtime.session.messages.length,
				isRunning: true,
			});
		}
		sessions.sort((a, b) => b.modified.localeCompare(a.modified));
		return sessions;
	}

	async listSessions(): Promise<ApiSessionSummary[]> {
		const saved = await SessionManager.listAll().catch(() => []);
		const byId = new Map<string, ApiSessionSummary>();

		for (const entry of saved) {
			const summary = serializeSessionSummary(entry);
			summary.isRunning = this.runningByPath.has(resolve(entry.path));
			byId.set(summary.id, summary);
		}

		for (const [sessionId, runtime] of this.runningById.entries()) {
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
				firstMessage: computeFirstMessage(runtime.session.messages),
				created: toIso(createdAt),
				modified: toIso(modifiedAt),
				messageCount: runtime.session.messages.length,
				isRunning: true,
			});
		}

		const sessions = [...byId.values()];
		sessions.sort((a, b) => b.modified.localeCompare(a.modified));
		return sessions;
	}

	private async listKnownSessionPaths(): Promise<Set<string>> {
		const paths = new Set<string>();

		const saved = await SessionManager.listAll().catch(() => []);
		for (const entry of saved) {
			if (typeof entry.path === "string" && entry.path.trim()) {
				paths.add(resolve(entry.path));
			}
		}

		for (const path of this.runningByPath.keys()) {
			paths.add(resolve(path));
		}

		return paths;
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

	private async assertAllowedResumePath(rawPath: string): Promise<string> {
		const path = resolve(rawPath.trim());
		const knownPaths = await this.listKnownSessionPaths();
		if (!knownPaths.has(path)) {
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

	getSessionState(sessionId: string): ApiSessionState {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		return buildState(runtime.session, runtime.cwd);
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
		if (!runtime.clients.has(client.clientId) && runtime.clients.size >= this.maxClientsPerSession) {
			throw new Error("too_many_clients");
		}
		runtime.clients.set(client.clientId, client);
		return this.getSessionRole(sessionId, client.clientId);
	}

	removeClient(sessionId: string, clientId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		runtime.clients.delete(clientId);
	}

	async startSession(request: ApiCreateSessionRequest): Promise<{ sessionId: string }> {
		const clientId = request.clientId ?? randomUUID();

		if (request.resumeSessionPath) {
			const path = await this.assertAllowedResumePath(request.resumeSessionPath);
			const existingId = this.runningByPath.get(path);
			if (existingId) {
				const existing = this.runningById.get(existingId);
				if (existing && existing.controllerClientId === null) {
					existing.controllerClientId = clientId;
					this.broadcast(existingId, { type: "controller_changed", controllerClientId: clientId });
				}
				return { sessionId: existingId };
			}

			if (!existsSync(path)) {
				throw new Error(`session file does not exist: ${path}`);
			}

			const sessionManager = SessionManager.open(path);
			const cwd = sessionManager.getCwd();
			const session = await this.createRuntimeSession(cwd, sessionManager);
			const tripwireAllowedRoots = await this.buildTripwireAllowedRoots(cwd);
			const runtime = this.registerSession(session, cwd, clientId, tripwireAllowedRoots);
			return { sessionId: runtime.session.sessionId };
		}

		const cwd = await this.assertAllowedCwd(request.cwd ?? process.cwd());
		const sessionManager = SessionManager.create(cwd);
		const session = await this.createRuntimeSession(cwd, sessionManager);
		const tripwireAllowedRoots = await this.buildTripwireAllowedRoots(cwd);
		const runtime = this.registerSession(session, cwd, clientId, tripwireAllowedRoots);
		return { sessionId: runtime.session.sessionId };
	}

	private startManualCompaction(runtime: RunningSession, customInstructions: string | undefined): void {
		if (runtime.session.isCompacting) return;
		if (runtime.session.messages.length < 2) {
			throw new Error("Nothing to compact (no messages yet)");
		}
		const trimmedInstructions = typeof customInstructions === "string" ? customInstructions.trim() : "";
		void runtime.session.compact(trimmedInstructions || undefined).catch(() => {});
	}

	async handleCommand(sessionId: string, command: ApiCommandRequest): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}

		if (command.type === "abort") {
			this.assertController(runtime, command.clientId);
			runtime.session.abortCompaction();
			await runtime.session.abort();
			return;
		}

		if (command.type === "compact") {
			this.assertController(runtime, command.clientId);
			this.startManualCompaction(runtime, command.customInstructions);
			return;
		}

		if (command.type === "prompt") {
			this.assertController(runtime, command.clientId);
			const text = command.text.trim();
			if (text.length === 0) return;
			const customInstructions = parseCompactCommandText(text);
			if (customInstructions !== null) {
				this.startManualCompaction(runtime, customInstructions);
				return;
			}
			const queuedText = parseQueueCommandText(text);
			const promptText = (queuedText ?? text).trim();
			if (promptText.length === 0) return;
			const streamingBehavior = queuedText !== null ? "followUp" : (command.deliverAs ?? "steer");
			await runtime.session.prompt(promptText, runtime.session.isStreaming ? { streamingBehavior } : undefined);
			return;
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
			return;
		}

		if (command.type === "set_thinking_level") {
			this.assertController(runtime, command.clientId);
			const level = command.level.trim();
			if (!isThinkingLevel(level)) throw new Error(`invalid_thinking_level: ${level}`);
			runtime.session.setThinkingLevel(level);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_steering_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_steering_mode: ${String(mode)}`);
			runtime.session.setSteeringMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_follow_up_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_follow_up_mode: ${String(mode)}`);
			runtime.session.setFollowUpMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_auto_compaction") {
			this.assertController(runtime, command.clientId);
			runtime.session.setAutoCompactionEnabled(Boolean(command.enabled));
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_session_name") {
			this.assertController(runtime, command.clientId);
			const name = command.name.trim();
			if (!name) throw new Error("invalid_session_name");
			runtime.session.setSessionName(name);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		throw new Error(`unknown_command: ${String((command as { type?: unknown }).type)}`);
	}

	takeover(sessionId: string, request: { clientId: string }): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		if (runtime.session.isStreaming) {
			throw new Error("cannot_takeover_while_streaming");
		}
		runtime.controllerClientId = request.clientId;
		this.broadcast(sessionId, { type: "controller_changed", controllerClientId: request.clientId });
	}

	async release(sessionId: string, request: { clientId: string }): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		this.assertController(runtime, request.clientId);

		this.broadcast(sessionId, { type: "released", byClientId: request.clientId });

		for (const client of runtime.clients.values()) {
			client.close();
		}

		try {
			runtime.session.abortCompaction();
			await runtime.session.abort();
		} catch {
			// best effort
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

	private registerSession(session: AgentSession, cwd: string, controllerClientId: string, tripwireAllowedRoots: Set<string>): RunningSession {
		const sessionId = session.sessionId;
		const sessionFile = session.sessionFile ? resolve(session.sessionFile) : null;

		if (this.runningById.size >= this.maxRunningSessions) {
			throw new Error("too_many_active_sessions");
		}

		if (sessionFile) {
			const existingId = this.runningByPath.get(sessionFile);
			if (existingId) {
				throw new Error("session_already_running");
			}
		}

		const createdAtMs = Date.now();
		const runtime: RunningSession = {
			session,
			cwd,
			sessionFile,
			createdAtMs,
			modifiedAtMs: createdAtMs,
			controllerClientId,
			clients: new Map(),
			unsubscribe: null,
			tripwireAllowedRoots,
			tripwireAbortRequested: false,
		};

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			runtime.modifiedAtMs = Date.now();
			const inspection = this.tripwireService.inspectEvent(
				{
					sessionId,
					cwd: runtime.cwd,
					allowedRoots: runtime.tripwireAllowedRoots,
				},
				event,
			);
			this.broadcast(sessionId, { type: "agent_event", event: toWireEvent(event) });

			if (inspection.alerts.length > 0) {
				for (const alert of inspection.alerts) {
					this.broadcast(sessionId, { type: "tripwire_alert", alert: this.tripwireService.toApiAlert(alert) });
				}
				void this.tripwireService.recordAlerts(sessionId, inspection.alerts);

				if (inspection.shouldAbort && !runtime.tripwireAbortRequested) {
					runtime.tripwireAbortRequested = true;
					void runtime.session.abort().catch(() => {
						// best effort
					});
				}
			}

			if (event.type === "agent_start" || event.type === "agent_end" || event.type === "compaction_start" || event.type === "compaction_end") {
				runtime.tripwireAbortRequested = false;
				const patch = buildPatch(session, { includeMessages: event.type === "compaction_end" && Boolean(event.result) });
				if (event.type === "agent_start") patch.isStreaming = true;
				if (event.type === "agent_end") patch.isStreaming = false;
				if (event.type === "compaction_start") {
					patch.isCompacting = true;
					patch.isStreaming = false;
				}
				if (event.type === "compaction_end") {
					patch.isCompacting = false;
					patch.isStreaming = false;
				}
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
		if (runtime.controllerClientId !== clientId) {
			throw new Error("not_controller");
		}
	}

	private broadcast(sessionId: string, event: SseEvent): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		for (const client of runtime.clients.values()) {
			try {
				client.send(event);
			} catch {
				// ignore broken clients
			}
		}
	}
}
