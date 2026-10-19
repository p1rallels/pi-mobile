import {
	sessionEntryToContextMessages,
	type AgentSession,
	type JsonAgentSessionEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = AgentSession["messages"][number];

export type TranscriptMessage = AgentMessage & { entryId: string };

export interface TranscriptPage {
	messages: TranscriptMessage[];
	hasOlder: boolean;
}

export interface TranscriptPageOptions {
	before?: string;
	maxMessages: number;
	maxBytes: number;
}

function isDisplayed(message: AgentMessage): boolean {
	if (message.role === "system") return false;
	if (message.role === "custom") return message.display;
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A relay reset is a compaction whose details say which relay it was (`{ relay: { n, percent, note?, goal? } }`).
 * pi's summary message drops a compaction's details, so the page gets that mark back to draw a context reset.
 */
function relayMark(entry: SessionEntry): Record<string, unknown> | null {
	if (entry.type !== "compaction" || !isRecord(entry.details)) return null;
	const relay = entry.details.relay;
	return isRecord(relay) ? relay : null;
}

/** Raw session history for display: unlike the model projection, compaction never drops earlier entries. */
export function entryTranscriptMessages(entry: SessionEntry): TranscriptMessage[] {
	const relay = relayMark(entry);
	return sessionEntryToContextMessages(entry)
		.filter(isDisplayed)
		.map((message) => (relay && message.role === "compactionSummary" ? { ...message, details: { relay }, entryId: entry.id } : { ...message, entryId: entry.id }));
}

function hasDisplayedEntry(entries: readonly SessionEntry[]): boolean {
	return entries.some((entry) => entryTranscriptMessages(entry).length > 0);
}

export interface EntryLookup {
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
}

const ANNOUNCE_LOOKBACK_ENTRIES = 64;

function recentEntries(lookup: EntryLookup): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let entry = lookup.getLeafEntry();
	while (entry && entries.length < ANNOUNCE_LOOKBACK_ENTRIES) {
		entries.push(entry);
		entry = entry.parentId ? lookup.getEntry(entry.parentId) : undefined;
	}
	return entries;
}

function messageEntryMatcher(message: AgentMessage): (entry: SessionEntry) => boolean {
	if (message.role === "custom") {
		return (entry) => entry.type === "custom_message" && entry.customType === message.customType && entry.content === message.content;
	}
	return (entry) => entry.type === "message" && entry.message === message;
}

function announcedEntryMatcher(event: JsonAgentSessionEvent): ((entry: SessionEntry) => boolean) | null {
	switch (event.type) {
		case "entry_appended":
			return (entry) => entry.id === event.entry.id;
		case "message_end":
			return messageEntryMatcher(event.message);
		case "compaction_end": {
			const result = event.result;
			if (!result) return null;
			return (entry) => entry.type === "compaction" && entry.summary === result.summary && entry.tokensBefore === result.tokensBefore;
		}
		default:
			return null;
	}
}

/**
 * The session entry an event put on screen. pi persists a message right after emitting its
 * message_end, so this is only reliable once the emitting call stack has unwound.
 */
export function announcedEntryId(lookup: EntryLookup, event: JsonAgentSessionEvent): string | undefined {
	const matches = announcedEntryMatcher(event);
	return matches ? recentEntries(lookup).find(matches)?.id : undefined;
}

export interface TranscriptLimits {
	maxMessages: number;
	maxBytes: number;
}

/**
 * Messages after the `since` entry for a viewer that already rendered everything up to it, or null when the
 * cursor left the branch or the gap is larger than one page and a fresh page is cheaper.
 */
export function transcriptSince(entries: readonly SessionEntry[], since: string, limits: TranscriptLimits): TranscriptMessage[] | null {
	const start = entries.findIndex((entry) => entry.id === since);
	if (start < 0) return null;
	const messages = entries.slice(start + 1).flatMap(entryTranscriptMessages);
	if (messages.length > limits.maxMessages || JSON.stringify(messages).length > limits.maxBytes) return null;
	return messages;
}

export function transcriptPage(entries: readonly SessionEntry[], options: TranscriptPageOptions): TranscriptPage {
	const end = options.before === undefined ? entries.length : entries.findIndex((entry) => entry.id === options.before);
	if (end < 0) throw new Error("unknown_entry");

	const chunks: TranscriptMessage[][] = [];
	let count = 0;
	let bytes = 0;
	let index = end - 1;
	for (; index >= 0; index -= 1) {
		const messages = entryTranscriptMessages(entries[index]!);
		if (messages.length === 0) continue;
		const size = JSON.stringify(messages).length;
		if (count > 0 && (count + messages.length > options.maxMessages || bytes + size > options.maxBytes)) break;
		chunks.push(messages);
		count += messages.length;
		bytes += size;
	}

	return {
		messages: chunks.reverse().flat(),
		hasOlder: hasDisplayedEntry(entries.slice(0, index + 1)),
	};
}
