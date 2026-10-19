import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type WireMessageUpdate = Extract<JsonAgentSessionEvent, { type: "message_update" }>;
type WireAssistantMessageEvent = WireMessageUpdate["assistantMessageEvent"];

const EMPTY_USAGE: WireMessageUpdate["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toWireAssistantMessageEvent(event: MessageUpdateEvent["assistantMessageEvent"]): WireAssistantMessageEvent {
	if (event.type === "toolcall_start") {
		const { partial, ...delta } = event;
		const block = partial.content[event.contentIndex];
		const toolCall = block?.type === "toolCall" ? block : null;
		return { ...delta, id: toolCall?.id ?? "", toolName: toolCall?.name ?? "" };
	}
	if (!("partial" in event)) return event;
	const { partial: _partial, ...delta } = event;
	return delta;
}

function messageUsage(message: MessageUpdateEvent["message"]): WireMessageUpdate["usage"] {
	return message.role === "assistant" ? message.usage : EMPTY_USAGE;
}

type EntryAppendedEvent = Extract<AgentSessionEvent, { type: "entry_appended" }>;

/** A compaction entry carries the whole system prompt it was made under; the page draws the summary, not that. */
function toWireEntryAppended(event: EntryAppendedEvent): EntryAppendedEvent {
	if (event.entry.type !== "compaction" || event.entry.systemMessage === undefined) return event;
	const { systemMessage: _systemMessage, ...entry } = event.entry;
	return { ...event, entry };
}

/**
 * Mirrors pi's json/rpc wire format: streaming updates drop the cumulative `message` and
 * `partial` snapshots so traffic grows with the deltas instead of the square of the message size.
 */
export function toWireEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type === "entry_appended") return toWireEntryAppended(event);
	if (event.type !== "message_update") return event;
	return {
		type: "message_update",
		usage: messageUsage(event.message),
		assistantMessageEvent: toWireAssistantMessageEvent(event.assistantMessageEvent),
	};
}
