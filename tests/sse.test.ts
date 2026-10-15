import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveResumeCursor, sseEventFrame, ssePingFrame, sseRetryFrame } from "../src/sse.ts";
import { transcriptSince } from "../src/transcript.ts";

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return { type: "message", id, parentId, timestamp: "2026-10-15T00:00:00.000Z", message: { role: "user", content: text, timestamp: 1 } };
}

function modelChange(id: string, parentId: string): SessionEntry {
	return { type: "model_change", id, parentId, timestamp: "2026-10-15T00:00:00.000Z", provider: "p", modelId: "m" };
}

describe("sse frames", () => {
	test("frames events with an optional cursor id", () => {
		expect(sseEventFrame({ type: "controller_changed", controllerClientId: null })).toBe('data: {"type":"controller_changed","controllerClientId":null}\n\n');
		expect(sseEventFrame({ type: "controller_changed", controllerClientId: null }, "a1b2c3d4")).toStartWith("id: a1b2c3d4\ndata: ");
		expect(sseEventFrame({ type: "controller_changed", controllerClientId: null }, "bad\nid")).toStartWith("data: ");
	});

	test("sends pings as named events and sets the retry delay", () => {
		expect(ssePingFrame(42)).toBe("event: ping\ndata: 42\n\n");
		expect(sseRetryFrame(1500)).toBe("retry: 1500\n\n");
	});

	test("prefers the browser's Last-Event-ID over a stale ?since=", () => {
		expect(resolveResumeCursor("newer001", "older001")).toBe("newer001");
		expect(resolveResumeCursor(null, "older001")).toBe("older001");
		expect(resolveResumeCursor("", " older001 ")).toBe("older001");
		expect(resolveResumeCursor("../etc", null)).toBeUndefined();
		expect(resolveResumeCursor(null, null)).toBeUndefined();
	});
});

describe("transcript since a cursor", () => {
	const entries = [userEntry("u1", null, "one"), modelChange("m1", "u1"), userEntry("u2", "m1", "two"), userEntry("u3", "u2", "three")];
	const limits = { maxMessages: 10, maxBytes: 100_000 };

	test("returns only the displayed messages after the cursor", () => {
		expect(transcriptSince(entries, "u1", limits)?.map((message) => message.entryId)).toEqual(["u2", "u3"]);
		expect(transcriptSince(entries, "m1", limits)?.map((message) => message.entryId)).toEqual(["u2", "u3"]);
		expect(transcriptSince(entries, "u3", limits)).toEqual([]);
	});

	test("gives up when the cursor is off the branch or the gap is too large", () => {
		expect(transcriptSince(entries, "elsewhere", limits)).toBeNull();
		expect(transcriptSince(entries, "u1", { maxMessages: 1, maxBytes: 100_000 })).toBeNull();
		expect(transcriptSince(entries, "u1", { maxMessages: 10, maxBytes: 10 })).toBeNull();
	});
});
