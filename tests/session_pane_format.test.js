import { describe, expect, test } from "bun:test";
import { buildSessionMetrics, composerPlaceholder, footerLines, formatTokens, roleBadge, workingLabel } from "../public/app/session/pane_format.js";

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
	});
});
