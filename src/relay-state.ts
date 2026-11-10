// Where relay stands on a session's branch, for the header: resets so far, whether its keep-going loop is on (and the
// goal), and the percent of a nudge that still stands. Relay writes all of it on the branch (relay-loop,
// README "What relay writes") and folds its own state back from there; this folds the same entries the same way: its
// custom messages and entries (customType "relay"), its compactions (details.relay, read like the transcript reads a
// reset) and its tool's outcome.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { relayMark } from "./transcript.ts";
import type { ApiRelayState } from "./types.ts";

const CUSTOM_TYPE = "relay";
const TOOL_NAME = "relay";
/** relay clips the goal in its loop prompt to this many characters too */
const GOAL_CHARS = 400;
/** How far back an update walks from the leaf before folding the whole branch again. */
const MAX_WALK = 2_000;

export interface RelayState {
	/** relay compactions on the branch, counted the way relay counts them (each one's n, never fewer) */
	resets: number;
	loop: boolean;
	/** the goal the loop was last switched on with; undefined: the session's first message */
	goal: string | undefined;
	/** the last nudge's percent since the context last shrank (any compaction starts relay's steps over) */
	nudge: number | undefined;
}

export const NO_RELAY: RelayState = { resets: 0, loop: false, goal: undefined, nudge: undefined };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const goalOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** The loop switch, a custom entry: `{ loop: "on", goal?, by }` or `{ loop: "off", reason }`. */
function switched(state: RelayState, data: unknown): RelayState {
	if (!isRecord(data)) return state;
	if (data.loop === "on") return { ...state, loop: true, goal: goalOf(data.goal) ?? state.goal };
	if (data.loop === "off") return { ...state, loop: false };
	return state;
}

/** A relay message: only the agent's nudges move the state here (a nudge byUser is the human's /relay asking for a note). */
function noticed(state: RelayState, details: unknown): RelayState {
	if (!isRecord(details) || details.kind !== "nudge" || details.byUser === true) return state;
	const percent = finite(details.percent) ?? finite(details.step);
	return percent === undefined ? state : { ...state, nudge: percent };
}

/** The relay tool's result: `done` and `capped` end the loop. */
function answered(state: RelayState, message: unknown): RelayState {
	if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== TOOL_NAME || !isRecord(message.details)) return state;
	const { outcome } = message.details;
	return outcome === "done" || outcome === "capped" ? { ...state, loop: false } : state;
}

/** One entry's effect on what the header shows of relay. */
export function reduceRelay(state: RelayState, entry: SessionEntry): RelayState {
	switch (entry.type) {
		case "compaction": {
			const n = finite(relayMark(entry)?.n);
			return { ...state, resets: n === undefined ? state.resets : Math.max(state.resets + 1, n), nudge: undefined };
		}
		case "custom":
			return entry.customType === CUSTOM_TYPE ? switched(state, entry.data) : state;
		case "custom_message":
			return entry.customType === CUSTOM_TYPE ? noticed(state, entry.details) : state;
		case "message":
			return answered(state, entry.message);
		default:
			return state;
	}
}

/** Entries folded root to leaf, from `start`. */
export function relayStateOf(entries: readonly SessionEntry[], start: RelayState = NO_RELAY): RelayState {
	return entries.reduce(reduceRelay, start);
}

/** What the header needs of a hosted session's tree (pi's SessionManager). */
export interface BranchLookup {
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
	getBranch(): SessionEntry[];
}

/** The relay state at a leaf, so the next update folds only the entries after it. */
export interface RelayFold {
	leafId: string | null;
	state: RelayState;
}

/**
 * The relay state at the session's current leaf: from `fold`, the entries between its leaf and the current one (walked
 * back through their parents); the whole branch when there's no fold yet or the leaf moved to another branch.
 */
export function advanceRelay(fold: RelayFold | null, lookup: BranchLookup): RelayFold {
	const leafId = lookup.getLeafId();
	if (fold && fold.leafId === leafId) return fold;
	if (fold?.leafId) {
		const fresh: SessionEntry[] = [];
		let entry = leafId ? lookup.getEntry(leafId) : undefined;
		while (entry && entry.id !== fold.leafId && fresh.length < MAX_WALK) {
			fresh.push(entry);
			entry = entry.parentId ? lookup.getEntry(entry.parentId) : undefined;
		}
		if (entry?.id === fold.leafId) return { leafId, state: relayStateOf(fresh.reverse(), fold.state) };
	}
	return { leafId, state: relayStateOf(lookup.getBranch()) };
}

const clip = (text: string, max: number): string => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** What goes on the wire: null until relay reset the context, runs its loop or has a nudge standing. */
export function relayView(state: RelayState): ApiRelayState | null {
	if (state.resets === 0 && !state.loop && state.nudge === undefined) return null;
	return {
		resets: state.resets,
		loop: state.loop,
		goal: state.loop && state.goal !== undefined ? clip(state.goal, GOAL_CHARS) : null,
		nudge: state.nudge ?? null,
	};
}
