import { describe, expect, test } from "bun:test";
import {
	addableDirectory,
	elsewhereBadge,
	filterDirEntries,
	isCreatableName,
	isListable,
	isPathQuery,
	matchesQuery,
	readListing,
	relativeTime,
	repoName,
	sessionLabel,
	splitPathQuery,
} from "../public/app/canvas/launcher.js";

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

	test("a typed path that isn't saved yet can be added; names and saved paths can't", () => {
		const repos = ["/Users/me/code/app", "/Users/me/code/lib"];
		expect(addableDirectory("/Users/me/code/new", repos)).toBe("/Users/me/code/new");
		expect(addableDirectory("  ~/code/new  ", repos)).toBe("~/code/new");
		expect(addableDirectory("~", repos)).toBe("~");
		expect(addableDirectory("/Users/me/code/app", repos)).toBeNull();
		expect(addableDirectory("/Users/me/code/app/", repos)).toBeNull();
		expect(addableDirectory("app", repos)).toBeNull();
		expect(addableDirectory("~app", repos)).toBeNull();
		expect(addableDirectory("", repos)).toBeNull();
	});

	test("a path query names a folder on the host; it lists through its last slash", () => {
		expect(isPathQuery("/Users")).toBe(true);
		expect(isPathQuery(" ~ ")).toBe(true);
		expect(isPathQuery("~/code")).toBe(true);
		expect(isPathQuery("~code")).toBe(false);
		expect(isPathQuery("pi-web")).toBe(false);
		expect(splitPathQuery("~/code/al")).toEqual({ prefix: "~/code/", leaf: "al" });
		expect(splitPathQuery("~/code/")).toEqual({ prefix: "~/code/", leaf: "" });
		expect(splitPathQuery("~")).toEqual({ prefix: "~/", leaf: "" });
		expect(splitPathQuery("/")).toEqual({ prefix: "/", leaf: "" });
		expect(isCreatableName("new-app")).toBe(true);
		for (const bad of ["", ".", "..", "a/b"]) expect(isCreatableName(bad)).toBe(false);
	});

	test("subfolders narrow by prefix in any case, hidden ones only after a dot", () => {
		const entries = [".git", "Alpha", "alps", "beta"].map((name) => ({ name, path: `/r/${name}` }));
		expect(filterDirEntries(entries, "al").map((entry) => entry.name)).toEqual(["Alpha", "alps"]);
		expect(filterDirEntries(entries, "").map((entry) => entry.name)).toEqual(["Alpha", "alps", "beta"]);
		expect(filterDirEntries(entries, ".").map((entry) => entry.name)).toEqual([".git"]);
	});

	test("a listing answers its own query exactly and narrows for more typing in the same folder", () => {
		const listing = {
			query: "~/code/a",
			path: "/me/code/a",
			exists: false,
			parent: "/me/code",
			parentExists: true,
			insideHome: true,
			canCreate: true,
			entries: [
				{ name: "alpha", path: "/me/code/alpha" },
				{ name: "alps", path: "/me/code/alps" },
			],
			truncated: false,
		};
		expect(readListing(listing, "~/code/a")).toEqual({ fresh: true, path: "/me/code/a", exists: false, canCreate: true, entries: listing.entries });
		expect(readListing(listing, "~/code/alpha")).toEqual({ fresh: false, path: "/me/code/alpha", exists: true, canCreate: false, entries: [listing.entries[0]] });
		expect(readListing(listing, "~/code/alx")).toEqual({ fresh: false, path: "/me/code/alx", exists: false, canCreate: true, entries: [] });
		expect(readListing(listing, "~/code/")).toMatchObject({ fresh: false, path: "/me/code", exists: true, canCreate: false });
		expect(readListing({ ...listing, insideHome: false, canCreate: false }, "~/code/alx")?.canCreate).toBe(false);
		expect(readListing(listing, "~/other/a")).toBeNull();
		expect(readListing(null, "~/code/a")).toBeNull();
	});
});
