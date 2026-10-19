import { describe, expect, test } from "bun:test";
import { lineageDetails, lineageLine, partyOf, relayOf } from "../public/app/session/lineage.js";

const LEAD = "01a152a0-f00d-72aa-a896-d904c458282b";
const party = (id, label, state, openable = true, where = "pi -p · ~/repo") => ({ id, label, state, openable, where });

/** The line as plain text, segment by segment. */
const textOf = (view) => view?.segments.map((segment) => segment.parts.map((part) => part.text).join("")) ?? null;

describe("the header's lineage line", () => {
	test("whose child it is, by name or folder and short id, with where it runs when pi-web can't open it", () => {
		expect(textOf(lineageLine({ lineage: { parent: party(LEAD, "cc", "live"), children: [], childCount: 0 } }))).toEqual(["child of cc · 01a152a0"]);
		expect(textOf(lineageLine({ lineage: { parent: party(LEAD, "01a152a0", "ended", false, "pi · ~/x"), children: [], childCount: 0 } }))).toEqual([
			"child of 01a152a0 · ended · pi · ~/x",
		]);
		const link = lineageLine({ lineage: { parent: party(LEAD, "cc", "live"), children: [], childCount: 0 } })?.segments[0].parts[1];
		expect(link?.party?.openable).toBe(true);
	});

	test("its children with how each stands, the count covering the ones not listed", () => {
		const children = [party("a1", "died", "live"), party("b2", "flaky", "died", false), party("c3", "scout", "ended"), party("d4", "slow", "offline")];
		expect(textOf(lineageLine({ lineage: { parent: null, children, childCount: 6 } }))).toEqual(["6 children: died · flaky died · scout ended · slow offline · +2"]);
		expect(textOf(lineageLine({ lineage: { parent: null, children: children.slice(0, 1), childCount: 1 } }))).toEqual(["1 child: died"]);
	});

	test("relay: resets so far, the loop, a nudge that stands; nothing when relay has nothing to say", () => {
		expect(textOf(lineageLine({ relay: { resets: 2, loop: true, goal: "ship it", nudge: 44.96 } }))).toEqual(["relay · 2 resets · loop · nudged at 44.9%"]);
		expect(textOf(lineageLine({ relay: { resets: 1, loop: false, goal: null, nudge: null } }))).toEqual(["relay · 1 reset"]);
		expect(lineageLine({ relay: { resets: 0, loop: false, goal: null, nudge: null } })).toBeNull();
		expect(lineageLine({ relay: null, lineage: null })).toBeNull();
		expect(lineageLine(null)).toBeNull();
		expect(lineageLine({ relay: { resets: 2, loop: true, goal: "ship it", nudge: null } })?.segments[0].title).toContain("goal: ship it");
		expect(relayOf({ resets: 0, loop: true, goal: "" })?.goal).toBe("");
	});

	test("survives odd shapes, and keys change only with what's shown", () => {
		expect(partyOf({ id: "", label: "x" })).toBeNull();
		expect(partyOf({ id: LEAD, state: "zombie", openable: "yes" })).toEqual({ id: LEAD, label: "01a152a0", state: null, openable: false, where: null });
		const state = { lineage: { parent: null, children: [party("a1", "a", "live")], childCount: 1 }, relay: null, isStreaming: true };
		expect(lineageLine(state)?.key).toBe(lineageLine({ ...state, isStreaming: false })?.key);
		expect(lineageLine(state)?.key).not.toBe(lineageLine({ ...state, lineage: { ...state.lineage, children: [party("a1", "a", "died")] } })?.key);
	});
});

describe("the details a tap opens", () => {
	test("the parent, every child listed and how many more, relay with the loop's goal", () => {
		const sections = lineageDetails({
			lineage: { parent: party(LEAD, "cc", "live"), children: [party("01a15313-9bae", "died", "live"), party("b2", "flaky", "died", false, "pi -p · ~/f")], childCount: 3 },
			relay: { resets: 2, loop: true, goal: null, nudge: 45 },
		});
		expect(sections.map((section) => section.heading)).toEqual(["parent", "3 children", "relay"]);
		expect(sections[1].rows.map((row) => [row.primary, row.secondary])).toEqual([
			["died · 01a15313", "live · pi -p · ~/repo"],
			["flaky · b2 · died", "died · pi -p · ~/f · pi-web can't open it"],
			["+1 more", "not listed: the ones that ended longest ago go first"],
		]);
		expect(sections[2].rows.map((row) => row.primary)).toEqual(["2 resets of the context so far", "loop on", "nudged at 45%"]);
		expect(sections[2].rows[1].secondary).toBe("goal: the task in the session's first message");
	});
});
