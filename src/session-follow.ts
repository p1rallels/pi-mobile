import { parseSessionEntries, SessionManager, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { turnOfEntries, type Turn } from "./session-turn.ts";

/**
 * Reading a session another process is writing, without ever writing to it: pi-web parses the file itself
 * (SessionManager.open can rewrite old-format files) and then reads only the whole lines appended since.
 */

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

export interface FollowInfo {
	sessionName?: string;
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
}

export interface SessionSnapshot {
	sessionId: string;
	cwd: string;
	/** Root to leaf, the way pi would resume it. */
	branch: SessionEntry[];
	leafId: string | null;
	info: FollowInfo;
	turn: Turn;
	/** Bytes read so far: up to the end of the last complete line. */
	offset: number;
	mtimeMs: number;
}

export interface Appended {
	entries: SessionEntry[];
	offset: number;
	mtimeMs: number;
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
	return entry.type !== "session";
}

function completeLines(bytes: Uint8Array): { text: string; length: number } {
	const end = bytes.lastIndexOf(NEWLINE) + 1;
	return { text: end > 0 ? decoder.decode(bytes.subarray(0, end)) : "", length: end };
}

function messageModel(entry: SessionEntry): FollowInfo["model"] | undefined {
	if (entry.type === "model_change") return { provider: entry.provider, id: entry.modelId };
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
	const { provider, model } = entry.message as { provider?: unknown; model?: unknown };
	return typeof provider === "string" && typeof model === "string" ? { provider, id: model } : undefined;
}

/** Name, model and thinking level as the entries leave them, starting from what was known before. */
export function followInfo(entries: readonly SessionEntry[], start: FollowInfo = { model: null, thinkingLevel: null }): FollowInfo {
	return entries.reduce<FollowInfo>((info, entry) => {
		if (entry.type === "session_info") return { ...info, sessionName: entry.name?.trim() || undefined };
		if (entry.type === "thinking_level_change") return { ...info, thinkingLevel: entry.thinkingLevel };
		const model = messageModel(entry);
		return model ? { ...info, model } : info;
	}, start);
}

export async function readSessionSnapshot(path: string): Promise<SessionSnapshot> {
	const file = Bun.file(path);
	const [bytes, info] = await Promise.all([file.bytes(), stat(path)]);
	const { text, length } = completeLines(bytes);
	const fileEntries = parseSessionEntries(text);
	const header = fileEntries[0];
	if (!header || header.type !== "session") throw new Error("session_file_invalid");
	const manager = SessionManager.inMemory(header.cwd, undefined, fileEntries);
	const entries = fileEntries.filter(isSessionEntry);
	return {
		sessionId: header.id,
		cwd: header.cwd,
		branch: manager.getBranch(),
		leafId: manager.getLeafId(),
		info: followInfo(entries),
		turn: turnOfEntries(entries),
		offset: length,
		mtimeMs: info.mtimeMs,
	};
}

/** The whole entries appended after `offset`, or "rewritten" when the file shrank under it. */
export async function readAppended(path: string, offset: number): Promise<Appended | "rewritten"> {
	const info = await stat(path);
	if (info.size < offset) return "rewritten";
	if (info.size === offset) return { entries: [], offset, mtimeMs: info.mtimeMs };
	const bytes = await Bun.file(path).slice(offset, info.size).bytes();
	const { text, length } = completeLines(bytes);
	return { entries: parseSessionEntries(text).filter(isSessionEntry), offset: offset + length, mtimeMs: info.mtimeMs };
}
