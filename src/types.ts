import type { AgentMessage, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

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

export interface ApiSessionState {
	sessionId: string;
	cwd: string;
	sessionFile: string | null;
	sessionName?: string;
	isStreaming: boolean;
	model: { provider: string; id: string; name?: string } | null;
	thinkingLevel: string;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	stats: ApiSessionStats | null;
	contextUsage: ApiContextUsage | null;
	messages: AgentMessage[];
}

export type ApiCommandRequest =
	| { type: "prompt"; clientId: string; text: string; deliverAs?: "followUp" | "steer" }
	| { type: "abort"; clientId: string }
	| { type: "set_model"; clientId: string; provider: string; modelId: string }
	| { type: "set_thinking_level"; clientId: string; level: string }
	| { type: "set_steering_mode"; clientId: string; mode: "all" | "one-at-a-time" }
	| { type: "set_follow_up_mode"; clientId: string; mode: "all" | "one-at-a-time" }
	| { type: "set_session_name"; clientId: string; name: string };

export interface ApiSessionPatch {
	model?: ApiSessionState["model"];
	thinkingLevel?: string;
	sessionName?: string;
	steeringMode?: ApiSessionState["steeringMode"];
	followUpMode?: ApiSessionState["followUpMode"];
	stats?: ApiSessionState["stats"];
	contextUsage?: ApiSessionState["contextUsage"];
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
	| { type: "state_patch"; patch: ApiSessionPatch }
	| { type: "controller_changed"; controllerClientId: string | null }
	| { type: "released"; byClientId: string };
