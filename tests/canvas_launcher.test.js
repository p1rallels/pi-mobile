import { describe, expect, test } from "bun:test";
import { elsewhereBadge, isListable, matchesQuery, relativeTime, repoName, sessionLabel } from "../public/app/canvas/launcher.js";

describe("canvas launcher", () => {
	test("labels a session by name, else its first line, else its id", () => {
		expect(sessionLabel({ id: "01a13c00-aaaa", name: "  glow tuning ", firstMessage: "hi" })).toBe("glow tuning");
		expect(sessionLabel({ id: "01a13c00-aaaa", firstMessage: "fix the reconnect\nand more" })).toBe("fix the reconnect");
		expect(sessionLabel({ id: "01a13c00-aaaa", firstMessage: "(no messages)" })).toBe("01a13c00");
	});

	test("lists running, named or started sessions only", () => {
		expect(isListable({ id: "a", firstMessage: "(no messages)" })).toBe(false);
		expect(isListable({ id: "a", firstMessage: "(no messages)", isRunning: true })).toBe(true);
		expect(isListable({ id: "a", name: "named" })).toBe(true);
		expect(isListable({ id: "a", firstMessage: "hello" })).toBe(true);
		expect(isListable(/** @type {any} */ (null))).toBe(false);
		expect(isListable({ id: "a", cwd: "/r", path: null, firstMessage: "(no messages)", elsewhere: { state: "running" } })).toBe(true);
	});

	test("says what another pi is doing with a session this host doesn't run", () => {
		const base = { id: "a", cwd: "/r", path: null };
		expect(elsewhereBadge(base)).toBe("");
		expect(elsewhereBadge({ ...base, elsewhere: { state: "running" } })).toBe("running elsewhere");
		expect(elsewhereBadge({ ...base, elsewhere: { state: "quiet" } })).toBe("quiet elsewhere");
		expect(elsewhereBadge({ ...base, elsewhere: { state: "stopped" } })).toBe("stopped mid-turn");
		expect(elsewhereBadge({ ...base, isRunning: true, elsewhere: { state: "running" } })).toBe("");
	});

	test("matches every word of the filter, in any order and case", () => {
		expect(matchesQuery("", "anything")).toBe(true);
		expect(matchesQuery("WEB pi", "/Users/me/cc/pi-web")).toBe(true);
		expect(matchesQuery("pi mono", "/Users/me/cc/pi-web")).toBe(false);
	});

	test("names a directory by its last segment and dates sessions relative to now", () => {
		expect(repoName("/Users/me/cc/pi-web/")).toBe("pi-web");
		const now = Date.parse("2026-10-15T12:00:00.000Z");
		expect(relativeTime("2026-10-15T11:59:50.000Z", now)).toBe("just now");
		expect(relativeTime("2026-10-15T11:15:00.000Z", now)).toBe("45m ago");
		expect(relativeTime("2026-10-14T12:00:00.000Z", now)).toBe("24h ago");
		expect(relativeTime("2026-10-10T12:00:00.000Z", now)).toBe("5d ago");
		expect(relativeTime(undefined, now)).toBe("");
	});
});
