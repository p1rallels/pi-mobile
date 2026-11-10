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
	type SessionEntry,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { createFolderInHome, isDirectory, normalizeCwd } from "./directories.ts";
import { createExtensionUiBridge, type ApiExtensionUiResponse, type ExtensionUiBridge } from "./extension-ui.ts";
import { EMPTY_LIVE_SNAPSHOT, reduceLiveSnapshot, type LiveSnapshot } from "./live-snapshot.ts";
import {
	applyProjectTrustChoice,
	DEFAULT_PROJECT_TRUST_MODE,
	detachedProjectTrust,
	ProjectTrustRequiredError,
	projectTrustPrompt,
	resolveProjectTrust,
	restoredProjectTrust,
	type ApiProjectTrust,
	type ApiProjectTrustChoice,
	type ProjectTrustMode,
} from "./project-trust.ts";
import { createForkLabels } from "./fork-labels.ts";
import {
	classifyElsewhere,
	createProcessCache,
	listPiProcesses,
	stopProcess,
	writersOf,
	type ListPiProcesses,
	type PiProcess,
} from "./outside-writers.ts";
import { findGitHead, readGitBranch, watchGitBranch, type GitBranchWatch } from "./git-branch.ts";
import { MAX_REOPENS_PER_LOOK, ownedElsewhere, type DetachedRef, type MailHost, type MailReopen, type Room } from "./msg-mail.ts";
import { followInfo, readAppended, readSessionSnapshot } from "./session-follow.ts";
import { createLineageFeed, createPresenceIndex, type LineageFeed, type PresenceIndex } from "./msg-lineage.ts";
import { msgStoreRoot, pidAlive, type PidProbe } from "./msg-store.ts";
import { isWaiting, planWaitingReopens, readOnlyOf, readOnlyWords, type WaitingSkip } from "./msg-subs.ts";
import { advanceRelay, relayStateOf, relayView, type RelayFold } from "./relay-state.ts";
import { classifyNeverSaved } from "./never-saved.ts";
import { defaultScratchRoots, pickRepoSuggestions, REPO_SUGGESTION_LIMIT } from "./repo-suggestions.ts";
import { createSessionFolders, createSessionIndex, readSessionHeader, sessionDirForCwd, type SessionFolder, type SessionSummary } from "./session-index.ts";
import { capacityVictim, idleVictims, isEvictable as isEvictableSlot, type Slot } from "./session-slots.ts";
import { isOpenTurn, turnOfEntries, type Turn } from "./session-turn.ts";
import {
	announcedEntryId,
	entryTranscriptMessages,
	transcriptPage,
	transcriptSince,
	type TranscriptLimits,
	type TranscriptPage,
} from "./transcript.ts";
import { TripwireService, type TripwireMode } from "./tripwire.ts";
import { toWireEvent } from "./wire-events.ts";
import type {
	ApiCommandRequest,
	ApiCommandResponse,
	ApiCreateSessionRequest,
	ApiElsewhere,
	ApiFollowSession,
	ApiFollowState,
	ApiPromptDisposition,
	ApiModelInfo,
	ApiNeverSaved,
	ApiReadOnly,
	ApiRelayState,
	ApiRepoSuggestion,
	ApiResyncTranscript,
	ApiSessionState,
	ApiSessionStatus,
	ApiCanvasSessionStatus,
	ApiSessionSummary,
	ClientRole,
	ApiSessionPatch,
	ApiTripwireAlertsResponse,
	FollowSseEvent,
	SseEvent,
} from "./types.ts";
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";

export { normalizeCwd };

export interface SessionClient {
	connectionId: string;
	clientId: string;
	/** `id` is the entry cursor a reconnect can resume from. */
	send(event: SseEvent, id?: string): void;
	close(): void;
}

export type InitSseEvent = Extract<SseEvent, { type: "init" }>;

export interface FollowClient {
	send(event: FollowSseEvent, id?: string): void;
	close(): void;
}

/** Refused resume: another process is writing the session and hasn't gone quiet. */
export class RunningElsewhereError extends Error {
	constructor(readonly elsewhere: ApiElsewhere) {
		super("running_elsewhere");
	}
}

/** Several pi processes work in the session's folder and nothing says which one writes it. */
export class AmbiguousWritersError extends Error {
	constructor(readonly pids: number[]) {
		super("ambiguous_writers");
	}
}

/** Refused resume: nothing was ever sent to the session, so it has no file (see never-saved.ts); start a new one in `cwd`. */
export class NeverSavedError extends Error {
	constructor(readonly cwd: string | null) {
		super("never_saved");
	}
}

/** Refused load: pi-web only shows this session (a sub, or its folder is gone; msg-subs.ts), so it opens read-only instead. */
export class ReadOnlySessionError extends Error {
	constructor(readonly readOnly: ApiReadOnly) {
		super("read_only_session");
	}
}

/** What one idle sweep did (session-runtime.ts sweep). */
export interface SweepReport {
	/** Re-attach records dropped: those sessions open read-only now. */
	forgotten: Array<{ sessionId: string; readOnly: ApiReadOnly }>;
	/** Idle sessions nobody watched and no sub counted on, disposed. */
	disposed: string[];
	/** Detached sessions brought back, with no viewer, because subs still count on them. */
	reopened: string[];
}

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
	/** The branch the session's folder is on, for the footer. */
	git: GitBranchWatch;
	live: LiveSnapshot;
	outbox: SseEvent[];
	flushScheduled: boolean;
	/** relay's state at the leaf the header last saw, and what the viewers were last sent of it */
	relay: RelayFold | null;
	relayKey: string;
}

interface PiWebRuntimeOptions {
	maxRunningSessions?: number;
	maxClientsPerSession?: number;
	idleSessionTtlMs?: number;
	controllerGraceMs?: number;
	modelRuntime?: ModelRuntime;
	projectTrustMode?: ProjectTrustMode;
	tripwire?: TripwireMode;
	/** pi processes outside pi-web, for sessions another process is writing; tests pass a fake. */
	listPiProcesses?: ListPiProcesses;
	stopPiProcess?: (proc: PiProcess) => Promise<"stopped" | "killed" | "alive">;
	/** How long one process listing serves every caller. */
	processCacheMs?: number;
	followPollMs?: number;
	/** `pfs ls --names --all --json` for a repo root, for fork labels; tests pass a fake. */
	listForks?: (root: string) => Promise<string | null>;
	/** Folders whose sessions are never suggested as repos (default: the temp roots); tests pass their own. */
	scratchRoots?: string[];
	/** msg's store, for lineage (default: $PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg). */
	msgDir?: string;
	/** How often lineage is read again while someone looks at a session. */
	lineageRefreshMs?: number;
	/** Whether a pid runs, for lineage and for who else runs a session; tests pass a fake. */
	pidAlive?: PidProbe;
	/** What the idle sweep and the waiting rule take for now; tests pass their own. */
	clock?: () => number;
	/** Where the sweep says what it did and why it didn't (default console.log). */
	log?: (line: string) => void;
}

const DEFAULT_FOLLOW_POLL_MS = 700;
/** How often a follower re-checks who is left to write the file when nothing new arrived. */
const FOLLOW_STATE_CHECK_MS = 2_000;

interface DetachedSession {
	sessionId: string;
	size: number;
	mtimeMs: number;
	detachedAtMs: number;
	/** The trust decision the session ran with: what a re-attach may bring back of it is restoredProjectTrust's call. */
	projectTrust?: ApiProjectTrust;
	/** The folder it ran in, so a session whose folder is gone is forgotten (it opens read-only); read from the file for older records. */
	cwd?: string;
}

const DETACHED_RECORD_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_DETACHED_RECORDS = 500;

function parseDetachedRecords(raw: unknown): Array<[string, DetachedSession]> {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((record): Array<[string, DetachedSession]> => {
		if (!record || typeof record !== "object") return [];
		const { path, sessionId, size, mtimeMs, detachedAtMs, cwd } = record as Record<string, unknown>;
		if (typeof path !== "string" || typeof sessionId !== "string" || typeof size !== "number" || typeof mtimeMs !== "number") return [];
		const projectTrust = detachedProjectTrust(record);
		return [
			[
				path,
				{
					sessionId,
					size,
					mtimeMs,
					detachedAtMs: typeof detachedAtMs === "number" ? detachedAtMs : Date.now(),
					...(projectTrust ? { projectTrust } : {}),
					...(typeof cwd === "string" && cwd ? { cwd } : {}),
				},
			],
		];
	});
}

const DEFAULT_IDLE_SESSION_TTL_MS = 15 * 60_000;
const DEFAULT_CONTROLLER_GRACE_MS = 10_000;
/** A short idle ttl (tests) sweeps a few times per ttl, never more often than this. */
const MIN_IDLE_SWEEP_INTERVAL_MS = 250;

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
const TRANSCRIPT_FILE_CACHE = 4;

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

/** A viewer that only shows the tail of a transcript (a canvas tile) can ask for a smaller first page. */
function initialTranscriptLimits(limit: number | undefined): TranscriptLimits {
	if (limit === undefined || !Number.isFinite(limit)) return INITIAL_TRANSCRIPT_LIMITS;
	return { ...INITIAL_TRANSCRIPT_LIMITS, maxMessages: Math.min(Math.max(1, Math.floor(limit)), INITIAL_TRANSCRIPT_MESSAGES) };
}

function buildState(session: AgentSession, cwd: string, projectTrust: ApiProjectTrust, gitBranch: string | null): ApiSessionState {
	const transcript = transcriptPage(session.sessionManager.getBranch(), INITIAL_TRANSCRIPT_LIMITS);
	return { ...buildStatus(session, cwd, projectTrust, gitBranch), messages: transcript.messages, hasOlderMessages: transcript.hasOlder };
}

function resyncTranscript(branch: readonly SessionEntry[], since: string | undefined, limits: TranscriptLimits): ApiResyncTranscript {
	const missing = since === undefined ? null : transcriptSince(branch, since, limits);
	if (since !== undefined && missing !== null) return { mode: "append", since, messages: missing };
	const page = transcriptPage(branch, limits);
	return { mode: "replace", messages: page.messages, hasOlder: page.hasOlder };
}

function buildResyncTranscript(session: AgentSession, since: string | undefined, limits: TranscriptLimits): ApiResyncTranscript {
	return resyncTranscript(session.sessionManager.getBranch(), since, limits);
}

function sameFollowState(a: ApiFollowState, b: ApiFollowState): boolean {
	return a.state === b.state && a.turn === b.turn && a.lastWrite === b.lastWrite && String(a.writers) === String(b.writers);
}

function pidsOf(writers: readonly PiProcess[] | null): number[] | null {
	return writers === null ? null : writers.map((writer) => writer.pid);
}

async function listSessionFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
	} catch {
		return [];
	}
}

/** Files in `dir` written at or after `sinceMs`: only those can belong to a process that started then. */
async function sessionFilesWrittenSince(dir: string, sinceMs: number): Promise<string[]> {
	const files = await listSessionFiles(dir);
	const recent = await Promise.all(
		files.map(async (path) => {
			try {
				return (await stat(path)).mtimeMs >= sinceMs ? path : null;
			} catch {
				return null;
			}
		}),
	);
	return recent.filter((path): path is string => path !== null);
}

function buildStatus(session: AgentSession, cwd: string, projectTrust: ApiProjectTrust, gitBranch: string | null): ApiSessionStatus {
	return {
		sessionId: session.sessionId,
		projectTrust,
		cwd,
		gitBranch,
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

function buildPatch(session: AgentSession, gitBranch: string | null): ApiSessionPatch {
	return {
		gitBranch,
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

function serializeSessionSummary(entry: SessionSummary, isRunning: boolean, elsewhere?: ApiElsewhere): ApiSessionSummary {
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
		...(elsewhere ? { elsewhere } : {}),
	};
}

export class PiWebRuntime implements MailHost {
	private runningById = new Map<string, RunningSession>();
	private runningByPath = new Map<string, string>();
	private statusListeners = new Set<() => void>();
	private transcriptFiles = new Map<string, { mtimeMs: number; size: number; sessionId: string; cwd: string; branch: SessionEntry[] }>();
	private resumingByPath = new Map<string, Promise<RunningSession>>();
	private detachedByPath = new Map<string, DetachedSession>();
	private agentDir = getAgentDir();
	private sessionIndex = createSessionIndex(join(this.agentDir, "sessions"));
	private sessionFolders = createSessionFolders(join(this.agentDir, "sessions"));
	private scratchRoots: string[];
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
	private piProcesses: ReturnType<typeof createProcessCache>;
	private stopPiProcess: (proc: PiProcess) => Promise<"stopped" | "killed" | "alive">;
	private followPollMs: number;
	private followers = new Set<{ stop(): void; sessionId: string }>();
	private forkLabels: ReturnType<typeof createForkLabels>;
	/** Set by shutdown: nothing comes back by itself (msg mail, subs waiting) once the server is stopping. */
	private closing = false;
	private lineage: LineageFeed;
	/** msg's presence records, one index for the lineage feed, the waiting rule and which sessions open read-only. */
	private presence: PresenceIndex;
	private presenceFailure: string | null = null;
	private clock: () => number;
	private log: (line: string) => void;
	private probePid: PidProbe;
	/** What the sweep last said about a parent it didn't bring back, so each reason is said once. */
	private waitingTold = new Map<string, string>();
	/** Parents whose reopen failed: not tried again until the next server run. */
	private waitingFailed = new Set<string>();

	constructor(options: PiWebRuntimeOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.log = options.log ?? ((line) => console.log(line));
		this.probePid = options.pidAlive ?? pidAlive;
		this.forkLabels = createForkLabels(options.listForks);
		this.scratchRoots = options.scratchRoots ?? defaultScratchRoots();
		this.piProcesses = createProcessCache(options.listPiProcesses ?? (() => listPiProcesses()), options.processCacheMs);
		this.stopPiProcess = options.stopPiProcess ?? ((proc) => stopProcess(proc));
		this.followPollMs = options.followPollMs ?? DEFAULT_FOLLOW_POLL_MS;
		this.maxRunningSessions = options.maxRunningSessions ?? 24;
		this.maxClientsPerSession = options.maxClientsPerSession ?? 8;
		this.idleSessionTtlMs = options.idleSessionTtlMs ?? DEFAULT_IDLE_SESSION_TTL_MS;
		this.controllerGraceMs = options.controllerGraceMs ?? DEFAULT_CONTROLLER_GRACE_MS;
		this.projectTrustMode = options.projectTrustMode ?? DEFAULT_PROJECT_TRUST_MODE;
		this.tripwireMode = options.tripwire ?? "on";
		this.modelRuntimePromise = options.modelRuntime
			? Promise.resolve(options.modelRuntime)
			: ModelRuntime.create({ authPath: join(this.agentDir, "auth.json"), modelsPath: join(this.agentDir, "models.json") });
		const msgDir = options.msgDir ?? msgStoreRoot();
		this.presence = createPresenceIndex(msgDir, this.clock);
		this.lineage = createLineageFeed({
			root: msgDir,
			index: this.presence,
			sessionsDir: join(this.agentDir, "sessions"),
			isHosted: (id) => this.runningById.has(id),
			watched: () => this.watchedSessionIds(),
			onChange: (id, lineage) => this.broadcast(id, { type: "state_patch", patch: { lineage } }),
			intervalMs: options.lineageRefreshMs,
			probe: options.pidAlive,
		});
	}

	/** Sessions someone looks at: hosted ones with a viewer, and the ones followed here. */
	private *watchedSessionIds(): Generator<string> {
		for (const [id, runtime] of this.runningById) if (runtime.clients.size > 0) yield id;
		for (const follower of this.followers) yield follower.sessionId;
	}

	private relayOf(runtime: RunningSession): ApiRelayState | null {
		runtime.relay = advanceRelay(runtime.relay, runtime.session.sessionManager);
		return relayView(runtime.relay.state);
	}

	/** An entry landed: the viewers hear when what the header shows of relay changed (a reset, the loop, a nudge). */
	private patchRelay(runtime: RunningSession): void {
		const relay = this.relayOf(runtime);
		const key = JSON.stringify(relay);
		if (key === runtime.relayKey) return;
		runtime.relayKey = key;
		this.broadcast(runtime.session.sessionId, { type: "state_patch", patch: { relay } });
	}

	/** msg's presence records read again (a readdir, then only the files that changed); a store that can't be read keeps the last ones. */
	async refreshPresence(): Promise<void> {
		try {
			await this.presence.refresh();
			this.presenceFailure = null;
		} catch (error) {
			const message = errorMessage(error);
			if (message !== this.presenceFailure) console.error(`[pi-web] can't read msg's presence records: ${message}`);
			this.presenceFailure = message;
		}
	}

	/** Some sub still counts on the session (msg-subs.ts): it's waiting, never idle. From the presence records as last read. */
	private waitingOnSubs(sessionId: string, now = this.clock()): boolean {
		return isWaiting(this.presence.childrenOf(sessionId), now);
	}

	/** Why pi-web only shows a session (msg-subs.ts), from its presence record as last read and its folder as it is now. */
	private async readOnlyFor(sessionId: string, cwd: string | null | undefined): Promise<ApiReadOnly | null> {
		return readOnlyOf(this.presence.record(sessionId), Boolean(cwd) && (await isDirectory(cwd ?? "")));
	}

	/**
	 * Refuses to load a session pi-web only shows (a sub, a folder gone) before anything gives up its slot for it, and
	 * forgets its re-attach record. A file that isn't there, or isn't a session's, is left for the load to report.
	 */
	private async assertLoadable(path: string): Promise<void> {
		const header = await readSessionHeader(path).catch(() => null);
		if (!header) return;
		await this.refreshPresence();
		const readOnly = await this.readOnlyFor(header.id, header.cwd);
		if (!readOnly) return;
		this.forgetDetached(path);
		throw new ReadOnlySessionError(readOnly);
	}

	/** Listed sessions pi-web doesn't run say when they open read-only; msg's records are read once, each folder looked at once. */
	private async withReadOnly(sessions: ApiSessionSummary[]): Promise<ApiSessionSummary[]> {
		if (!sessions.some((session) => !session.isRunning)) return sessions;
		await this.refreshPresence();
		const folders = new Map<string, Promise<boolean>>();
		const folderExists = (cwd: string): Promise<boolean> => {
			const known = folders.get(cwd) ?? (cwd ? isDirectory(cwd) : Promise.resolve(false));
			folders.set(cwd, known);
			return known;
		};
		return Promise.all(
			sessions.map(async (session) => {
				if (session.isRunning) return session;
				const readOnly = readOnlyOf(this.presence.record(session.id), await folderExists(session.cwd));
				return readOnly ? { ...session, readOnly } : session;
			}),
		);
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
	 * trust.json first, then PI_WEB_PROJECT_TRUST. A re-attach reuses the session's own answer (restoredProjectTrust)
	 * instead of asking again; "ask" without an answer is reported so the page can prompt and retry.
	 */
	private decideProjectTrust(cwd: string, choice?: ApiProjectTrustChoice, detached?: ApiProjectTrust): ApiProjectTrust {
		const resolved = resolveProjectTrust(cwd, this.trustStore, this.projectTrustMode);
		if (resolved) return resolved;
		const restored = restoredProjectTrust(detached);
		if (restored) return restored;
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

	/** Saves a folder sessions may start in (made first with create: one new folder inside home); returns it as saved (absolute, ~ expanded). */
	async addRepo(rawCwd: string, options: { create?: boolean } = {}): Promise<string> {
		const cwd = options.create ? await createFolderInHome(rawCwd) : normalizeCwd(rawCwd);
		await ensureDirectory(cwd);

		const repos = new Set(await this.loadReposFromDisk());
		repos.add(cwd);
		await this.saveReposToDisk([...repos].sort((a, b) => a.localeCompare(b)));

		for (const runtime of this.runningById.values()) {
			runtime.tripwireAllowedRoots.add(cwd);
		}
		return cwd;
	}

	/** Folders pi sessions ran in that aren't saved: not scratch, still there, newest session first; forks named like the session lists name them. */
	async listRepoSuggestions(limit = REPO_SUGGESTION_LIMIT): Promise<ApiRepoSuggestion[]> {
		const [folders, saved] = await Promise.all([this.sessionFolders.list(), this.listRepos()]);
		const candidates = pickRepoSuggestions(folders, new Set(saved), this.scratchRoots);
		const present = await Promise.all(candidates.map(async (folder) => (await isDirectory(folder.cwd)) ? folder : null));
		const listed = present.filter((folder): folder is SessionFolder => folder !== null).slice(0, limit);
		return Promise.all(
			listed.map(async (folder) => {
				const forkLabel = await this.forkLabels.label(folder.cwd).catch(() => undefined);
				return { cwd: folder.cwd, modified: toIso(folder.lastWriteMs), sessions: folder.sessions, ...(forkLabel ? { forkLabel } : {}) };
			}),
		);
	}

	/** What the canvas needs to know about every running session, cheap enough to send on each change. */
	canvasStatus(): ApiCanvasSessionStatus[] {
		return [...this.runningById.values()].map((runtime) => ({
			id: runtime.session.sessionId,
			path: runtime.sessionFile,
			working: runtime.session.isStreaming || runtime.session.isCompacting,
			waiting: runtime.ui.snapshot().dialogs.length > 0,
			viewers: runtime.clients.size,
		}));
	}

	/** Hears when a session starts or stops running, working or waiting on a dialog. */
	onStatusChange(listener: () => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	private notifyStatus(): void {
		for (const listener of this.statusListeners) {
			try {
				listener();
			} catch {
				// a broken listener must not break the session
			}
		}
	}

	private isHostedPath(path: string): boolean {
		const resolved = resolve(path);
		return this.runningByPath.has(resolved) || this.resumingByPath.has(resolved);
	}

	/** Sessions pi-web isn't hosting whose last message left the turn open, with who may still be writing them. */
	private async elsewhereOf(summaries: readonly SessionSummary[]): Promise<Map<string, ApiElsewhere>> {
		const open = summaries.filter((summary) => isOpenTurn(summary.turn) && !this.isHostedPath(summary.path));
		if (open.length === 0) return new Map();
		const processes = await this.piProcesses.list();
		const now = Date.now();
		return new Map(
			open.flatMap((summary): Array<[string, ApiElsewhere]> => {
				const lastWriteMs = Date.parse(summary.lastWrite);
				const writers = processes === null ? null : writersOf(processes, { cwd: summary.cwd, lastWriteMs });
				const state = classifyElsewhere(summary.turn, lastWriteMs, writers, now);
				return state ? [[summary.path, { state, turn: summary.turn, lastWrite: summary.lastWrite, writers: pidsOf(writers) }]] : [];
			}),
		);
	}

	/**
	 * Sessions a pi outside pi-web is in the middle of: only the folders pi processes work in can hold one,
	 * and only files written since the oldest of those processes started.
	 */
	private async listRunningElsewhere(): Promise<ApiSessionSummary[]> {
		const processes = await this.piProcesses.list();
		if (!processes || processes.length === 0) return [];
		const sessionsDir = join(this.agentDir, "sessions");
		const oldestStartByDir = new Map<string, number>();
		for (const proc of processes) {
			const dir = sessionDirForCwd(sessionsDir, proc.cwd);
			oldestStartByDir.set(dir, Math.min(oldestStartByDir.get(dir) ?? Number.POSITIVE_INFINITY, proc.startedAtMs));
		}
		const paths = (await Promise.all([...oldestStartByDir].map(([dir, sinceMs]) => sessionFilesWrittenSince(dir, sinceMs - 5_000)))).flat();
		const summaries = await this.sessionIndex.summarize(paths);
		const elsewhere = await this.elsewhereOf(summaries);
		return summaries.flatMap((summary) => {
			const found = elsewhere.get(summary.path);
			if (!found || found.state === "stopped") return [];
			const modified = summary.modified > found.lastWrite ? summary.modified : found.lastWrite;
			return [{ ...serializeSessionSummary(summary, false, found), modified }];
		});
	}

	private async withForkLabels(sessions: ApiSessionSummary[]): Promise<ApiSessionSummary[]> {
		return Promise.all(
			sessions.map(async (session) => {
				const forkLabel = await this.forkLabels.label(session.cwd).catch(() => undefined);
				return forkLabel ? { ...session, forkLabel } : session;
			}),
		);
	}

	async listActiveSessions(): Promise<ApiSessionSummary[]> {
		const sessions: ApiSessionSummary[] = await this.listRunningElsewhere().catch(() => []);
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
		return this.withForkLabels(await this.withReadOnly(sessions));
	}

	/** `id` narrows the list to that one session, wherever it lives (a msg sender's link opens it). */
	async listSessions(
		options: { cwd?: string; id?: string; limit?: number; offset?: number } = {},
	): Promise<{ sessions: ApiSessionSummary[]; hasMore: boolean }> {
		const listed = await this.sessionIndex.list({ cwd: options.cwd }).catch(() => []);
		const saved = options.id === undefined ? listed : listed.filter((entry) => entry.id === options.id);
		const elsewhere = await this.elsewhereOf(saved);
		const byId = new Map<string, ApiSessionSummary>();

		for (const entry of saved) {
			byId.set(entry.id, serializeSessionSummary(entry, this.runningByPath.has(resolve(entry.path)), elsewhere.get(entry.path)));
		}

		for (const [sessionId, runtime] of this.runningById.entries()) {
			if (options.cwd !== undefined && runtime.cwd !== options.cwd) continue;
			if (options.id !== undefined && sessionId !== options.id) continue;
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
		const page = await this.withReadOnly(sessions.slice(offset, offset + limit));
		return { sessions: await this.withForkLabels(page), hasMore: offset + limit < sessions.length };
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

	getHealth(): {
		runningSessions: number;
		busySessions: number;
		waitingSessions: number;
		viewers: number;
		detachedSessions: number;
		tripwire: TripwireMode;
		projectTrust: ProjectTrustMode;
	} {
		const runtimes = [...this.runningById.values()];
		const now = this.clock();
		return {
			tripwire: this.tripwireMode,
			projectTrust: this.projectTrustMode,
			runningSessions: runtimes.length,
			busySessions: runtimes.filter((runtime) => !runtime.session.isIdle).length,
			// idle, but kept loaded while their subs count; a restart brings them back, so they never hold a deploy up
			waitingSessions: runtimes.filter((runtime) => runtime.session.isIdle && this.waitingOnSubs(runtime.session.sessionId, now)).length,
			viewers: runtimes.reduce((total, runtime) => total + runtime.clients.size, 0),
			detachedSessions: this.detachedByPath.size,
		};
	}

	getSessionState(sessionId: string): ApiSessionState {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		return buildState(runtime.session, runtime.cwd, runtime.projectTrust, runtime.git.current());
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

	/**
	 * A page of a session read from its file, for sessions pi-web doesn't run: a dormant canvas tile shows the
	 * tail, the follow view pages back. A hosted session's page comes from its runtime. `sessionId`, when
	 * given, must be the file's.
	 */
	async readTranscriptFile(
		rawPath: string,
		request: { before?: string; limit?: number; sessionId?: string },
	): Promise<TranscriptPage & { sessionId: string; readOnly: ApiReadOnly | null }> {
		const path = this.assertAllowedResumePath(rawPath);
		const runningId = this.runningByPath.get(path);
		const running = runningId ? this.runningById.get(runningId) : undefined;
		const file = running ? { sessionId: running.session.sessionId, cwd: running.cwd, branch: running.session.sessionManager.getBranch() } : await this.parsedSessionFile(path);
		if (request.sessionId !== undefined && file.sessionId !== request.sessionId) throw new Error("session_path_mismatch");
		const limit = Math.min(Math.max(1, Math.floor(request.limit ?? TRANSCRIPT_PAGE_MESSAGES)), MAX_TRANSCRIPT_PAGE_MESSAGES);
		const page = transcriptPage(file.branch, { before: request.before, maxMessages: limit, maxBytes: TRANSCRIPT_PAGE_BYTES });
		// a dormant tile learns here that its session opens read-only, so it offers no resume
		if (running) return { sessionId: file.sessionId, ...page, readOnly: null };
		await this.refreshPresence();
		return { sessionId: file.sessionId, ...page, readOnly: await this.readOnlyFor(file.sessionId, file.cwd) };
	}

	/**
	 * A session file parsed the follow view's way, so reading never writes it (SessionManager.open appends a
	 * newline after a line another pi is halfway through, and rewrites old formats). The newest few parsed
	 * files are kept until they change.
	 */
	private async parsedSessionFile(path: string): Promise<{ sessionId: string; cwd: string; branch: SessionEntry[] }> {
		const { mtimeMs, size } = await stat(path).catch((error: unknown) => {
			throw isMissingFileError(error) ? new Error("session_file_missing") : error;
		});
		let parsed = this.transcriptFiles.get(path);
		if (!parsed || parsed.mtimeMs !== mtimeMs || parsed.size !== size) {
			const snapshot = await readSessionSnapshot(path);
			parsed = { mtimeMs, size, sessionId: snapshot.sessionId, cwd: snapshot.cwd, branch: snapshot.branch };
		}
		this.transcriptFiles.delete(path);
		this.transcriptFiles.set(path, parsed);
		for (const stale of [...this.transcriptFiles.keys()].slice(0, Math.max(0, this.transcriptFiles.size - TRANSCRIPT_FILE_CACHE))) this.transcriptFiles.delete(stale);
		return parsed;
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
		this.notifyStatus();
		return this.getSessionRole(sessionId, client.clientId);
	}

	/**
	 * Registers a viewer and builds its init event in one synchronous step, after delivering queued events
	 * to the existing viewers, so the snapshot and the live stream that follows neither overlap nor leave a gap.
	 */
	connectClient(
		sessionId: string,
		client: SessionClient,
		since?: string,
		options: { limit?: number } = {},
	): { init: InitSseEvent; cursor: string | undefined } {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		this.flushOutbox(runtime);
		const transcript = buildResyncTranscript(runtime.session, since, initialTranscriptLimits(options.limit));
		const cursor = runtime.session.sessionManager.getLeafId();
		const live = runtime.live;
		const relay = this.relayOf(runtime);
		runtime.relayKey = JSON.stringify(relay);
		const { role, controllerClientId } = this.addClient(sessionId, client);
		this.lineage.kick();
		return {
			init: {
				type: "init",
				state: {
					...buildStatus(runtime.session, runtime.cwd, runtime.projectTrust, runtime.git.current()),
					lineage: this.lineage.current(sessionId) ?? null,
					relay,
				},
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
		this.notifyStatus();
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
			const path = this.assertAllowedResumePath(request.resumeSessionPath);
			if (!this.isHostedPath(path)) {
				const neverSaved = await this.neverSaved(path);
				if (neverSaved) throw new NeverSavedError(neverSaved.cwd);
				// read-only first: a sub stays read-only after its writer stops, so the page follows it either way
				await this.assertLoadable(path);
				await this.assertNotRunningElsewhere(path, request.takeOver === true);
			}
			const runtime = await this.resumeSession(path, clientId, { choice: request.projectTrust });
			return { sessionId: runtime.session.sessionId };
		}

		const cwd = await this.assertAllowedCwd(request.cwd ?? process.cwd());
		const projectTrust = this.decideProjectTrust(cwd, request.projectTrust);
		// at the cap a slot goes to the new session: who waits on subs right now decides which
		if (!this.hasRoom()) await this.refreshPresence();
		this.ensureCapacity();
		const sessionManager = SessionManager.create(cwd);
		const { session, ui } = await this.createRuntimeSession(cwd, sessionManager, projectTrust);
		await this.applyStartSettings(session, request);
		const tripwireAllowedRoots = await this.buildTripwireAllowedRoots(cwd);
		const runtime = this.registerSession(session, ui, projectTrust, cwd, clientId, tripwireAllowedRoots);
		return { sessionId: runtime.session.sessionId };
	}

	/** The model and thinking level a new session was asked to start with, where they still apply; the defaults otherwise. */
	private async applyStartSettings(session: AgentSession, request: Pick<ApiCreateSessionRequest, "model" | "thinkingLevel">): Promise<void> {
		const wanted = request.model;
		if (wanted && (session.model?.provider !== wanted.provider || session.model?.id !== wanted.id)) {
			const modelRuntime = await this.refreshModelRuntime();
			const model = modelRuntime.getAvailableSnapshot().find((m) => m.provider === wanted.provider && m.id === wanted.id);
			if (model) await session.setModel(model).catch(() => {});
		}
		const level = request.thinkingLevel;
		if (level && isThinkingLevel(level) && session.thinkingLevel !== level) session.setThinkingLevel(level);
	}

	/**
	 * Whether a session path has nothing behind it because nobody ever sent the session a message (see
	 * never-saved.ts), with the folder it ran in; null for a hosted session, a file that's there, or a path that
	 * isn't a session's. `sessionId`, when given, must be the one the file would be named for.
	 */
	async neverSaved(rawPath: string, sessionId?: string): Promise<ApiNeverSaved | null> {
		let path: string;
		try {
			path = this.assertAllowedResumePath(rawPath);
		} catch {
			return null;
		}
		if (this.isHostedPath(path)) return null;
		const folders = await this.listRepos().catch((): string[] => []);
		return classifyNeverSaved(path, { sessionsDir: resolve(this.agentDir, "sessions"), folders, exists: existsSync, sessionId });
	}

	/**
	 * A second copy of a session another process is writing would be a frozen snapshot, and typing into it
	 * makes two writers on one file. Allowed once the turn closed, the writer is gone, or it went quiet and
	 * the user asked to take over.
	 */
	private async assertNotRunningElsewhere(path: string, takeOver: boolean): Promise<void> {
		const summaries = await this.sessionIndex.summarize([path]);
		const elsewhere = (await this.elsewhereOf(summaries)).get(path);
		if (!elsewhere || elsewhere.state === "stopped") return;
		if (elsewhere.state === "quiet" && takeOver) return;
		throw new RunningElsewhereError(elsewhere);
	}

	/** The pi process writing a session elsewhere, stopped so the session can be continued here. */
	async stopElsewhere(sessionId: string, rawPath: string): Promise<{ stopped: number[] }> {
		const path = this.assertAllowedResumePath(rawPath);
		if (this.isHostedPath(path)) throw new Error("session_hosted_here");
		const [summary] = await this.sessionIndex.summarize([path]);
		if (!summary) throw new Error("session_file_missing");
		if (summary.id !== sessionId) throw new Error("session_path_mismatch");
		if (!isOpenTurn(summary.turn)) return { stopped: [] };
		this.piProcesses.invalidate();
		const processes = await this.piProcesses.list();
		if (processes === null) throw new Error("processes_unavailable");
		const writers = writersOf(processes, { cwd: summary.cwd, lastWriteMs: Date.parse(summary.lastWrite) });
		if (writers.length > 1) throw new AmbiguousWritersError(writers.map((writer) => writer.pid));
		const writer = writers[0];
		if (!writer) return { stopped: [] };
		const result = await this.stopPiProcess(writer);
		this.piProcesses.invalidate();
		if (result === "alive") throw new Error("writer_still_running");
		return { stopped: [writer.pid] };
	}

	private async followState(path: string, cwd: string, turn: Turn, lastWriteMs: number): Promise<ApiFollowState> {
		const lastWrite = new Date(lastWriteMs).toISOString();
		if (this.isHostedPath(path)) return { state: "hosted", turn, lastWrite, writers: [] };
		const processes = await this.piProcesses.list();
		const writers = processes === null ? null : writersOf(processes, { cwd, lastWriteMs });
		return { state: classifyElsewhere(turn, lastWriteMs, writers) ?? "done", turn, lastWrite, writers: pidsOf(writers) };
	}

	/**
	 * Streams a session file pi-web isn't hosting: a snapshot, then each batch of whole entries appended to it,
	 * and where the turn and its writer stand. Read-only: nothing here ever writes the file. `limit` asks
	 * for a smaller first page, like connectClient's, for a pane that only shows the tail (a canvas tile).
	 */
	async followSession(
		sessionId: string,
		rawPath: string,
		client: FollowClient,
		since?: string,
		options: { limit?: number } = {},
	): Promise<{ init: FollowSseEvent; cursor: string | undefined; stop: () => void }> {
		const path = this.assertAllowedResumePath(rawPath);
		const snapshot = await readSessionSnapshot(path);
		if (snapshot.sessionId !== sessionId) throw new Error("session_path_mismatch");
		const { cwd } = snapshot;
		let { offset, turn, info } = snapshot;
		let lastWriteMs = snapshot.mtimeMs;
		let follow = await this.followState(path, cwd, turn, lastWriteMs);
		let checkedAtMs = Date.now();
		let busy = false;
		let relay = relayStateOf(snapshot.branch);
		const lineageNow = () => this.lineage.current(sessionId) ?? null;
		let lineageKey = JSON.stringify(lineageNow());
		// read once: following is read-only, and a branch switch elsewhere shows on the next open
		const gitBranch = await readGitBranch(findGitHead(cwd));
		await this.refreshPresence();
		// a sub, or a session whose folder is gone: the page never offers to continue it here
		let readOnly = await this.readOnlyFor(sessionId, cwd);
		const describe = (): ApiFollowSession => ({
			sessionId,
			path,
			cwd,
			gitBranch,
			sessionName: info.sessionName,
			model: info.model,
			thinkingLevel: info.thinkingLevel,
			lineage: lineageNow(),
			relay: relayView(relay),
			readOnly,
		});

		const tick = async () => {
			const appended = await readAppended(path, offset);
			if (appended === "rewritten") {
				stop();
				client.close();
				return;
			}
			offset = appended.offset;
			const grew = appended.entries.length > 0;
			if (grew) {
				turn = turnOfEntries(appended.entries, turn);
				info = followInfo(appended.entries, info);
				relay = relayStateOf(appended.entries, relay);
				lastWriteMs = appended.mtimeMs;
			}
			// a lineage change (a child came, ended or died) goes out as a new description with no entries
			const lineage = JSON.stringify(lineageNow());
			if (grew || lineage !== lineageKey) {
				lineageKey = lineage;
				const messages = appended.entries.flatMap(entryTranscriptMessages);
				client.send({ type: "follow_entries", messages, session: describe() }, appended.entries.at(-1)?.id);
			}
			if (!grew && Date.now() - checkedAtMs < FOLLOW_STATE_CHECK_MS) return;
			checkedAtMs = Date.now();
			// its folder can go while it's followed (pfs removed the fork): a new description, no entries
			const nextReadOnly = await this.readOnlyFor(sessionId, cwd);
			if (JSON.stringify(nextReadOnly) !== JSON.stringify(readOnly)) {
				readOnly = nextReadOnly;
				client.send({ type: "follow_entries", messages: [], session: describe() });
			}
			const next = await this.followState(path, cwd, turn, lastWriteMs);
			if (sameFollowState(next, follow)) return;
			follow = next;
			client.send({ type: "follow_state", follow });
		};
		const timer = setInterval(() => {
			if (busy) return;
			busy = true;
			tick()
				.catch(() => {
					stop();
					client.close();
				})
				.finally(() => {
					busy = false;
				});
		}, this.followPollMs);
		timer.unref?.();
		const follower = { stop, sessionId };
		const followers = this.followers;
		function stop(): void {
			clearInterval(timer);
			followers.delete(follower);
		}
		followers.add(follower);
		this.lineage.kick();

		const transcript = resyncTranscript(snapshot.branch, since, initialTranscriptLimits(options.limit));
		const init: FollowSseEvent = { type: "follow_init", session: describe(), transcript, follow, cursor: snapshot.leafId };
		return { init, cursor: snapshot.leafId ?? undefined, stop };
	}

	/**
	 * Brings back a session pi-web disposed for idling, as long as nothing else (e.g. the pi CLI)
	 * wrote to its file since. Released sessions and files changed elsewhere need an explicit reopen.
	 */
	async attachSession(sessionId: string, rawPath: string | undefined, clientId: string): Promise<void> {
		if (this.runningById.has(sessionId)) return;
		if (!rawPath) throw new Error("session_not_running");
		const path = this.assertAllowedResumePath(rawPath);
		// a page holding a session that opens read-only now (a sub, its folder gone) is told so, and follows it instead
		if (!this.resumingByPath.has(path)) await this.assertLoadable(path);
		if (!this.resumingByPath.has(path) && !this.isUnchangedSinceDetach(path, sessionId)) {
			throw new Error("session_not_attachable");
		}
		await this.resumeSession(path, clientId, { expectedSessionId: sessionId, detachedTrust: this.detachedByPath.get(path)?.projectTrust });
	}

	/** Sessions pi-web disposed (idle, at the cap, at a restart) that it may bring back by itself, for msg mail (msg-mail.ts) and subs waiting. */
	detachedSessions(): DetachedRef[] {
		return [...this.detachedByPath].map(([path, record]) => ({ sessionId: record.sessionId, path, ...(record.cwd ? { cwd: record.cwd } : {}) }));
	}

	/** Forgets the re-attach record of a detached session that opens read-only now (msg mail found it): nothing brings it back. */
	dropDetached(sessionId: string, path: string): void {
		if (this.detachedByPath.get(path)?.sessionId === sessionId) this.forgetDetached(path);
	}

	private forgetDetached(path: string): boolean {
		if (!this.detachedByPath.delete(path)) return false;
		this.persistDetached();
		return true;
	}

	/** Who holds the session slots, for msg mail's rule on making room (msg-mail.ts). */
	sessionRoom(): Room {
		return {
			max: this.maxRunningSessions,
			running: [...this.runningById.values()].map((runtime) => ({
				sessionId: runtime.session.sessionId,
				path: runtime.sessionFile,
				evictable: this.isEvictable(runtime),
				lastActivityAtMs: this.lastActivityAtMs(runtime),
			})),
			resuming: [...this.resumingByPath.keys()],
		};
	}

	/**
	 * Brings back a session pi-web disposed, with no viewer, because msg mail waits for it (msg-mail.ts): attachSession's
	 * rule, nothing running or resuming it, and a free slot, or the one `evict` gives up when it's still idle and unwatched.
	 * Checked and started in one synchronous step; null when it can't be reopened right now.
	 */
	reopenForMail(sessionId: string, path: string, evict: string | null): MailReopen | null {
		if (this.closing || this.runningById.has(sessionId) || this.isHostedPath(path) || !this.isUnchangedSinceDetach(path, sessionId)) return null;
		const room = this.hasRoom();
		const candidate = evict === null ? undefined : this.runningById.get(evict);
		const victim = !room && candidate && this.isEvictable(candidate) ? candidate : null;
		if (!room && !victim) return null;
		const allowed = this.assertAllowedResumePath(path);
		const detachedTrust = this.detachedByPath.get(path)?.projectTrust;
		if (victim) {
			this.rememberDetached(victim);
			this.disposeRuntime(victim);
		}
		const running = this.resumeSession(allowed, null, { expectedSessionId: sessionId, detachedTrust }).then(() => undefined);
		return { evicted: victim ? victim.session.sessionId : null, running };
	}

	isUnchangedSinceDetach(path: string, sessionId: string): boolean {
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
			projectTrust: runtime.projectTrust,
			cwd: runtime.cwd,
		});
		this.persistDetached();
	}

	/**
	 * Restores re-attach records written before a restart, keeping only files nobody touched since, and forgets the ones
	 * that open read-only now (subs, folders gone).
	 */
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
		// records from before pi-web kept the folder: the file's header names it
		const unknownFolders = [...this.detachedByPath].filter(([, record]) => record.cwd === undefined);
		await Promise.all(
			unknownFolders.map(async ([path, record]) => {
				const header = await readSessionHeader(path).catch(() => null);
				if (header?.cwd) record.cwd = header.cwd;
			}),
		);
		await this.refreshPresence();
		await this.pruneDetached();
		return this.detachedByPath.size;
	}

	/** Forgets the re-attach records of sessions that open read-only now (subs, folders gone): nothing brings those back. */
	private async pruneDetached(): Promise<SweepReport["forgotten"]> {
		const judged = await Promise.all(
			[...this.detachedByPath].map(async ([path, record]) => ({ path, record, readOnly: await this.detachedReadOnly(record.sessionId, record.cwd) })),
		);
		const forgotten = judged.flatMap(({ path, record, readOnly }) => (readOnly && this.detachedByPath.get(path) === record ? [{ path, sessionId: record.sessionId, readOnly }] : []));
		if (forgotten.length === 0) return [];
		for (const { path } of forgotten) this.detachedByPath.delete(path);
		this.persistDetached();
		for (const { sessionId, readOnly } of forgotten) this.log(`[pi-web] forgot ${sessionId} for re-attach: ${readOnlyWords(readOnly)}`);
		return forgotten.map(({ sessionId, readOnly }) => ({ sessionId, readOnly }));
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

	/** Stops runs, records every session for re-attach after the restart (resumes under way too), and disposes them. */
	async shutdown(timeoutMs = 5_000): Promise<void> {
		this.closing = true;
		this.lineage.stop();
		for (const follower of [...this.followers]) follower.stop();
		if (this.resumingByPath.size > 0) {
			const resumed = Promise.allSettled([...this.resumingByPath.values()]);
			await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
		}
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

	/** `clientId` null resumes with no controller: the first viewer to connect takes it. */
	private async resumeSession(
		path: string,
		clientId: string | null,
		options: { expectedSessionId?: string; choice?: ApiProjectTrustChoice; detachedTrust?: ApiProjectTrust } = {},
	): Promise<RunningSession> {
		const { expectedSessionId } = options;
		const existingId = this.runningByPath.get(path);
		const existing = existingId ? this.runningById.get(existingId) : undefined;
		if (existing) {
			if (expectedSessionId !== undefined && existing.session.sessionId !== expectedSessionId) {
				throw new Error("session_path_mismatch");
			}
			if (clientId !== null) this.claimControllerIfVacant(existing, clientId);
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
		clientId: string | null,
		options: { expectedSessionId?: string; choice?: ApiProjectTrustChoice; detachedTrust?: ApiProjectTrust },
	): Promise<RunningSession> {
		if (!existsSync(path)) {
			throw new Error(`session file does not exist: ${path}`);
		}
		// every load comes through here: a sub or a session whose folder is gone never gets a runtime (msg-subs.ts)
		await this.assertLoadable(path);
		const sessionManager = SessionManager.open(path);
		if (options.expectedSessionId !== undefined && sessionManager.getSessionId() !== options.expectedSessionId) {
			throw new Error("session_path_mismatch");
		}
		const cwd = sessionManager.getCwd();
		const projectTrust = this.decideProjectTrust(cwd, options.choice, options.detachedTrust);
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

	/** A running session as eviction sees it (session-slots.ts): who watches it, whether it works, whether subs wait on it. */
	private slotOf(runtime: RunningSession, now: number): Slot {
		return {
			sessionId: runtime.session.sessionId,
			viewers: runtime.clients.size,
			idle: runtime.session.isIdle,
			waiting: this.waitingOnSubs(runtime.session.sessionId, now),
			lastActivityAtMs: this.lastActivityAtMs(runtime),
		};
	}

	/** Idle with nobody watching and no sub counting on it: what the idle sweep and the cap may dispose. */
	private isEvictable(runtime: RunningSession, now = this.clock()): boolean {
		return isEvictableSlot(this.slotOf(runtime, now));
	}

	private hasRoom(): boolean {
		return this.runningById.size + this.resumingByPath.size < this.maxRunningSessions;
	}

	/** Frees a slot by disposing the least recently used idle session nobody is watching and no sub waits on; full otherwise. */
	private ensureCapacity(): void {
		if (this.hasRoom()) return;
		const now = this.clock();
		const victimId = capacityVictim([...this.runningById.values()].map((runtime) => this.slotOf(runtime, now)));
		const victim = victimId === null ? undefined : this.runningById.get(victimId);
		if (!victim) throw new Error("too_many_active_sessions");
		this.rememberDetached(victim);
		this.disposeRuntime(victim);
	}

	/**
	 * Disposes idle sessions without viewers that no sub waits on; their jsonl is already persisted, so attaching resumes
	 * them. Waiting is judged from the presence records as last read (sweep reads them first).
	 */
	evictIdleSessions(now = this.clock()): string[] {
		const slots = [...this.runningById.values()].map((runtime) => ({
			...this.slotOf(runtime, now),
			saved: runtime.sessionFile !== null && existsSync(runtime.sessionFile),
		}));
		const expired = idleVictims(slots, now, this.idleSessionTtlMs).flatMap((sessionId) => {
			const runtime = this.runningById.get(sessionId);
			return runtime ? [runtime] : [];
		});
		for (const runtime of expired) {
			this.rememberDetached(runtime);
			this.disposeRuntime(runtime);
		}
		return expired.map((runtime) => runtime.session.sessionId);
	}

	/**
	 * One idle sweep, with msg's presence records read once (a readdir and the files that changed, never a read per
	 * session): re-attach records of sessions that open read-only now are forgotten, idle sessions nobody watches and no
	 * sub waits on are disposed, and detached sessions some sub still counts on come back with no viewer (after a restart,
	 * so msg in them watches their subs again), a few a sweep.
	 */
	async sweep(now = this.clock()): Promise<SweepReport> {
		await this.refreshPresence();
		const forgotten = await this.pruneDetached();
		const disposed = this.evictIdleSessions(now);
		for (const sessionId of disposed) this.log(`[pi-web] disposed idle session ${sessionId}`);
		const reopened = await this.reopenWaiting(now);
		return { forgotten, disposed, reopened };
	}

	/** Says once per reason why a parent its subs wait on stays down. */
	private tellWaiting(sessionId: string, key: string, line: string): void {
		if (this.waitingTold.get(sessionId) === key) return;
		this.waitingTold.set(sessionId, key);
		this.log(line);
	}

	private whyNotReopened(sessionId: string, reason: WaitingSkip): string {
		if (reason === "changed") return "its file changed since pi-web disposed it";
		if (reason === "owned") return `pid ${String(this.presence.record(sessionId)?.pid)} runs it`;
		return "it opens read-only";
	}

	/** msg's live (no end, a fresh heartbeat, a running pid) in a process that isn't this server. */
	private runsElsewhere(sessionId: string, now: number): boolean {
		const record = this.presence.record(sessionId);
		return record !== undefined && ownedElsewhere({ ...record, pidAlive: this.probePid(record.pid) }, process.pid, now);
	}

	/** A detached session opens read-only now; one whose record never said where it ran is judged by msg's record alone. */
	private async detachedReadOnly(sessionId: string, cwd: string | undefined): Promise<ApiReadOnly | null> {
		return readOnlyOf(this.presence.record(sessionId), cwd === undefined || (await isDirectory(cwd)));
	}

	/**
	 * Brings back, with no viewer, the detached sessions some sub still counts on: only a restart detaches one (nothing
	 * else disposes a session that waits). Not one released, changed since, run by another live process or read-only;
	 * a full house takes a slot from an idle session nothing waits on, or the parent waits for the next sweep.
	 */
	private async reopenWaiting(now: number): Promise<string[]> {
		if (this.closing) return [];
		const detached = this.detachedSessions().filter((ref) => !this.waitingFailed.has(ref.sessionId));
		const waiting = new Set(detached.filter((ref) => this.waitingOnSubs(ref.sessionId, now)).map((ref) => ref.sessionId));
		for (const sessionId of [...this.waitingTold.keys()]) if (!waiting.has(sessionId)) this.waitingTold.delete(sessionId);
		if (waiting.size === 0) return [];
		const candidates = detached.filter((ref) => waiting.has(ref.sessionId));
		const judged = await Promise.all(candidates.map(async (ref) => ({ ref, readOnly: await this.detachedReadOnly(ref.sessionId, ref.cwd) })));
		const plan = planWaitingReopens({
			detached: candidates,
			waiting,
			readOnly: new Set(judged.flatMap(({ ref, readOnly }) => (readOnly ? [ref.sessionId] : []))),
			unchanged: new Set(candidates.filter((ref) => this.isUnchangedSinceDetach(ref.path, ref.sessionId)).map((ref) => ref.sessionId)),
			owned: new Set(candidates.filter((ref) => this.runsElsewhere(ref.sessionId, now)).map((ref) => ref.sessionId)),
			hostedIds: new Set(this.runningById.keys()),
			hostedPaths: new Set([...this.runningByPath.keys(), ...this.resumingByPath.keys()]),
			limit: MAX_REOPENS_PER_LOOK,
		});
		for (const skip of plan.skipped) {
			this.tellWaiting(skip.sessionId, skip.reason, `[pi-web] not reopening ${skip.sessionId} for its subs: ${this.whyNotReopened(skip.sessionId, skip.reason)}`);
		}
		const results = await Promise.all(plan.reopen.map(async (ref) => ((await this.reopenParent(ref)) ? [ref.sessionId] : [])));
		return results.flat();
	}

	/** One parent back with no viewer; false when it isn't (no room: the next sweep tries again; anything else: not this run). */
	private async reopenParent(ref: DetachedRef): Promise<boolean> {
		if (this.closing || this.runningById.has(ref.sessionId) || this.isHostedPath(ref.path)) return false;
		try {
			const detachedTrust = this.detachedByPath.get(ref.path)?.projectTrust;
			await this.resumeSession(this.assertAllowedResumePath(ref.path), null, { expectedSessionId: ref.sessionId, detachedTrust });
		} catch (error) {
			const message = errorMessage(error);
			if (message === "too_many_active_sessions") {
				const line = `[pi-web] no room to reopen ${ref.sessionId} for its subs: ${String(this.runningById.size + this.resumingByPath.size)} of ${String(this.maxRunningSessions)} sessions running, none idle, unwatched and without subs of its own; it waits for a slot`;
				this.tellWaiting(ref.sessionId, "room", line);
				return false;
			}
			this.waitingFailed.add(ref.sessionId);
			this.tellWaiting(ref.sessionId, "failed", `[pi-web] could not reopen ${ref.sessionId} for its subs: ${message}`);
			return false;
		}
		this.waitingTold.delete(ref.sessionId);
		this.log(`[pi-web] reopened ${ref.sessionId} for its subs`);
		return true;
	}

	/**
	 * Sweeps every intervalMs (by default every minute, or a quarter of a short idle ttl), the first one right away: after
	 * a restart, the parents whose subs still count come back at once.
	 */
	startIdleSweep(intervalMs = Math.min(IDLE_SWEEP_INTERVAL_MS, Math.max(MIN_IDLE_SWEEP_INTERVAL_MS, Math.floor(this.idleSessionTtlMs / 4)))): () => void {
		let sweeping = false;
		const run = () => {
			if (sweeping || this.closing) return;
			sweeping = true;
			void this.sweep()
				.catch((error: unknown) => console.error(`[pi-web] idle sweep failed: ${errorMessage(error)}`))
				.finally(() => {
					sweeping = false;
				});
		};
		const timer = setInterval(run, intervalMs);
		timer.unref?.();
		run();
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
		runtime.git.dispose();
		this.runningById.delete(sessionId);
		if (runtime.sessionFile) {
			this.runningByPath.delete(runtime.sessionFile);
		}
		this.tripwireService.forgetSession(sessionId);
		this.notifyStatus();
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
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session, runtime.git.current()) });
			return { ok: true };
		}

		if (command.type === "set_thinking_level") {
			this.assertController(runtime, command.clientId);
			const level = command.level.trim();
			if (!isThinkingLevel(level)) throw new Error(`invalid_thinking_level: ${level}`);
			runtime.session.setThinkingLevel(level);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session, runtime.git.current()) });
			return { ok: true };
		}

		if (command.type === "set_steering_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_steering_mode: ${String(mode)}`);
			runtime.session.setSteeringMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session, runtime.git.current()) });
			return { ok: true };
		}

		if (command.type === "set_follow_up_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_follow_up_mode: ${String(mode)}`);
			runtime.session.setFollowUpMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session, runtime.git.current()) });
			return { ok: true };
		}

		if (command.type === "set_auto_compaction") {
			this.assertController(runtime, command.clientId);
			runtime.session.setAutoCompactionEnabled(Boolean(command.enabled));
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session, runtime.git.current()) });
			return { ok: true };
		}

		if (command.type === "set_session_name") {
			this.assertController(runtime, command.clientId);
			const name = command.name.trim();
			if (!name) throw new Error("invalid_session_name");
			runtime.session.setSessionName(name);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session, runtime.git.current()) });
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
		controllerClientId: string | null,
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
			git: watchGitBranch(cwd, () => this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(session, runtime.git.current()) })),
			live: EMPTY_LIVE_SNAPSHOT,
			outbox: [],
			flushScheduled: false,
			relay: null,
			relayKey: "null",
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
			// a run (its bash calls above all) is what switches branches under a session; HEAD's watcher catches the rest
			if (event.type === "agent_end" || (event.type === "tool_execution_end" && event.toolName === "bash")) runtime.git.refresh();
			if (STATE_PATCH_EVENTS.has(event.type)) {
				const patch = buildPatch(session, runtime.git.current());
				// auto-compaction releases its abort controller only after compaction_end listeners ran
				if (event.type === "compaction_end") patch.isCompacting = false;
				this.broadcast(sessionId, { type: "state_patch", patch });
			}
			// token totals and context use move with every message that lands, not just when the run ends (like
			// pi's own footer); pi writes the message to the session after message_end listeners ran, so read then
			if (event.type === "message_end") {
				queueMicrotask(() => this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(session, runtime.git.current()) }));
			}
			// an extension's compaction at a turn boundary (a relay reset) empties the context without compaction events
			if (event.type === "entry_appended" && event.entry.type === "compaction") {
				this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(session, runtime.git.current()) });
			}
			if (event.type === "entry_appended" || event.type === "compaction_end") this.patchRelay(runtime);
			if (event.type === "message_end") queueMicrotask(() => this.patchRelay(runtime));
		});
		runtime.unsubscribe = unsubscribe;

		this.runningById.set(sessionId, runtime);
		if (sessionFile) {
			this.runningByPath.set(sessionFile, sessionId);
		}
		this.notifyStatus();

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
		if (event.type === "state_patch" || event.type === "extension_ui_request" || event.type === "extension_ui_closed") this.notifyStatus();
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
