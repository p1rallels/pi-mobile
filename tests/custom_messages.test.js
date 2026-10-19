import { describe, expect, test } from "bun:test";
import { entryMessage, msgKindLabel, msgView, partyLabel, percentLabel, relayResetView, relayView } from "../public/app/session/custom_messages.js";

const FROM = { id: "01a152d4-d2c3-751d-ab2f-1d14f1974871", name: "worker", cwd: "/repo/.forks/2" };

/** A msg message the way msg's extension sends it: content framed for the model, details = the Message. */
function msg(details, content = `<msg id="0mgqk3x2p-a1b2c3" from="worker">\n${details.text ?? ""}\n</msg>\nMessage from another agent session (not your user).`) {
	return { role: "custom", customType: "msg", content, display: true, details, timestamp: 1 };
}

describe("msg messages", () => {
	test("show the sender, what they answer and the text itself, not the model's framing", () => {
		const view = msgView(msg({ v: 1, id: "0mgqk3x2q-d4e5f6", ts: 1, from: FROM, to: "lead", text: "tests pass\n\n- one\n- two", delivery: "steer", replyTo: "0mgqk3x2p-a1b2c3" }));
		expect(view).toEqual({
			sender: { id: FROM.id, label: "worker", cwd: "/repo/.forks/2" },
			replyTo: "0mgqk3x2p-a1b2c3",
			kind: "",
			kindLabel: "",
			stopped: false,
			byUser: false,
			text: "tests pass\n\n- one\n- two",
		});
	});

	test("name an unnamed sender by the first 8 characters of its id", () => {
		expect(msgView(msg({ from: { id: FROM.id }, text: "hi" }))?.sender.label).toBe("01a152d4");
		expect(partyLabel({ id: "abc", name: "  " })).toBe("abc");
		expect(partyLabel(null)).toBe("");
	});

	test("tag a child that finished or died, and a message a person sent", () => {
		expect(msgView(msg({ from: FROM, text: "done: merged", kind: "ended" }))).toMatchObject({ kind: "ended", kindLabel: "finished" });
		expect(msgView(msg({ from: FROM, text: "the process vanished", kind: "died" }))).toMatchObject({ kind: "died", kindLabel: "died" });
		expect(msgView(msg({ from: FROM, text: "stop and commit", byUser: true }))).toMatchObject({ byUser: true, kindLabel: "" });
		expect(msgView(msg({ from: FROM, text: "x", kind: "paused" }))).toMatchObject({ kind: "paused", kindLabel: "paused" });
	});

	test("an ended sub that was cut short says stopped; old ended messages, without the mark, stay finished", () => {
		expect(msgView(msg({ from: FROM, text: "halfway: tests left", kind: "ended", stopped: true }))).toMatchObject({ kind: "ended", kindLabel: "stopped", stopped: true });
		expect(msgView(msg({ from: FROM, text: "done: merged", kind: "ended" }))).toMatchObject({ kindLabel: "finished", stopped: false });
		expect(msgView(msg({ from: FROM, text: "done: merged", kind: "ended", stopped: "true" }))).toMatchObject({ kindLabel: "finished", stopped: false });
		// only an ended can be stopped
		expect(msgView(msg({ from: FROM, text: "gone", kind: "died", stopped: true }))).toMatchObject({ kindLabel: "died", stopped: false });
		expect(msgView(msg({ from: FROM, text: "hi", stopped: true }))).toMatchObject({ kindLabel: "", stopped: false });
		expect(msgKindLabel("ended", true)).toBe("stopped");
		expect(msgKindLabel("ended", undefined)).toBe("finished");
		expect(msgKindLabel(" died ", false)).toBe("died");
		expect(msgKindLabel(undefined, true)).toBe("");
	});

	test("survive missing and odd fields", () => {
		expect(msgView(msg({ text: "orphan" }))?.sender).toEqual({ id: "", label: "another session", cwd: "" });
		expect(msgView(msg({ from: "worker", text: 42, byUser: "yes" }, "<msg id=\"x\">\nfrom the frame\n</msg>\nhint"))).toMatchObject({ text: "from the frame", byUser: false });
		expect(msgView({ role: "custom", customType: "msg", content: "plain words", display: true })?.text).toBe("plain words");
		expect(msgView(msg({ from: FROM, text: " " }, "<msg id=\"x\">\nsaid in the frame\n</msg>"))?.text).toBe("said in the frame");
		expect(msgView({ role: "custom", customType: "msg", content: [], display: true, details: {} })).toBeNull();
		expect(msgView(null)).toBeNull();
	});
});

describe("relay notices", () => {
	test("read as one line: relay, how full, and what it says", () => {
		const nudge = { role: "custom", customType: "relay", content: "41%: finish the step, commit, then call relay with a note", details: { kind: "nudge", percent: 41 } };
		expect(relayView(nudge)).toEqual({ label: "relay", meta: ["41%"], summary: "41%: finish the step, commit, then call relay with a note", full: "" });
	});

	test("drop relay's [relay] tag from the line, and floor the percent to a tenth like relay does", () => {
		const nudge = { role: "custom", customType: "relay", content: "[relay] you're at 44.9% of your context window. get to a clean checkpoint.", details: { kind: "nudge", percent: 44.96, step: 1 } };
		expect(relayView(nudge)).toMatchObject({ meta: ["44.9%"], summary: "you're at 44.9% of your context window. get to a clean checkpoint." });
		expect(percentLabel(45)).toBe("45%");
		expect(percentLabel(41.44)).toBe("41.4%");
	});

	test("a reset or nudge the human asked for says so, and a stopped loop says it stopped", () => {
		const asked = { role: "custom", customType: "relay", content: "[relay] context reset #3 (was at 30%), asked for by the human, in place", details: { kind: "reset", n: 3, percent: 30, byUser: true } };
		expect(relayView(asked)).toMatchObject({ label: "relay #3", meta: ["reset at 30%", "by you"], summary: "context reset #3 (was at 30%), asked for by the human, in place" });
		const stopped = { role: "custom", customType: "relay", content: "[relay loop] stopped: the human turned it off.", details: { kind: "loop", goal: "ship", stopped: "user" } };
		expect(relayView(stopped)).toMatchObject({ meta: ["loop stopped"], summary: "stopped: the human turned it off." });
	});

	test("a reset leads with its note and keeps the full text a tap away", () => {
		const reset = { role: "custom", customType: "relay", content: "context reset\n\nlookup catchup:\n…", details: { kind: "reset", n: 2, percent: 45, note: "tests pass, docs left" } };
		expect(relayView(reset)).toEqual({ label: "relay #2", meta: ["reset at 45%"], summary: "tests pass, docs left", full: "context reset\n\nlookup catchup:\n…" });
	});

	test("a loop prompt leads with its own words, else its goal", () => {
		const loop = { role: "custom", customType: "relay", content: [{ type: "text", text: "[relay loop] keep going toward the goal: ship relay." }], details: { kind: "loop", goal: "ship relay", errors: 0, idle: 0 } };
		expect(relayView(loop)).toMatchObject({ label: "relay", meta: ["loop"], summary: "keep going toward the goal: ship relay." });
		expect(relayView({ ...loop, content: [] })).toMatchObject({ summary: "ship relay", full: "" });
	});

	test("missing details still read, and an empty notice draws nothing", () => {
		expect(relayView({ role: "custom", customType: "relay", content: "just text" })).toEqual({ label: "relay", meta: [], summary: "just text", full: "" });
		expect(relayView({ role: "custom", customType: "relay", content: [], details: { percent: "lots" } })).toBeNull();
		expect(percentLabel(-1)).toBeNull();
		expect(percentLabel(Number.NaN)).toBeNull();
	});
});

describe("relay resets", () => {
	test("are a context reset with relay's number, how full it was and the note", () => {
		const summary = { role: "compactionSummary", summary: "fresh", tokensBefore: 90_000, details: { relay: { n: 3, percent: 50, note: "cut mid-step" } } };
		expect(relayResetView(summary)).toEqual({ title: "relay #3 · context reset at 50%", note: "cut mid-step", goal: "" });
		expect(relayResetView({ ...summary, details: { relay: {} } })).toEqual({ title: "relay · context reset", note: "", goal: "" });
	});

	test("any other compaction is not one", () => {
		expect(relayResetView({ role: "compactionSummary", summary: "s", tokensBefore: 1 })).toBeNull();
		expect(relayResetView({ role: "compactionSummary", details: { relay: "yes" } })).toBeNull();
	});
});

describe("appended entries", () => {
	const at = "2026-10-19T06:00:00.000Z";

	test("a displayed custom message becomes the message history would draw", () => {
		const entry = { type: "custom_message", id: "e1", parentId: "e0", timestamp: at, customType: "relay", content: "41%", display: true, details: { kind: "nudge" } };
		expect(entryMessage(entry)).toEqual({ role: "custom", customType: "relay", content: "41%", display: true, details: { kind: "nudge" }, timestamp: Date.parse(at), entryId: "e1" });
	});

	test("a compaction becomes its summary, with relay's mark and nothing else from its details", () => {
		const entry = { type: "compaction", id: "e2", parentId: "e1", timestamp: at, summary: "fresh", firstKeptEntryId: "e2", tokensBefore: 1200, fromHook: true, details: { relay: { n: 1 }, big: [1, 2, 3] } };
		expect(entryMessage(entry)).toEqual({ role: "compactionSummary", summary: "fresh", tokensBefore: 1200, timestamp: Date.parse(at), details: { relay: { n: 1 } }, entryId: "e2" });
		expect(entryMessage({ ...entry, details: undefined })).not.toHaveProperty("details");
	});

	test("entries that draw nothing, or arrive with message events, give nothing", () => {
		expect(entryMessage({ type: "custom_message", id: "e3", timestamp: at, customType: "x", content: "hidden", display: false })).toBeNull();
		expect(entryMessage({ type: "custom", id: "e4", timestamp: at, customType: "relay-state", data: {} })).toBeNull();
		expect(entryMessage({ type: "message", id: "e5", timestamp: at, message: { role: "user", content: "hi" } })).toBeNull();
		expect(entryMessage({ type: "custom_message", timestamp: at, display: true })).toBeNull();
		expect(entryMessage("nope")).toBeNull();
	});
});
