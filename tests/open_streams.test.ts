import { describe, expect, test } from "bun:test";
import {
	browserStreams,
	FAILED_RECHECK,
	recheckVerdict,
	terminalCloseFrame,
	withoutStream,
	withStream,
	type OpenStream,
	type OpenStreamKind,
	type OpenStreams,
	type StreamAdmission,
	type StreamCloseReason,
} from "../src/open-streams.ts";

const admission = (kind: OpenStreamKind, clientId: string | null, faceIdToken: string | null = "jti"): StreamAdmission => ({
	kind,
	clientId,
	device: "ab".repeat(32),
	faceIdToken,
});

const stream = (a: StreamAdmission): OpenStream => ({ admission: a, close: () => {}, recheck: async () => ({ deviceAllowed: true, faceIdAccepted: true }) });

const kinds = (streams: OpenStream[]) => streams.map((s) => `${s.admission.clientId}:${s.admission.kind}`);

describe("open streams registry", () => {
	test("adding and removing leave the map they were given alone", () => {
		const empty: OpenStreams<string> = new Map();
		const one = withStream(empty, "a", stream(admission("events", "c1")));
		const two = withStream(one, "b", stream(admission("terminal", "c1")));
		expect([empty.size, one.size, two.size]).toEqual([0, 1, 2]);
		const back = withoutStream(two, "a");
		expect([...back.keys()]).toEqual(["b"]);
		expect(two.size).toBe(2);
		expect(withoutStream(back, "missing")).toBe(back);
	});

	test("a logout picks every connection of its browser, a terminal lock only that browser's terminals", () => {
		let streams: OpenStreams<number> = new Map();
		const all: Array<[OpenStreamKind, string | null]> = [
			["events", "c1"],
			["follow", "c1"],
			["canvas_status", "c1"],
			["terminal", "c1"],
			["events", "c2"],
			["terminal", "c2"],
			["canvas_status", null],
		];
		all.forEach(([kind, clientId], i) => {
			streams = withStream(streams, i, stream(admission(kind, clientId)));
		});
		expect(kinds(browserStreams(streams, "c1", "logged_out"))).toEqual(["c1:events", "c1:follow", "c1:canvas_status", "c1:terminal"]);
		expect(kinds(browserStreams(streams, "c1", "terminals_locked"))).toEqual(["c1:terminal"]);
		expect(kinds(browserStreams(streams, "c3", "logged_out"))).toEqual([]);
	});
});

describe("sweep verdict", () => {
	const ok = { deviceAllowed: true, faceIdAccepted: true };

	test("a connection whose checks still pass stays", () => {
		expect(recheckVerdict(admission("events", "c1"), ok)).toBeNull();
	});

	test("a device the registry no longer allows closes it, whatever its Face ID token says", () => {
		expect(recheckVerdict(admission("terminal", "c1"), { ...ok, deviceAllowed: false })).toBe("device_not_allowed");
		expect(recheckVerdict(admission("events", null, null), { deviceAllowed: false, faceIdAccepted: false })).toBe("device_not_allowed");
	});

	test("a Face ID token that no longer resolves closes what rode on it; a connection that rode on none needs none", () => {
		expect(recheckVerdict(admission("follow", "c1"), { ...ok, faceIdAccepted: false })).toBe("faceid_ended");
		expect(recheckVerdict(admission("canvas_status", null, null), { ...ok, faceIdAccepted: false })).toBeNull();
	});

	test("a check that couldn't be made fails closed", () => {
		expect(recheckVerdict(admission("events", "c1"), FAILED_RECHECK)).toBe("device_not_allowed");
	});
});

describe("terminal close frames", () => {
	test("Face ID reasons close with 4401 like a lock, a device that's gone with 4403", () => {
		const reasons: StreamCloseReason[] = ["terminals_locked", "logged_out", "faceid_ended", "device_not_allowed"];
		expect(reasons.map((reason) => terminalCloseFrame(reason).code)).toEqual([4401, 4401, 4401, 4403]);
		expect(terminalCloseFrame("terminals_locked").reason).toBe("locked");
		// close reasons are capped at 123 bytes
		for (const reason of reasons) expect(Buffer.byteLength(terminalCloseFrame(reason).reason)).toBeLessThanOrEqual(123);
	});
});
