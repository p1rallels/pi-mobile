import { describe, expect, test } from "bun:test";
import { renameKey } from "../public/app/canvas/tiles.js";
import { freshPayload, freshRecord, freshStatus, neverSavedOf, sessionTrustChoice } from "../public/app/session/fresh.js";
import { footerLines } from "../public/app/session/pane_format.js";

const httpError = (status, body) => Object.assign(new Error(body?.error ?? String(status)), { status, body });

describe("fresh panes", () => {
	test("only a 404 that says never saved counts, with the folder when the host could tell", () => {
		expect(neverSavedOf(httpError(404, { error: "Session not running", neverSaved: true, cwd: "/repo" }))).toEqual({ cwd: "/repo" });
		expect(neverSavedOf(httpError(404, { error: "Session not running", neverSaved: true, cwd: null }))).toEqual({ cwd: null });
		expect(neverSavedOf(httpError(404, { error: "Session not running" }))).toBeNull();
		expect(neverSavedOf(httpError(400, { error: "nope", neverSaved: true, cwd: "/repo" }))).toBeNull();
		expect(neverSavedOf(new Error("Failed to fetch"))).toBeNull();
		expect(neverSavedOf(null)).toBeNull();
	});

	test("keeps the folder, model, thinking level and a this-session-only trust answer of the session it stands in for", () => {
		const state = {
			sessionId: "01a1410a-old",
			cwd: "/repo",
			gitBranch: "main",
			model: { provider: "anthropic", id: "claude-opus-5-5", name: "Opus" },
			thinkingLevel: "max",
			projectTrust: { trusted: true, gated: true, source: "session" },
		};
		const record = freshRecord("/repo", state);
		expect(record).toEqual({ cwd: "/repo", model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "max", projectTrust: "trust_session", gitBranch: "main" });
		expect(freshPayload(record, "client-1")).toEqual({
			clientId: "client-1",
			cwd: "/repo",
			projectTrust: "trust_session",
			model: { provider: "anthropic", id: "claude-opus-5-5" },
			thinkingLevel: "max",
		});
		expect(freshRecord("/repo")).toEqual({ cwd: "/repo", model: null, thinkingLevel: null, projectTrust: null, gitBranch: null });
		expect(freshPayload(freshRecord("/repo"), "client-1")).toEqual({ clientId: "client-1", cwd: "/repo" });
	});

	test("trust decided for the folder or by the host is asked of the host again, not carried", () => {
		expect(sessionTrustChoice({ trusted: false, gated: true, source: "session" })).toBe("distrust_session");
		expect(sessionTrustChoice({ trusted: true, gated: true, source: "saved" })).toBeNull();
		expect(sessionTrustChoice({ trusted: true, gated: false, source: "no_resources" })).toBeNull();
		expect(sessionTrustChoice(null)).toBeNull();
	});

	test("the footer shows the folder and settings, and no session id until one starts", () => {
		const host = { hostLabel: null, baseUrl: "https://mini" };
		const lines = footerLines(freshStatus(freshRecord("/repo", { model: { provider: "anthropic", id: "opus" }, thinkingLevel: "high", gitBranch: "main" })), host);
		expect(lines).toEqual({ line1: "/repo", left2: "(main)", right2: "anthropic/opus • high" });
		expect(footerLines(freshStatus(freshRecord("/repo")), host)).toEqual({ line1: "/repo", left2: "", right2: "(no model) • —" });
	});
});

describe("re-keying a tile", () => {
	test("moves an entry to a new key in its place, and refuses a missing key or a taken one", () => {
		const map = new Map([
			["a", 1],
			["old", 2],
			["c", 3],
		]);
		expect(renameKey(map, "old", "new")).toBe(true);
		expect([...map.entries()]).toEqual([
			["a", 1],
			["new", 2],
			["c", 3],
		]);
		expect(renameKey(map, "gone", "x")).toBe(false);
		expect(renameKey(map, "a", "c")).toBe(false);
		expect([...map.keys()]).toEqual(["a", "new", "c"]);
	});
});
