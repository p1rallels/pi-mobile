import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
	ApiCommandRequest,
	ApiCreateSessionRequest,
	ApiModelInfo,
	ApiSessionState,
	ApiSessionSummary,
	ClientRole,
	ApiSessionPatch,
	SseEvent,
} from "./types.ts";

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

function buildState(session: AgentSession, cwd: string): ApiSessionState {
	return {
		sessionId: session.sessionId,
		cwd,
		sessionFile: session.sessionFile ?? null,
		sessionName: session.sessionName,
		isStreaming: session.isStreaming,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
		messages: session.messages,
	};
}

function buildPatch(session: AgentSession): ApiSessionPatch {
	return {
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		sessionName: session.sessionName,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
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
	private authStorage = AuthStorage.create();
	private modelRegistry = new ModelRegistry(this.authStorage);
	private repoStorePath = join(homedir(), ".pi", "agent", "pi-web", "repos.json");

	private async loadReposFromDisk(): Promise<string[]> {
		try {
			const raw = await readFile(this.repoStorePath, "utf8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean);
		} catch {
			return [];
		}
	}

	private async saveReposToDisk(repos: string[]): Promise<void> {
		const dir = dirname(this.repoStorePath);
		mkdirSync(dir, { recursive: true });
		const payload = JSON.stringify(repos, null, 2);
		await writeFile(this.repoStorePath, payload, "utf8");
	}

	async listRepos(): Promise<string[]> {
		const repos = new Set<string>();

		for (const repo of await this.loadReposFromDisk()) {
			repos.add(repo);
		}

		const saved = await SessionManager.listAll().catch(() => []);
		for (const entry of saved) {
			if (typeof entry.cwd === "string" && entry.cwd.trim()) {
				repos.add(entry.cwd.trim());
			}
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
			summary.isRunning = this.runningByPath.has(entry.path);
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

	async listModels(): Promise<ApiModelInfo[]> {
		// Keep auth/models fresh in case keys/models.json changed outside this process (e.g. via native CLI).
		try {
			this.authStorage.reload();
		} catch {
			// best effort
		}
		try {
			this.modelRegistry.refresh();
		} catch {
			// best effort
		}

		const available = this.modelRegistry.getAvailable();
		return available.map((model) => ({
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
			const path = request.resumeSessionPath;
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
			const { session } = await createAgentSession({
				cwd,
				sessionManager,
				authStorage: this.authStorage,
				modelRegistry: this.modelRegistry,
			});
			const runtime = this.registerSession(session, cwd, clientId);
			return { sessionId: runtime.session.sessionId };
		}

		const cwd = request.cwd ?? process.cwd();
		await ensureDirectory(cwd);
		const sessionManager = SessionManager.create(cwd);
		const { session } = await createAgentSession({
			cwd,
			sessionManager,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
		});
		const runtime = this.registerSession(session, cwd, clientId);
		return { sessionId: runtime.session.sessionId };
	}

	async handleCommand(sessionId: string, command: ApiCommandRequest): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}

		if (command.type === "abort") {
			await runtime.session.abort();
			return;
		}

		if (command.type === "prompt") {
			this.assertController(runtime, command.clientId);
			const text = command.text.trim();
			if (text.length === 0) return;
			await runtime.session.prompt(text, runtime.session.isStreaming ? { streamingBehavior: command.deliverAs ?? "followUp" } : undefined);
			return;
		}

		if (command.type === "set_model") {
			this.assertController(runtime, command.clientId);
			const provider = command.provider.trim();
			const modelId = command.modelId.trim();
			if (!provider || !modelId) throw new Error("invalid_model");
			try {
				this.authStorage.reload();
			} catch {
				// best effort
			}
			try {
				this.modelRegistry.refresh();
			} catch {
				// best effort
			}

			const available = this.modelRegistry.getAvailable();
			const model = available.find((m) => m.provider === provider && m.id === modelId);
			if (!model) throw new Error(`model_not_available: ${provider}/${modelId}`);
			await runtime.session.setModel(model);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_thinking_level") {
			this.assertController(runtime, command.clientId);
			const level = command.level.trim();
			const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
			if (!allowed.includes(level)) throw new Error(`invalid_thinking_level: ${level}`);
			runtime.session.setThinkingLevel(level as (typeof allowed)[number]);
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
			await runtime.session.abort();
		} catch {
			// best effort
		}
		try {
			runtime.session.dispose();
		} catch {
			// best effort
		}

		this.runningById.delete(sessionId);
		if (runtime.sessionFile) {
			this.runningByPath.delete(runtime.sessionFile);
		}
	}

	private registerSession(session: AgentSession, cwd: string, controllerClientId: string): RunningSession {
		const sessionId = session.sessionId;
		const sessionFile = session.sessionFile ?? null;

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
		};

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			runtime.modifiedAtMs = Date.now();
			this.broadcast(sessionId, { type: "agent_event", event });

			if (event.type === "agent_end" || event.type === "auto_compaction_end") {
				this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(session) });
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
