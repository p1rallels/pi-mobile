import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { advanceRelay, NO_RELAY, relayStateOf, relayView, type BranchLookup } from "../src/relay-state.ts";

let seq = 0;
/** Entries the way relay writes them (relay-loop README, "What relay writes"), chained root to leaf. */
function chain(rows: readonly object[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const row of rows) {
		seq += 1;
		const parentId = entries.at(-1)?.id ?? null;
		entries.push({ id: `e${seq}`, parentId, timestamp: new Date(seq * 1000).toISOString(), ...row } as unknown as SessionEntry);
	}
	return entries;
}

const nudge = (percent: number, extra: Record<string, unknown> = {}) => ({
	type: "custom_message",
	customType: "relay",
	content: `[relay] you're at ${percent}% of your context window.`,
	display: true,
	details: { kind: "nudge", percent, step: Math.floor(percent / 5) * 5, ...extra },
});
const reset = (n: number, percent: number) => [
	{ type: "compaction", summary: `context reset #${n}`, firstKeptEntryId: "self", tokensBefore: 1, fromHook: true, details: { relay: { n, percent, note: "carry on" } } },
	{ type: "custom_message", customType: "relay", content: `[relay] context reset #${n}`, display: true, details: { kind: "reset", n, percent, note: "carry on" } },
];
const loop = (data: Record<string, unknown>) => ({ type: "custom", customType: "relay", data });
const relayResult = (outcome: string) => ({
	type: "message",
	message: { role: "toolResult", toolCallId: "c1", toolName: "relay", content: [{ type: "text", text: "ok" }], details: { outcome }, isError: false, timestamp: 1 },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });

describe("relay on a branch", () => {
	test("nothing to say until relay resets, loops or nudges", () => {
		expect(relayView(relayStateOf(chain([user("hi")])))).toBeNull();
		expect(relayView(NO_RELAY)).toBeNull();
	});

	test("counts resets the way relay does, and a nudge stands until the context shrinks", () => {
		const entries = chain([user("go"), nudge(41.2), ...reset(1, 45), nudge(40.9)]);
		expect(relayView(relayStateOf(entries))).toEqual({ resets: 1, loop: false, goal: null, nudge: 40.9 });
		expect(relayView(relayStateOf(chain([...entries, ...reset(3, 50)])))).toEqual({ resets: 3, loop: false, goal: null, nudge: null });
		// pi's own compaction isn't a reset, but the steps start over after it too
		const compacted = chain([nudge(60), { type: "compaction", summary: "pi's", firstKeptEntryId: "x", tokensBefore: 1 }]);
		expect(relayView(relayStateOf(compacted))).toBeNull();
		// the human's /relay asks for a note: not a nudge
		expect(relayView(relayStateOf(chain([nudge(44, { byUser: true })])))).toBeNull();
		// a mark without a number isn't one of relay's resets
		expect(relayStateOf(chain([{ type: "compaction", summary: "?", firstKeptEntryId: "x", tokensBefore: 1, details: { relay: { note: "?" } } }])).resets).toBe(0);
	});

	test("the loop, on with its goal until it's switched off, done or capped", () => {
		const on = chain([loop({ loop: "on", goal: "ship  the\nlineage pill", by: "user" })]);
		expect(relayView(relayStateOf(on))).toEqual({ resets: 0, loop: true, goal: "ship the lineage pill", nudge: null });
		expect(relayView(relayStateOf(chain([loop({ loop: "on", by: "launch" })])))).toEqual({ resets: 0, loop: true, goal: null, nudge: null });
		expect(relayStateOf(chain([loop({ loop: "on", goal: "a" }), loop({ loop: "off", reason: "user" })])).loop).toBe(false);
		expect(relayStateOf(chain([loop({ loop: "on", goal: "a" }), relayResult("done")])).loop).toBe(false);
		expect(relayStateOf(chain([loop({ loop: "on", goal: "a" }), relayResult("capped")])).loop).toBe(false);
		expect(relayStateOf(chain([loop({ loop: "on", goal: "a" }), relayResult("queued")])).loop).toBe(true);
		// on again without a goal: the one it had
		expect(relayStateOf(chain([loop({ loop: "on", goal: "a" }), loop({ loop: "off", reason: "aborted" }), loop({ loop: "on" })])).goal).toBe("a");
		expect(relayView(relayStateOf(chain([loop({ loop: "on", goal: "x".repeat(500) })])))?.goal).toHaveLength(400);
		// other extensions' entries and odd shapes change nothing
		expect(relayStateOf(chain([{ type: "custom", customType: "other", data: { loop: "on" } }, { type: "custom", customType: "relay", data: "on" }]))).toEqual(NO_RELAY);
	});
});

/** A session tree like pi's SessionManager: entries by id, a leaf, the branch from the root. */
function tree(entries: SessionEntry[]) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let leafId: string | null = entries.at(-1)?.id ?? null;
	let branchReads = 0;
	const lookup: BranchLookup = {
		getLeafId: () => leafId,
		getEntry: (id) => byId.get(id),
		getBranch: () => {
			branchReads += 1;
			const branch: SessionEntry[] = [];
			for (let entry = leafId ? byId.get(leafId) : undefined; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.unshift(entry);
			return branch;
		},
	};
	return {
		lookup,
		branchReads: () => branchReads,
		append(rows: readonly object[]) {
			for (const row of rows) {
				seq += 1;
				const entry = { id: `e${seq}`, parentId: leafId, timestamp: new Date(seq * 1000).toISOString(), ...row } as unknown as SessionEntry;
				byId.set(entry.id, entry);
				leafId = entry.id;
			}
		},
		moveLeaf(id: string) {
			leafId = id;
		},
	};
}

describe("following a hosted session's leaf", () => {
	test("folds only the new entries, and the whole branch again when the leaf moves to another one", () => {
		const session = tree(chain([user("go"), nudge(41)]));
		let fold = advanceRelay(null, session.lookup);
		expect(session.branchReads()).toBe(1);
		expect(fold.state.nudge).toBe(41);
		const fork = session.lookup.getLeafId() ?? "";

		session.append([...reset(1, 45), user("next")]);
		fold = advanceRelay(fold, session.lookup);
		expect(session.branchReads()).toBe(1);
		expect(relayView(fold.state)).toEqual({ resets: 1, loop: false, goal: null, nudge: null });
		expect(advanceRelay(fold, session.lookup)).toBe(fold);

		// /tree back to before the reset: that branch never reset
		session.moveLeaf(fork);
		fold = advanceRelay(fold, session.lookup);
		expect(session.branchReads()).toBe(2);
		expect(relayView(fold.state)).toEqual({ resets: 0, loop: false, goal: null, nudge: 41 });
	});
});
