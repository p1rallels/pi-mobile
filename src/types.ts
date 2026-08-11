import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

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
}

export interface ApiCreateSessionRequest {
	clientId?: string;
	cwd?: string;
	resumeSessionPath?: string;
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

export interface ApiSessionState {
	sessionId: string;
	cwd: string;
	sessionFile: string | null;
	sessionName?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	model: { provider: string; id: string; name?: string } | null;
	thinkingLevel: string;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	autoCompactionEnabled: boolean;
	queuedMessages: ApiQueuedMessages;
	stats: ApiSessionStats | null;
	contextUsage: ApiContextUsage | null;
	messages: AgentSession["messages"];
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
	messages?: ApiSessionState["messages"];
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

export type ApiTripwireResponse = "logged" | "abort_requested";

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
			state: ApiSessionState;
			yourClientId: string;
			controllerClientId: string | null;
			role: ClientRole;
	  }
	| { type: "agent_event"; event: AgentSessionEvent }
	| { type: "tripwire_alert"; alert: ApiTripwireAlert }
	| { type: "state_patch"; patch: ApiSessionPatch }
	| { type: "controller_changed"; controllerClientId: string | null }
	| { type: "released"; byClientId: string };
