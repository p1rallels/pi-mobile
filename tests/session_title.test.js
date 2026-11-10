import { describe, expect, test } from "bun:test";
import { forkPlace, sessionTitle } from "../public/app/canvas/session_title.js";

describe("canvas tile titles", () => {
	test("a sub named like its fork says the fork's name once", () => {
		expect(sessionTitle({ id: "01a1c6dc", name: "fix-streams", forkLabel: "pi-web · fork 19-fix-streams" })).toBe("pi-web · fork 19-fix-streams");
		expect(sessionTitle({ id: "01a1c6dc", name: "19-fix-streams", forkLabel: "pi-web · fork 19-fix-streams" })).toBe("pi-web · fork 19-fix-streams");
	});

	test("a name that says something else stays", () => {
		expect(sessionTitle({ id: "01a1c6dc", name: "streams review", forkLabel: "pi-web · fork 19-fix-streams" })).toBe("pi-web · fork 19-fix-streams · streams review");
		expect(sessionTitle({ id: "01a1c6dc", name: "streams", forkLabel: "pi-web · fork 19-fix-streams" })).toBe("pi-web · fork 19-fix-streams · streams");
	});

	test("a fork the host didn't name, or no fork: the folder, then the name", () => {
		expect(sessionTitle({ id: "01a1c6dc", name: "fix-streams", cwd: "/Users/me/.pfs/forks/pi-web/19" })).toBe("pi-web · fork 19 · fix-streams");
		expect(sessionTitle({ id: "01a1c6dc", name: "3", forkLabel: "pi-web · fork 3" })).toBe("pi-web · fork 3 · 3");
		expect(sessionTitle({ id: "01a1c6dc", firstMessage: "fix the table\nmore", cwd: "/Users/me/code/pi-web" })).toBe("pi-web · fix the table");
		expect(sessionTitle({ id: "01a1c6dc9" })).toBe("01a1c6dc");
	});

	test("fork folders without a host label", () => {
		expect(forkPlace("/Users/me/.pfs/forks/pi-web/19/src")).toBe("pi-web · fork 19");
		expect(forkPlace("/Users/me/code/pi-web/.forks/2")).toBe("pi-web · fork 2");
		expect(forkPlace("/Users/me/code/pi-web")).toBeNull();
	});
});
