import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];
type CompactionReason = Extract<AgentSessionEvent, { type: "compaction_start" }>["reason"];
type ToolExecutionEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>;

export interface LiveToolCall {
	toolCallId: string;
	toolName: string;
	args: unknown;
	parentToolCallId?: string;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	durationMs?: number;
	done: boolean;
}

/** What a run has shown that is not in the session file yet: a (re)connecting viewer renders it after the persisted entries. */
export interface LiveSnapshot {
	streamingMessage: AgentMessage | null;
	tools: readonly LiveToolCall[];
	retry: { attempt: number; maxAttempts: number } | null;
	compaction: { reason: CompactionReason } | null;
}

export const EMPTY_LIVE_SNAPSHOT: LiveSnapshot = { streamingMessage: null, tools: [], retry: null, compaction: null };

function upsertTool(tools: readonly LiveToolCall[], event: ToolExecutionEvent, patch: Partial<LiveToolCall>): readonly LiveToolCall[] {
	const existing = tools.find((tool) => tool.toolCallId === event.toolCallId);
	const base: LiveToolCall = existing ?? {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		args: "args" in event ? event.args : undefined,
		done: false,
		...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
	};
	const next = { ...base, ...patch };
	return existing ? tools.map((tool) => (tool === existing ? next : tool)) : [...tools, next];
}

/** Tool results land in the session file, so the call and the calls it made itself leave the live view. */
function dropPersistedTool(tools: readonly LiveToolCall[], toolCallId: string): readonly LiveToolCall[] {
	return tools.filter((tool) => tool.toolCallId !== toolCallId && tool.parentToolCallId !== toolCallId);
}

function reduceMessageEnd(state: LiveSnapshot, message: AgentMessage): LiveSnapshot {
	switch (message.role) {
		case "assistant":
			return { ...state, streamingMessage: null };
		case "toolResult":
			return { ...state, tools: dropPersistedTool(state.tools, message.toolCallId) };
		default:
			return state;
	}
}

export function reduceLiveSnapshot(state: LiveSnapshot, event: AgentSessionEvent): LiveSnapshot {
	switch (event.type) {
		case "message_start":
		case "message_update":
			return event.message.role === "assistant" ? { ...state, streamingMessage: event.message } : state;
		case "message_end":
			return reduceMessageEnd(state, event.message);
		case "tool_execution_start":
			return { ...state, tools: upsertTool(state.tools, event, { args: event.args, done: false }) };
		case "tool_execution_update":
			return { ...state, tools: upsertTool(state.tools, event, { partialResult: event.partialResult }) };
		case "tool_execution_end":
			return {
				...state,
				tools: upsertTool(state.tools, event, {
					done: true,
					result: event.result,
					isError: event.isError,
					partialResult: undefined,
					...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
				}),
			};
		case "auto_retry_start":
			return { ...state, retry: { attempt: event.attempt, maxAttempts: event.maxAttempts } };
		case "auto_retry_end":
			return { ...state, retry: null };
		case "compaction_start":
			return { ...state, compaction: { reason: event.reason } };
		case "compaction_end":
			return { ...state, compaction: null };
		case "agent_settled":
			return { ...EMPTY_LIVE_SNAPSHOT, compaction: state.compaction };
		default:
			return state;
	}
}
