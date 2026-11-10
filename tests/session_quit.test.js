import { describe, expect, test } from "bun:test";
import { notStoppedNotice, quitRefusal, STOPPED_ELSEWHERE } from "../public/app/session/quit.js";

describe("/quit and Release", () => {
	test("refuse while pi works, whether a turn or a compaction", () => {
		expect(quitRefusal({ isStreaming: true, isCompacting: false })).toBe("pi is still working. Esc stops it first");
		expect(quitRefusal({ isStreaming: false, isCompacting: true })).toBe("pi is still working. Esc stops it first");
	});

	test("stop an idle session, or a pane with no state yet", () => {
		expect(quitRefusal({ isStreaming: false, isCompacting: false })).toBeNull();
		expect(quitRefusal({})).toBeNull();
		expect(quitRefusal(null)).toBeNull();
		expect(quitRefusal(undefined)).toBeNull();
	});

	test("a refusal names what was asked: the typed /quit or the Release button", () => {
		expect(notStoppedNotice("command", "host said no")).toBe("Not quit: host said no");
		expect(notStoppedNotice("release", "pi is still working. Esc stops it first")).toBe("Not released: pi is still working. Esc stops it first");
	});

	test("a watching pane is told the session stopped and where it resumes", () => {
		expect(STOPPED_ELSEWHERE).toBe("This session was stopped elsewhere. It resumes from the list.");
	});
});
