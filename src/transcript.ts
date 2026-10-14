import { sessionEntryToContextMessages, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";

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

/** Raw session history for display: unlike the model projection, compaction never drops earlier entries. */
export function entryTranscriptMessages(entry: SessionEntry): TranscriptMessage[] {
	return sessionEntryToContextMessages(entry)
		.filter(isDisplayed)
		.map((message) => ({ ...message, entryId: entry.id }));
}

function hasDisplayedEntry(entries: readonly SessionEntry[]): boolean {
	return entries.some((entry) => entryTranscriptMessages(entry).length > 0);
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
