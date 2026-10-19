import { describe, expect, test } from "bun:test";
import {
	branchLabel,
	buildSessionMetrics,
	composerPlaceholder,
	elsewhereFooterNote,
	elsewherePlaceholder,
	elsewhereTilePill,
	footerLines,
	formatTokens,
	isWriting,
	roleBadge,
	workingLabel,
} from "../public/app/session/pane_format.js";

const state = {
	sessionId: "01a13e79-69dc-7292-83ad-302f96344ac8",
	cwd: "/Users/reddot/Desktop/cc/pi-web",
	model: { provider: "anthropic", id: "claude-opus-5-5" },
	thinkingLevel: "max",
	stats: { tokens: { input: 12_345, output: 1_500, cacheRead: 2_000_000, cacheWrite: 0 }, cost: 1.23456 },
	contextUsage: { contextWindow: 1_000_000, percent: 14.6 },
	autoCompactionEnabled: true,
};

describe("session pane text", () => {
	test("token counts and metrics", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1_500)).toBe("1.5k");
		expect(formatTokens(12_345)).toBe("12k");
		expect(formatTokens(2_000_000)).toBe("2.0M");
		expect(buildSessionMetrics(state)).toBe("↑12k ↓1.5k R2.0M $1.235 15%/1.0M (auto)");
		expect(buildSessionMetrics(null)).toBe("");
	});

	test("footer lines with and without a session", () => {
		expect(footerLines(null, { hostLabel: "mini", baseUrl: "https://mini.example" })).toEqual({ line1: "host: mini", left2: "—", right2: "https://mini.example" });
		expect(footerLines(null, { hostLabel: null, baseUrl: "http://127.0.0.1:4318" }).line1).toBe("—");
		expect(footerLines(state, { baseUrl: "x" })).toEqual({
			line1: "/Users/reddot/Desktop/cc/pi-web",
			left2: "↑12k ↓1.5k R2.0M $1.235 15%/1.0M (auto) • 01a13e79",
			right2: "anthropic/claude-opus-5-5 • max",
		});
		const untrusted = footerLines({ ...state, projectTrust: { gated: true, trusted: false }, model: null }, { baseUrl: "x" });
		expect(untrusted.line1).toBe("/Users/reddot/Desktop/cc/pi-web · project .pi resources skipped (untrusted)");
		expect(untrusted.right2).toBe("(no model) • max");
	});

	test("the footer names the git branch between the metrics and the session id, like pi's", () => {
		expect(footerLines({ ...state, gitBranch: "main" }, { baseUrl: "x" }).left2).toBe("↑12k ↓1.5k R2.0M $1.235 15%/1.0M (auto) • (main) • 01a13e79");
		expect(footerLines({ ...state, gitBranch: null }, { baseUrl: "x" }).left2).toBe("↑12k ↓1.5k R2.0M $1.235 15%/1.0M (auto) • 01a13e79");
		expect(footerLines({ sessionId: state.sessionId, gitBranch: "feat/x", stats: null }, { baseUrl: "x" }).left2).toBe("(feat/x) • 01a13e79");
		expect(branchLabel({ gitBranch: "  " })).toBeNull();
		expect(branchLabel(null)).toBeNull();
	});

	test("composer placeholder follows role, run state and device", () => {
		const base = { hasSession: true, compacting: false, isController: true, streaming: false, phone: false };
		expect(composerPlaceholder({ ...base, hasSession: false })).toBe("");
		expect(composerPlaceholder({ ...base, compacting: true })).toBe("Compacting context…");
		expect(composerPlaceholder({ ...base, isController: false })).toBe("Viewer mode — Take over to type");
		expect(composerPlaceholder({ ...base, phone: true })).toBe("Type a prompt (Enter steers, /queue waits)");
		expect(composerPlaceholder({ ...base, streaming: true })).toBe("Streaming… (Enter steers, /queue waits)");
		expect(composerPlaceholder(base)).toBe("Type a prompt (Enter to send, Shift+Enter for newline)");
	});

	test("role badge and working label", () => {
		expect(roleBadge("controller", "live", true)).toEqual({ text: "controller", kind: "controller" });
		expect(roleBadge("viewer", "reconnecting", true)).toEqual({ text: "reconnecting", kind: "offline" });
		expect(roleBadge("viewer", "gone", true)).toEqual({ text: "ended", kind: "offline" });
		expect(roleBadge("viewer", "gone", false)).toEqual({ text: "viewer", kind: "viewer" });
		expect(workingLabel({ kind: "working" })).toBe("Working...");
		expect(workingLabel({ kind: "compacting", reason: "threshold" })).toBe("Compacting context (threshold)...");
		expect(workingLabel({ kind: "compacting", reason: "manual" })).toBe("Compacting context...");
		expect(workingLabel({ kind: "retrying", attempt: 2, maxAttempts: 3 })).toBe("Retrying (2/3)...");
		expect(workingLabel({ kind: "elsewhere" })).toBe("Running elsewhere...");
	});

	test("a session another pi writes: footer note, placeholder and badge", () => {
		const lastWrite = "2026-10-15T10:00:00.000Z";
		const quietSince = new Date(lastWrite).toLocaleTimeString();
		expect(elsewhereFooterNote(null)).toBe("");
		expect(elsewhereFooterNote({ state: "running", writers: [41, 42] })).toBe(" · running elsewhere (pi 41, 42)");
		expect(elsewhereFooterNote({ state: "running", writers: null })).toBe(" · running elsewhere");
		expect(elsewhereFooterNote({ state: "quiet", lastWrite, writers: [41] })).toBe(` · elsewhere, quiet since ${quietSince} (pi 41)`);
		expect(elsewhereFooterNote({ state: "stopped", writers: [] })).toBe(" · stopped mid-turn, nobody is writing it");
		expect(elsewhereFooterNote({ state: "done", writers: [41] })).toBe(" · finished elsewhere, pi still open there (pi 41)");
		expect(elsewhereFooterNote({ state: "done", writers: [] })).toBe(" · finished elsewhere");
		expect(elsewhereFooterNote({ state: "hosted", writers: [] })).toBe("");
		expect(footerLines(state, { baseUrl: "x" }, { state: "running", writers: [41] }).line1).toBe("/Users/reddot/Desktop/cc/pi-web · running elsewhere (pi 41)");

		expect(elsewherePlaceholder(null)).toBe("Running elsewhere, read-only — Esc stops it");
		expect(elsewherePlaceholder({ state: "running" })).toBe("Running elsewhere, read-only — Esc stops it");
		expect(elsewherePlaceholder({ state: "quiet" })).toBe("No writes for a while — type or Take over to continue here");
		expect(elsewherePlaceholder({ state: "stopped" })).toBe("Stopped mid-turn — type to continue here");
		expect(elsewherePlaceholder({ state: "done" })).toBe("Finished elsewhere — type to continue here");

		expect(roleBadge("viewer", "live", true, { state: "running" })).toEqual({ text: "elsewhere", kind: "elsewhere" });
		expect(roleBadge("viewer", "live", true, { state: "quiet" })).toEqual({ text: "quiet", kind: "elsewhere" });
		expect(roleBadge("viewer", "live", true, { state: "done" })).toEqual({ text: "finished", kind: "elsewhere" });
		expect(roleBadge("viewer", "live", true, { state: "something new" })).toEqual({ text: "elsewhere", kind: "elsewhere" });
		expect(roleBadge("viewer", "reconnecting", true, { state: "running" })).toEqual({ text: "reconnecting", kind: "offline" });
	});

	test("a session pi-web only shows: the badge says read-only, the tile pill whether a pi still runs it", () => {
		expect(isWriting({ state: "running" })).toBe(true);
		expect(isWriting({ state: "quiet" })).toBe(true);
		expect(isWriting({ state: "stopped" })).toBe(false);
		expect(isWriting({ state: "done" })).toBe(false);
		expect(isWriting(null)).toBe(false);

		expect(roleBadge("viewer", "live", true, { state: "running" }, true)).toEqual({ text: "read-only", kind: "elsewhere" });
		expect(roleBadge("viewer", "live", true, { state: "done" }, true)).toEqual({ text: "read-only", kind: "elsewhere" });
		expect(roleBadge("viewer", "gone", true, { state: "done" }, true)).toEqual({ text: "ended", kind: "offline" });

		expect(elsewhereTilePill({ state: "running" }, true)).toEqual({ text: "read-only · running", kind: "working" });
		expect(elsewhereTilePill({ state: "quiet" }, true)).toEqual({ text: "read-only · running", kind: "idle" });
		expect(elsewhereTilePill({ state: "done" }, true)).toEqual({ text: "read-only", kind: "idle" });
		expect(elsewhereTilePill(null, true)).toEqual({ text: "read-only", kind: "idle" });
		expect(elsewhereTilePill({ state: "running" })).toEqual({ text: "elsewhere", kind: "working" });
		expect(elsewhereTilePill({ state: "done" })).toEqual({ text: "finished", kind: "idle" });
	});
});
