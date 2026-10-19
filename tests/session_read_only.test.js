import { describe, expect, test } from "bun:test";
import { parentLabel, readOnlyNote, readOnlyOf, readOnlyOfError } from "../public/app/session/read_only.js";

const LEAD = "01a152a0-f00d-72aa-a896-d904c458282b";
const httpError = (status, body) => Object.assign(new Error(body?.error ?? String(status)), { status, body });

describe("sessions pi-web only shows", () => {
	test("the host's reason, checked: a sub names its parent, a gone folder says so, anything else loads", () => {
		expect(readOnlyOf({ reason: "sub", parent: LEAD })).toEqual({ reason: "sub", parent: LEAD });
		expect(readOnlyOf({ reason: "folder" })).toEqual({ reason: "folder" });
		expect(readOnlyOf({ reason: "sub" })).toEqual({ reason: "sub", parent: "" });
		expect(readOnlyOf({ reason: "elsewhere" })).toBeNull();
		expect(readOnlyOf("sub")).toBeNull();
		expect(readOnlyOf(null)).toBeNull();
		expect(readOnlyOf(undefined)).toBeNull();
	});

	test("only a 409 carrying the reason is a refusal to load it", () => {
		const refused = httpError(409, { error: "A sub opens read-only: its parent session manages it", readOnly: { reason: "sub", parent: LEAD } });
		expect(readOnlyOfError(refused)).toEqual({ reason: "sub", parent: LEAD });
		expect(readOnlyOfError(httpError(409, { error: "Its folder is gone, so it opens read-only", readOnly: { reason: "folder" } }))).toEqual({ reason: "folder" });
		// running elsewhere is another 409, and a 404 or a network error is no refusal
		expect(readOnlyOfError(httpError(409, { error: "running elsewhere", elsewhere: { state: "running" } }))).toBeNull();
		expect(readOnlyOfError(httpError(404, { error: "x", readOnly: { reason: "folder" } }))).toBeNull();
		expect(readOnlyOfError(new Error("Failed to fetch"))).toBeNull();
		expect(readOnlyOfError(null)).toBeNull();
	});

	test("a sub's note names its parent by the lineage's label, else its short id", () => {
		const sub = { reason: "sub", parent: LEAD };
		expect(parentLabel(sub, { lineage: { parent: { id: LEAD, label: "lead" } } })).toBe("lead");
		expect(parentLabel(sub, { lineage: { parent: { id: "someone-else", label: "other" } } })).toBe("01a152a0");
		expect(parentLabel(sub, null)).toBe("01a152a0");
		expect(parentLabel({ reason: "sub", parent: "" }, null)).toBeNull();
		expect(parentLabel({ reason: "folder" }, { lineage: { parent: { id: LEAD, label: "lead" } } })).toBeNull();
	});

	test("says why where the composer would be, and that Esc stops the pi running it while one does", () => {
		expect(readOnlyNote({ reason: "sub", parent: LEAD }, { parent: "lead" })).toBe("Read-only: lead manages this sub");
		expect(readOnlyNote({ reason: "sub", parent: LEAD }, { parent: "lead", writing: true })).toBe("Read-only: lead manages this sub · Esc stops it");
		expect(readOnlyNote({ reason: "sub", parent: "" })).toBe("Read-only: its parent manages this sub");
		expect(readOnlyNote({ reason: "folder" })).toBe("Read-only: its folder is gone");
		expect(readOnlyNote({ reason: "folder" }, { writing: true })).toBe("Read-only: its folder is gone · Esc stops it");
	});
});
