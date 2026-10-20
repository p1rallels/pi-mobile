import { describe, expect, test } from "bun:test";
import { lineageDetails, lineageLine, partyOf, partyTitle, relayOf, runningOf } from "../public/app/session/lineage.js";

const LEAD = "01a152a0-f00d-72aa-a896-d904c458282b";
const party = (id, label, state, openable = true, where = "pi -p · ~/repo", readOnly = false) => ({ id, label, state, openable, readOnly, where });

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
		expect(partyOf({ id: LEAD, state: "zombie", openable: "yes", readOnly: "yes" })).toEqual({ id: LEAD, label: "01a152a0", state: null, openable: false, readOnly: false, where: null, running: null });
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
			["flaky · b2", "died · pi -p · ~/f · pi-web can't open it"],
			["+1 more", "not listed: the ones that ended longest ago go first"],
		]);
		expect(sections[2].rows.map((row) => row.primary)).toEqual(["2 resets of the context so far", "loop on", "nudged at 45%"]);
		expect(sections[2].rows[1].secondary).toBe("goal: the task in the session's first message");
	});
});

describe("a child stuck in a long call", () => {
	const API = "01a15313-9bae-71f9-ad24-c0699b0485dc";
	const bash = { name: "bash", preview: "bun run e2e", minutes: 3 };
	const api = (running, state = "live") => ({ ...party(API, "api", state, true, "pi -p · ~/repo/.forks/1", true), running });
	const lineage = (...children) => ({ lineage: { parent: null, children, childCount: children.length } });

	test("the line: after its label, muted, the tool and whole minutes; nothing for a child with none, or one that isn't live", () => {
		const view = lineageLine(lineage(api(bash), party("b2", "web", "ended", false)));
		expect(textOf(view)).toEqual(["2 children: api bash 3m · web ended"]);
		expect(view?.segments[0].parts.find((part) => part.className === "lin-call")?.text).toBe(" bash 3m");
		// a call under a minute, which the host never sends, and one without a preview
		expect(textOf(lineageLine(lineage(api(null), party("b2", "web", "live"))))).toEqual(["2 children: api · web"]);
		expect(textOf(lineageLine(lineage(api({ name: "read", preview: null, minutes: 12 }))))).toEqual(["1 child: api read 12m"]);
		// past an hour, hours and the minutes left
		const after = (minutes) => textOf(lineageLine(lineage(api({ ...bash, minutes }))));
		expect([after(59), after(60), after(150), after(1_441)]).toEqual([["1 child: api bash 59m"], ["1 child: api bash 1h"], ["1 child: api bash 2h 30m"], ["1 child: api bash 24h 1m"]]);
		expect(lineageDetails(lineage(api({ ...bash, minutes: 150 })))[0].rows[0].secondary).toContain("bash: bun run e2e · 2h 30m · ");
		for (const state of ["ended", "died", "offline"]) expect(textOf(lineageLine(lineage(api(bash, state))))).toEqual([`1 child: api ${state}`]);
	});

	test("its hover text and its row in the details say what it runs, for how long, and where", () => {
		const [section] = lineageDetails(lineage(api(bash), api({ name: "read", preview: null, minutes: 1 })));
		expect(section.rows.map((row) => row.secondary)).toEqual([
			"live · bash: bun run e2e · 3m · pi -p · ~/repo/.forks/1 · opens read-only",
			"live · read · 1m · pi -p · ~/repo/.forks/1 · opens read-only",
		]);
		expect(section.rows[0].primary).toBe("api · 01a15313");
		// in pieces: the command and the rest after the minutes are the ones CSS cuts short
		const tail = { text: " · pi -p · ~/repo/.forks/1 · opens read-only", className: "lin-tail" };
		expect(section.rows[0].parts).toEqual([{ text: "live · bash: " }, { text: "bun run e2e", className: "lin-preview" }, { text: " · 3m", className: "lin-minutes" }, tail]);
		expect(section.rows[1].parts).toEqual([{ text: "live · read" }, { text: " · 1m", className: "lin-minutes" }, tail]);
		expect(lineageDetails(lineage(api(null)))[0].rows[0].parts).toEqual([{ text: "live · pi -p · ~/repo/.forks/1 · opens read-only" }]);
		// a long command is left whole: the row's CSS cuts it short
		const long = `bun run e2e -- ${"--grep lineage ".repeat(7)}`.trim();
		expect(lineageDetails(lineage(api({ ...bash, preview: long })))[0].rows[0].secondary).toContain(`bash: ${long} · 3m`);
		expect(partyTitle(partyOf(api(bash)))).toBe(`api · ${API} · live · bash: bun run e2e · 3m · pi -p · ~/repo/.forks/1 · click to open read-only`);
		expect(lineageLine(lineage(api(bash)))?.segments[0].title).toBe(partyTitle(partyOf(api(bash))));
		expect(partyTitle(partyOf(api(null)))).toBe(`api · ${API} · live · pi -p · ~/repo/.forks/1 · click to open read-only`);
	});

	test("junk is no call, and the line redraws when the minutes move", () => {
		expect(runningOf(bash)).toEqual(bash);
		expect(runningOf({ name: " bash ", preview: "  ", minutes: 2.7 })).toEqual({ name: "bash", preview: null, minutes: 2 });
		for (const junk of [null, "bash 3m", [bash], { ...bash, name: "" }, { ...bash, name: 7 }, { ...bash, minutes: 0 }, { ...bash, minutes: -3 }, { ...bash, minutes: "3" }, { ...bash, minutes: Number.NaN }]) {
			expect(runningOf(junk)).toBeNull();
			expect(partyOf(api(junk))?.running).toBeNull();
		}
		expect(partyOf(api(bash, "ended"))?.running).toBeNull();
		const key = (running) => lineageLine(lineage(api(running)))?.key;
		expect(key(bash)).toBe(key({ ...bash }));
		expect(key(bash)).not.toBe(key({ ...bash, minutes: 4 }));
		expect(key(bash)).not.toBe(key(null));
	});
});

describe("subs open read-only", () => {
	test("a link to a sub says it opens read-only, in its hover text and in the details", () => {
		const sub = party("c3", "scout", "ended", true, "pi -p · ~/repo/.forks/1", true);
		expect(partyOf(sub)?.readOnly).toBe(true);
		expect(partyTitle(partyOf(sub))).toBe("scout · c3 · ended · pi -p · ~/repo/.forks/1 · click to open read-only");
		// no link to click (a pane that opens nothing), but it would open read-only
		expect(partyTitle(partyOf(sub), false)).toBe("scout · c3 · ended · pi -p · ~/repo/.forks/1 · opens read-only");
		expect(partyTitle(partyOf(party(LEAD, "cc", "live")))).toBe(`cc · ${LEAD} · live · pi -p · ~/repo · click to open`);
		const [section] = lineageDetails({ lineage: { parent: null, children: [sub, party("b2", "flaky", "died", false, "pi -p · ~/f", true)], childCount: 2 } });
		expect(section.rows.map((row) => row.secondary)).toEqual(["ended · pi -p · ~/repo/.forks/1 · opens read-only", "died · pi -p · ~/f · pi-web can't open it"]);
	});

	test("whether it opens read-only is part of what the line shows", () => {
		const state = (readOnly) => ({ lineage: { parent: party(LEAD, "cc", "live", true, "pi · ~/x", readOnly), children: [], childCount: 0 } });
		expect(lineageLine(state(true))?.key).not.toBe(lineageLine(state(false))?.key);
	});
});
