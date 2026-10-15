import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ApiExtensionUiSnapshot, ExtensionUiEvent } from "./extension-ui.ts";
import type { LiveSnapshot } from "./live-snapshot.ts";
import type { ApiProjectTrust, ApiProjectTrustChoice, ApiProjectTrustPrompt } from "./project-trust.ts";
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
}

export interface ApiActiveSessionsResponse {
	sessions: ApiSessionSummary[];
}

export interface ApiErrorResponse {
	error: string;
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
}

export interface ApiListSessionsResponse {
	sessions: ApiSessionSummary[];
	hasMore: boolean;
}

export interface ApiCreateSessionRequest {
	clientId?: string;
	cwd?: string;
	resumeSessionPath?: string;
	/** The answer to a project trust prompt, sent when the first attempt was refused with one. */
	projectTrust?: ApiProjectTrustChoice;
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

export interface ApiSessionStatus {
	sessionId: string;
	projectTrust: ApiProjectTrust;
	cwd: string;
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
