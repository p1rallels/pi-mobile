import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { turnOfEntry, turnOfMessage, type Turn } from "./session-turn.ts";

/** What the session lists need from a session file, without the full-text index pi builds. */
export interface SessionSummary {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	/** Where the last user, assistant or tool result message left the conversation. */
	turn: Turn;
	/** The file's last modification, whoever wrote it. */
	lastWrite: string;
}

interface IndexedFile {
	summary: SessionSummary;
	size: number;
	mtimeMs: number;
	/** Byte offset just past the last complete line scanned. */
	offset: number;
	headerLine: string;
	/** Latest user/assistant message time, like pi's own session lists use for "modified". */
	lastActivityMs: number | null;
	turn: Turn;
}

/** The last assistant line of a scan, parsed once the scan is over: only its stop reason matters. */
interface ScanState {
	pendingAssistant: Uint8Array | Record<string, unknown> | null;
}

const CHUNK_BYTES = 1024 * 1024;
const PREFIX_BYTES = 512;
const FIRST_MESSAGE_CHARS = 280;
const NEWLINE = 0x0a;
const SCAN_CONCURRENCY = 8;

const MESSAGE_PREFIX = /^\{"type":"message","id":"[^"]*","parentId":(?:null|"[^"]*"),"timestamp":"([^"]+)","message":\{"role":"([a-zA-Z]+)"/;

const decoder = new TextDecoder();

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => Boolean(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}

function trimFirstMessage(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > FIRST_MESSAGE_CHARS ? `${collapsed.slice(0, FIRST_MESSAGE_CHARS - 1)}…` : collapsed;
}

function parseJson(line: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	const merged = new Uint8Array(a.length + b.length);
	merged.set(a);
	merged.set(b, a.length);
	return merged;
}

/** Calls onLine for every complete line in [start, end) and returns the offset after the last one. */
async function scanLines(path: string, start: number, end: number, onLine: (line: Uint8Array) => void): Promise<number> {
	const file = Bun.file(path);
	let carry: Uint8Array = new Uint8Array(0);
	let carryStart = start;
	let position = start;
	while (position < end) {
		const chunkEnd = Math.min(position + CHUNK_BYTES, end);
		const bytes = concatBytes(carry, new Uint8Array(await file.slice(position, chunkEnd).arrayBuffer()));
		position = chunkEnd;
		let lineStart = 0;
		for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, lineStart)) {
			if (index > lineStart) onLine(bytes.subarray(lineStart, index));
			lineStart = index + 1;
		}
		carryStart += lineStart;
		carry = bytes.subarray(lineStart);
	}
	return carryStart;
}

interface MessageLine {
	role: string;
	timestamp: string;
	entry: Record<string, unknown> | null;
}

function messageField(entry: Record<string, unknown>): Record<string, unknown> | null {
	return entry.message && typeof entry.message === "object" ? (entry.message as Record<string, unknown>) : null;
}

/** Current writers put type, id, parentId and timestamp first, so most lines are classified from a short prefix. */
function readMessageLine(prefix: string, line: Uint8Array): MessageLine | null {
	const fast = MESSAGE_PREFIX.exec(prefix);
	if (fast) return { role: fast[2] ?? "", timestamp: fast[1] ?? "", entry: null };
	if (!prefix.startsWith('{"type":"message"')) return null;
	const entry = parseJson(decoder.decode(line));
	const message = entry ? messageField(entry) : null;
	if (!entry || !message) return null;
	return { role: typeof message.role === "string" ? message.role : "", timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "", entry };
}

function trackTurn(file: IndexedFile, scan: ScanState, message: MessageLine, line: Uint8Array): void {
	if (message.role === "assistant") {
		scan.pendingAssistant = message.entry ?? line;
		return;
	}
	const turn = turnOfMessage(message.role, undefined);
	if (turn === null) return;
	file.turn = turn;
	scan.pendingAssistant = null;
}

function settleTurn(file: IndexedFile, scan: ScanState): void {
	const pending = scan.pendingAssistant;
	if (!pending) return;
	const entry = pending instanceof Uint8Array ? parseJson(decoder.decode(pending)) : pending;
	file.turn = turnOfEntry(entry) ?? file.turn;
	scan.pendingAssistant = null;
}

function applyLine(file: IndexedFile, scan: ScanState, line: Uint8Array): void {
	const prefix = decoder.decode(line.subarray(0, PREFIX_BYTES));
	const message = readMessageLine(prefix, line);
	if (message) {
		file.summary.messageCount += 1;
		trackTurn(file, scan, message, line);
		if (message.role !== "user" && message.role !== "assistant") return;
		const activity = Date.parse(message.timestamp);
		if (Number.isFinite(activity)) file.lastActivityMs = Math.max(file.lastActivityMs ?? 0, activity);
		if (message.role === "user" && !file.summary.firstMessage) {
			const entry = message.entry ?? parseJson(decoder.decode(line));
			const text = entry ? textOf(messageField(entry)?.content) : "";
			if (text.trim()) file.summary.firstMessage = trimFirstMessage(text);
		}
		return;
	}
	if (prefix.startsWith('{"type":"session_info"')) {
		const entry = parseJson(decoder.decode(line));
		const name = entry && typeof entry.name === "string" ? entry.name.trim() : "";
		file.summary.name = name || undefined;
	}
}

function headerOf(line: Uint8Array): { header: Record<string, unknown>; text: string } | null {
	const text = decoder.decode(line);
	const header = parseJson(text);
	if (!header || header.type !== "session" || typeof header.id !== "string") return null;
	return { header, text };
}

async function scanFromStart(path: string, size: number, mtimeMs: number): Promise<IndexedFile | null> {
	let file: IndexedFile | null = null;
	let invalid = false;
	const scan: ScanState = { pendingAssistant: null };
	const offset = await scanLines(path, 0, size, (line) => {
		if (invalid) return;
		if (!file) {
			const parsed = headerOf(line);
			if (!parsed) {
				invalid = true;
				return;
			}
			const created = typeof parsed.header.timestamp === "string" ? parsed.header.timestamp : new Date(mtimeMs).toISOString();
			file = {
				summary: {
					path,
					id: parsed.header.id as string,
					cwd: typeof parsed.header.cwd === "string" ? parsed.header.cwd : "",
					created,
					modified: created,
					messageCount: 0,
					firstMessage: "",
					turn: "done",
					lastWrite: new Date(mtimeMs).toISOString(),
				},
				size,
				mtimeMs,
				offset: 0,
				headerLine: parsed.text,
				lastActivityMs: null,
				turn: "done",
			};
			return;
		}
		applyLine(file, scan, line);
	});
	if (invalid || !file) return null;
	settleTurn(file, scan);
	return finish(file, offset, size, mtimeMs);
}

function finish(file: IndexedFile, offset: number, size: number, mtimeMs: number): IndexedFile {
	return {
		...file,
		offset,
		size,
		mtimeMs,
		summary: {
			...file.summary,
			modified: file.lastActivityMs === null ? file.summary.created : new Date(file.lastActivityMs).toISOString(),
			turn: file.turn,
			lastWrite: new Date(mtimeMs).toISOString(),
		},
	};
}

async function headerUnchanged(file: IndexedFile): Promise<boolean> {
	const headerBytes = new TextEncoder().encode(file.headerLine).length;
	const current = await Bun.file(file.summary.path).slice(0, headerBytes).text();
	return current === file.headerLine;
}

/** Session files are append-only, so growth only needs the new bytes scanned. */
async function refreshFile(previous: IndexedFile | undefined, path: string, size: number, mtimeMs: number): Promise<IndexedFile | null> {
	if (previous && previous.size === size && previous.mtimeMs === mtimeMs) return previous;
	if (previous && size >= previous.size && (await headerUnchanged(previous))) {
		const next: IndexedFile = { ...previous, summary: { ...previous.summary } };
		const scan: ScanState = { pendingAssistant: null };
		const offset = await scanLines(path, previous.offset, size, (line) => applyLine(next, scan, line));
		settleTurn(next, scan);
		return finish(next, offset, size, mtimeMs);
	}
	return scanFromStart(path, size, mtimeMs);
}

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await map(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

async function listJsonl(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
	} catch {
		return [];
	}
}

async function listSessionDirs(sessionsDir: string): Promise<string[]> {
	try {
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(sessionsDir, entry.name));
	} catch {
		return [];
	}
}

/** A folder pi sessions ran in, from the session files' headers. */
export interface SessionFolder {
	cwd: string;
	/** The newest session file's last write. */
	lastWriteMs: number;
	sessions: number;
}

const HEADER_BYTES = 16 * 1024;

/** The cwd a session file's header names; complete is false while the header line isn't written out yet. */
async function readHeaderCwd(path: string): Promise<{ cwd: string | null; complete: boolean }> {
	const head = new Uint8Array(await Bun.file(path).slice(0, HEADER_BYTES).arrayBuffer());
	const end = head.indexOf(NEWLINE);
	if (end === -1) return { cwd: null, complete: head.length >= HEADER_BYTES };
	const cwd = headerOf(head.subarray(0, end))?.header.cwd;
	return { cwd: typeof cwd === "string" && cwd ? cwd : null, complete: true };
}

/**
 * Which folders pi sessions ran in, newest first. Headers never change, so each file's is read once; every call stats the
 * files for their last write.
 */
export function createSessionFolders(sessionsDir: string) {
	const cwdByPath = new Map<string, string | null>();

	async function cwdOf(path: string): Promise<string | null> {
		const known = cwdByPath.get(path);
		if (known !== undefined) return known;
		const { cwd, complete } = await readHeaderCwd(path);
		if (complete) cwdByPath.set(path, cwd);
		return cwd;
	}

	async function list(): Promise<SessionFolder[]> {
		const paths = (await Promise.all((await listSessionDirs(sessionsDir)).map(listJsonl))).flat();
		const present = new Set(paths);
		for (const path of [...cwdByPath.keys()].filter((known) => !present.has(known))) cwdByPath.delete(path);
		const files = await mapLimited(paths, SCAN_CONCURRENCY, async (path) => {
			try {
				const [info, cwd] = await Promise.all([stat(path), cwdOf(path)]);
				return cwd ? { cwd, mtimeMs: info.mtimeMs } : null;
			} catch {
				return null;
			}
		});
		const folders = new Map<string, SessionFolder>();
		for (const file of files) {
			if (!file) continue;
			const seen = folders.get(file.cwd);
			folders.set(file.cwd, { cwd: file.cwd, lastWriteMs: Math.max(seen?.lastWriteMs ?? 0, file.mtimeMs), sessions: (seen?.sessions ?? 0) + 1 });
		}
		return [...folders.values()].sort((a, b) => b.lastWriteMs - a.lastWriteMs);
	}

	return { list };
}

export function sessionDirForCwd(sessionsDir: string, cwd: string): string {
	return join(sessionsDir, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

export function createSessionIndex(sessionsDir: string) {
	const files = new Map<string, IndexedFile>();

	async function refreshPaths(paths: readonly string[]): Promise<SessionSummary[]> {
		const refreshed = await mapLimited(paths, SCAN_CONCURRENCY, async (path) => {
			try {
				const info = await stat(path);
				const file = await refreshFile(files.get(path), path, info.size, info.mtimeMs);
				if (file) files.set(path, file);
				else files.delete(path);
				return file?.summary ?? null;
			} catch {
				files.delete(path);
				return null;
			}
		});
		return refreshed.filter((summary): summary is SessionSummary => summary !== null);
	}

	function forgetMissing(dirs: ReadonlySet<string> | null, present: ReadonlySet<string>): void {
		for (const path of files.keys()) {
			const inScope = dirs === null || [...dirs].some((dir) => path.startsWith(`${dir}/`));
			if (inScope && !present.has(path)) files.delete(path);
		}
	}

	async function list(options: { cwd?: string } = {}): Promise<SessionSummary[]> {
		const dirs = options.cwd ? [sessionDirForCwd(sessionsDir, options.cwd)] : await listSessionDirs(sessionsDir);
		const paths = (await Promise.all(dirs.map(listJsonl))).flat();
		const summaries = await refreshPaths(paths);
		forgetMissing(options.cwd ? new Set(dirs) : null, new Set(paths));
		const matching = options.cwd ? summaries.filter((summary) => summary.cwd === options.cwd) : summaries;
		return matching.sort((a, b) => b.modified.localeCompare(a.modified));
	}

	/** Summaries of just these files, for callers that already know which ones they need. */
	async function summarize(paths: readonly string[]): Promise<SessionSummary[]> {
		return refreshPaths([...new Set(paths)]);
	}

	return { list, summarize };
}
