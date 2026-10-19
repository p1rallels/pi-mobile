import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { DirectoryListing } from "./directories.ts";
import type { ApiExtensionUiSnapshot, ExtensionUiEvent } from "./extension-ui.ts";
import type { LiveSnapshot } from "./live-snapshot.ts";
import type { ElsewhereState } from "./outside-writers.ts";
import type { ApiProjectTrust, ApiProjectTrustChoice, ApiProjectTrustPrompt } from "./project-trust.ts";
import type { Turn } from "./session-turn.ts";
import type { TerminalEndReason } from "./terminals.ts";
import type { TranscriptMessage, TranscriptPage } from "./transcript.ts";

export type ClientRole = "controller" | "viewer";

export interface ApiModelInfo {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ApiListModelsResponse {
	models: ApiModelInfo[];
}

export interface ApiListReposResponse {
	repos: string[];
}

/** A folder pi sessions ran in that isn't a saved repo. */
export interface ApiRepoSuggestion {
	cwd: string;
	/** The newest session file's last write. */
	modified: string;
	sessions: number;
	/** "repo · fork 8-hooks" for a pfs fork (<repo>/.forks/<n>). */
	forkLabel?: string;
}

export interface ApiRepoSuggestionsResponse {
	suggestions: ApiRepoSuggestion[];
}

export interface ApiHostRecord {
	id: string;
	label: string;
	url: string;
	tailscaleName?: string;
	tailscaleIp?: string;
	enabled: boolean;
	createdAt: string;
}

export interface ApiListHostsResponse {
	hosts: ApiHostRecord[];
}

export interface ApiAddRepoRequest {
	cwd: string;
	/** Make the folder first: one new folder, inside the home folder, whose parent exists. */
	create?: boolean;
}

/** GET /api/dirs?path=: what a typed /path or ~/path could continue with. */
export type ApiDirectoryListing = DirectoryListing;

export interface ApiAddRepoResponse {
	ok: true;
	/** The folder as saved: absolute, ~ expanded. */
	cwd: string;
}

export interface ApiActiveSessionsResponse {
	sessions: ApiSessionSummary[];
}

export interface ApiErrorResponse {
	error: string;
}

/**
 * A session path with no file behind it: pi writes a session's file with its first message, so a session nobody
 * sent anything to leaves none once it stops running (see never-saved.ts). `cwd` is the folder it ran in, or null
 * when that can't be told from the path.
 */
export interface ApiNeverSaved {
	neverSaved: true;
	cwd: string | null;
}

/** 404 for a session that isn't running (attach, resume, file reads); one that was never saved says so. */
export type ApiSessionMissingResponse = ApiErrorResponse & Partial<ApiNeverSaved>;

/**
 * 401 from opening a terminal or attaching to one: no Face ID check since this browser last locked its terminals (or
 * none recent enough). The page unlocks its terminals with a check instead of locking itself.
 */
export interface ApiTerminalLockedResponse extends ApiErrorResponse {
	terminalLocked: true;
}

/** 404 for a terminal that isn't running: why it ended when the host still knows (until a restart), else null. */
export interface ApiTerminalMissingResponse extends ApiErrorResponse {
	ended: TerminalEndReason | null;
}

export interface ApiSessionSummary {
	id: string;
	path: string | null;
	cwd: string;
	name?: string;
	firstMessage: string;
	created: string;
	modified: string;
	messageCount: number;
	isRunning: boolean;
	/** Set when pi-web isn't hosting the session and its last message left the turn open. */
	elsewhere?: ApiElsewhere;
	/** "repo · fork 8-hooks" when the session ran in a pfs fork (<repo>/.forks/<n>). */
	forkLabel?: string;
}

export type ApiElsewhereState = ElsewhereState;

/**
 * A session another process may still be writing. running: a pi works in its folder and wrote recently.
 * quiet: same, but no write for a long while, so taking over is allowed. stopped: nobody is left to finish the turn.
 */
export interface ApiElsewhere {
	state: ApiElsewhereState;
	turn: Turn;
	lastWrite: string;
	/** pids of the pi processes that may be writing it, or null when pi-web can't list processes. */
	writers: number[] | null;
}

/** 409 from POST /api/sessions: another process is writing the session; follow it instead, or retry with takeOver once it's quiet. */
export interface ApiRunningElsewhereResponse {
	error: string;
	elsewhere: ApiElsewhere;
}

export interface ApiStopElsewhereRequest {
	path: string;
}

export interface ApiStopElsewhereResponse {
	ok: true;
	/** The pi processes pi-web stopped; empty when nobody was writing any more. */
	stopped: number[];
}

/** A followed session: still elsewhere, its turn closed (done), or pi-web hosts it now (hosted). */
export interface ApiFollowState {
	state: ApiElsewhereState | "done" | "hosted";
	turn: Turn;
	lastWrite: string;
	writers: number[] | null;
}

export interface ApiFollowSession {
	sessionId: string;
	path: string;
	cwd: string;
	gitBranch: string | null;
	sessionName?: string;
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	lineage?: ApiLineage | null;
	relay?: ApiRelayState | null;
}

/**
 * GET /api/sessions/:id/follow?path=: a read-only stream of a session file another process writes. A follow_entries
 * without messages carries a new description (its lineage changed).
 */
export type FollowSseEvent =
	| { type: "follow_init"; session: ApiFollowSession; transcript: ApiResyncTranscript; follow: ApiFollowState; cursor: string | null }
	| { type: "follow_entries"; messages: TranscriptMessage[]; session: ApiFollowSession }
	| { type: "follow_state"; follow: ApiFollowState };

export interface ApiListSessionsResponse {
	sessions: ApiSessionSummary[];
	hasMore: boolean;
}

export interface ApiCreateSessionRequest {
	clientId?: string;
	cwd?: string;
	resumeSessionPath?: string;
	/** Resume a session whose outside writer went quiet; a running one is still refused. */
	takeOver?: boolean;
	/** The answer to a project trust prompt, sent when the first attempt was refused with one. */
	projectTrust?: ApiProjectTrustChoice;
	/** A new session's model, when available (a session standing in for one that was never saved keeps that one's). */
	model?: { provider: string; id: string };
	/** A new session's thinking level, when valid. */
	thinkingLevel?: string;
}

/** 409 from POST /api/sessions in PI_WEB_PROJECT_TRUST=ask mode: answer with `projectTrust` and retry. */
export interface ApiProjectTrustRequiredResponse {
	error: string;
	projectTrust: ApiProjectTrustPrompt;
}

export interface ApiCreateSessionResponse {
	sessionId: string;
}

export interface ApiContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ApiSessionStats {
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
}

export interface ApiQueuedMessages {
	steering: string[];
	followUp: string[];
}

/**
 * How a session in msg's lineage stands, from its presence record: live (no end, a heartbeat under 45s old, its process
 * running), ended (it said so), died (its process is gone and it never ended) or offline (no heartbeat for 45s, though
 * its process is still there). null for a parent that never ran msg (no record).
 */
export type ApiLineageState = "live" | "ended" | "died" | "offline";

/** The parent or a child of a session, as the header shows it (see msg-lineage.ts). */
export interface ApiLineageParty {
	id: string;
	/** msg's name for it; else a parent's folder, a child's first 8 id characters */
	label: string;
	state: ApiLineageState | null;
	/** pi-web can open it: it hosts it, or the session's file is in pi-web's sessions folder */
	openable: boolean;
	/** how and where it runs, like "pi -p · ~/repo/.forks/3"; null without a presence record */
	where: string | null;
}

/** Who started a session and whom it started, from msg's store. */
export interface ApiLineage {
	/** never set for a session pi-web hosts: its process is pi-web's, nobody's child */
	parent: ApiLineageParty | null;
	/** the first few: the ones still around in the order they started, then the ended ones, latest first */
	children: ApiLineageParty[];
	/** every child, listed or not */
	childCount: number;
}

/** Where relay stands on a session's branch (see relay-state.ts); null when it has nothing to say. */
export interface ApiRelayState {
	/** context resets so far */
	resets: number;
	/** the keep-going loop is on */
	loop: boolean;
	/** the goal the loop was switched on with, clipped; null: the session's first message */
	goal: string | null;
	/** the percent relay last nudged the agent at, while that nudge still stands (no compaction since) */
	nudge: number | null;
}

export interface ApiSessionStatus {
	sessionId: string;
	projectTrust: ApiProjectTrust;
	cwd: string;
	/** The branch cwd is on; null off a branch (detached HEAD) or outside git. */
	gitBranch: string | null;
	sessionFile: string | null;
	sessionName?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	retryAttempt: number;
	model: { provider: string; id: string; name?: string } | null;
	thinkingLevel: string;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	autoCompactionEnabled: boolean;
	queuedMessages: ApiQueuedMessages;
	stats: ApiSessionStats | null;
	contextUsage: ApiContextUsage | null;
	/** msg's lineage; null without family, missing until pi-web has read msg's store for it */
	lineage?: ApiLineage | null;
	relay?: ApiRelayState | null;
}

export interface ApiSessionState extends ApiSessionStatus {
	messages: TranscriptMessage[];
	hasOlderMessages: boolean;
}

export type ApiTranscriptPageResponse = TranscriptPage;

/** GET /api/session-transcript?path=&limit=&before=: a page of a session file, no runtime attached. */
export type ApiSessionFileTranscriptResponse = TranscriptPage & { sessionId: string };

export type ApiLiveSnapshot = LiveSnapshot;

/** What a connecting viewer is missing: everything after its cursor, or a fresh last page. */
export type ApiResyncTranscript =
	| { mode: "replace"; messages: TranscriptMessage[]; hasOlder: boolean }
	| { mode: "append"; since: string; messages: TranscriptMessage[] };

export type ApiPromptDisposition = "started" | "queued" | "handled";

export interface ApiCommandResponse {
	ok: true;
	disposition?: ApiPromptDisposition;
}

export type ApiCommandRequest =
	| { type: "prompt"; clientId: string; text: string; deliverAs?: "followUp" | "steer" }
	| { type: "compact"; clientId: string; customInstructions?: string }
	| { type: "abort"; clientId: string }
	| { type: "set_model"; clientId: string; provider: string; modelId: string }
	| { type: "set_thinking_level"; clientId: string; level: string }
	| { type: "set_steering_mode"; clientId: string; mode: "all" | "one-at-a-time" }
	| { type: "set_follow_up_mode"; clientId: string; mode: "all" | "one-at-a-time" }
	| { type: "set_auto_compaction"; clientId: string; enabled: boolean }
	| { type: "set_session_name"; clientId: string; name: string };

export interface ApiSessionPatch {
	gitBranch?: string | null;
	isStreaming?: boolean;
	isCompacting?: boolean;
	retryAttempt?: number;
	model?: ApiSessionState["model"];
	thinkingLevel?: string;
	sessionName?: string;
	steeringMode?: ApiSessionState["steeringMode"];
	followUpMode?: ApiSessionState["followUpMode"];
	autoCompactionEnabled?: ApiSessionState["autoCompactionEnabled"];
	queuedMessages?: ApiSessionState["queuedMessages"];
	stats?: ApiSessionState["stats"];
	contextUsage?: ApiSessionState["contextUsage"];
	lineage?: ApiSessionState["lineage"];
	relay?: ApiSessionState["relay"];
}

export type ApiTripwireSeverity = "observe" | "critical";

export type ApiTripwireCategory = "repo_escape" | "secret_access" | "persistence" | "destructive" | "network" | "runaway";

export type ApiTripwireResponse = "logged" | "abort_requested" | "blocked";

export interface ApiTripwireAlert {
	id: string;
	sessionId: string;
	created: string;
	severity: ApiTripwireSeverity;
	category: ApiTripwireCategory;
	summary: string;
	detail?: string;
	toolName?: string;
	toolCallId?: string;
	response: ApiTripwireResponse;
}

export interface ApiTripwireAlertsResponse {
	alerts: ApiTripwireAlert[];
	unreadAlerts: ApiTripwireAlert[];
	unreadCount: number;
}

export interface ApiOkResponse {
	ok: true;
}

export interface ApiTakeoverRequest {
	clientId: string;
}

export interface ApiReleaseRequest {
	clientId: string;
}

export type SseEvent =
	| {
			type: "init";
			state: ApiSessionStatus;
			transcript: ApiResyncTranscript;
			live: ApiLiveSnapshot;
			ui: ApiExtensionUiSnapshot;
			cursor: string | null;
			yourClientId: string;
			controllerClientId: string | null;
			role: ClientRole;
	  }
	| { type: "agent_event"; event: JsonAgentSessionEvent; entryId?: string }
	| { type: "tripwire_alert"; alert: ApiTripwireAlert }
	| { type: "state_patch"; patch: ApiSessionPatch }
	| { type: "command_error"; command: ApiCommandRequest["type"]; message: string }
	| { type: "controller_changed"; controllerClientId: string | null }
	| { type: "released"; byClientId: string }
	| ExtensionUiEvent
	| CanvasStatusEvent;

/** One running session as the canvas sees it from GET /api/canvas/status, without attaching to it. */
export interface ApiCanvasSessionStatus {
	id: string;
	path: string | null;
	/** streaming or compacting */
	working: boolean;
	/** an extension dialog is waiting for an answer */
	waiting: boolean;
	viewers: number;
}

/** GET /api/canvas/status: every running session's status, sent on connect and whenever one changes. */
export interface CanvasStatusEvent {
	type: "canvas_status";
	sessions: ApiCanvasSessionStatus[];
}
