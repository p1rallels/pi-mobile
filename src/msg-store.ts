// msg's store on disk, as pi-web reads it: where it lives, which ids name a session, and what a presence record says.
// The store is msg's contract (github.com/p1rallels/msg: README "Store", src/core/paths.ts and registry.ts). pi-web only
// ever reads it and imports nothing from msg; msg-mail.ts (reopening for mail) and msg-lineage.ts (the header's
// lineage) both read it through here.
//
//   <root>/sessions/<session id>.json        presence: name, parent, cwd, pid, mode, activity, startedAt, heartbeatAt, endedAt, call
//   <root>/inbox/<session id>/new/<id>.json  mail nobody claimed yet (written to tmp/, renamed in)
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

export const PRESENCE_VERSION = 1;
/** msg's STALE_AFTER_MS: a presence record whose heartbeat is older than this is offline, whatever it claims. */
export const STALE_AFTER_MS = 45_000;
const MAX_NAME_LENGTH = 64;
/** msg's MAX_PREVIEW_LENGTH: the longest preview of a tool call's arguments a record carries. */
const MAX_PREVIEW_LENGTH = 120;

export type PresenceMode = "tui" | "rpc" | "json" | "print" | "web" | "cli";

const MODES: readonly PresenceMode[] = ["tui", "rpc", "json", "print", "web", "cli"];

/** A tool call a session runs (msg's Call): pi's tool call id, the tool's name, one line of its arguments, and when it started (epoch ms). */
export interface PresenceCall {
	id: string;
	name: string;
	/** bash's command, else the arguments as JSON, on one line of at most 120 characters */
	preview?: string;
	since: number;
}

export interface Presence {
	id: string;
	name?: string;
	/** The session whose bash started this one. */
	parent?: string;
	cwd: string;
	pid: number;
	mode: PresenceMode;
	activity: "idle" | "busy";
	startedAt: number;
	heartbeatAt: number;
	endedAt?: number;
	/** Its oldest running tool call that can stall it (not msg_send, not a nested call), while its run lasts; older msgs never write one. */
	call?: PresenceCall;
}

export type PidProbe = (pid: number) => boolean;

/** msg's ids (src/core/paths.ts): anything else names no session, and never becomes a path. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const isMsgId = (id: string): boolean => ID_PATTERN.test(id) && !id.includes("..");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const nonEmpty = (value: string | undefined): string | undefined => value?.trim() || undefined;

const expandHome = (path: string, home: string): string => {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
};

const normalizeName = (value: unknown): string | undefined => {
	const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	return name ? name.slice(0, MAX_NAME_LENGTH) : undefined;
};

/** Text as one line, at most MAX_PREVIEW_LENGTH characters (msg's clipPreview). */
const clipPreview = (text: string): string => {
	const line = text.replace(/\s+/g, " ").trim();
	const chars = [...line];
	return chars.length <= MAX_PREVIEW_LENGTH ? line : `${chars.slice(0, MAX_PREVIEW_LENGTH - 1).join("").trimEnd()}…`;
};

/** A record's running call the way msg reads one (message.ts parseCall): an id, a name and a start, all required. Junk is no call. */
export function parseCall(value: unknown): PresenceCall | undefined {
	if (!isRecord(value)) return undefined;
	const id = typeof value.id === "string" ? value.id : "";
	const name = normalizeName(value.name);
	const since = finite(value.since);
	if (!id || !name || since === undefined) return undefined;
	const preview = typeof value.preview === "string" ? clipPreview(value.preview) : "";
	return { id, name, ...(preview ? { preview } : {}), since };
}

/** Where msg keeps its store: $PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg; a leading ~ is home. */
export function msgStoreRoot(env: Env = process.env, home: string = homedir()): string {
	const configured = nonEmpty(env.PI_MSG_DIR);
	if (configured) return expandHome(configured, home);
	const agentDir = nonEmpty(env.PI_CODING_AGENT_DIR);
	return join(agentDir ? expandHome(agentDir, home) : join(home, ".pi", "agent"), "msg");
}

export const presencePath = (root: string, sessionId: string): string => join(root, "sessions", `${sessionId}.json`);

export const newMailDir = (root: string, sessionId: string): string => join(root, "inbox", sessionId, "new");

/** A presence record the way msg reads one (registry.ts parsePresence), or null when it isn't one. */
export function parsePresence(value: unknown): Presence | null {
	if (!isRecord(value) || value.v !== PRESENCE_VERSION) return null;
	const id = typeof value.id === "string" ? value.id : "";
	const pid = finite(value.pid);
	const startedAt = finite(value.startedAt);
	const heartbeatAt = finite(value.heartbeatAt);
	if (!isMsgId(id) || pid === undefined || startedAt === undefined || heartbeatAt === undefined) return null;
	const name = normalizeName(value.name);
	const parent = typeof value.parent === "string" && isMsgId(value.parent) && value.parent !== id ? value.parent : undefined;
	const endedAt = finite(value.endedAt);
	const call = parseCall(value.call);
	return {
		id,
		...(name ? { name } : {}),
		...(parent ? { parent } : {}),
		cwd: typeof value.cwd === "string" ? value.cwd : "",
		pid,
		mode: MODES.find((mode) => mode === value.mode) ?? "rpc",
		activity: value.activity === "busy" ? "busy" : "idle",
		startedAt,
		heartbeatAt,
		...(endedAt !== undefined ? { endedAt } : {}),
		...(call ? { call } : {}),
	};
}

/** `kill(pid, 0)` checks the process exists without signalling it; EPERM still means it does. */
export const pidAlive: PidProbe = (pid) => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
};
