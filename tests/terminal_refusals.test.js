import { describe, expect, test } from "bun:test";
import { attachRefusal, needsFaceId } from "../public/app/terminal/refusals.js";

/** An error the way api.js throws one for a refused request. @param {number} status @param {Record<string, unknown>} body */
function refused(status, body) {
	return Object.assign(new Error(typeof body.error === "string" ? body.error : String(status)), { status, body });
}

describe("a terminal tile's refused attach", () => {
	test("a device the host no longer allows ends the tile with the host's reason instead of retrying", () => {
		for (const error of ["Client certificate device has been revoked.", "Client certificate device has expired.", "Client certificate device is not allowed."]) {
			expect(attachRefusal(refused(403, { error }))).toEqual({ then: "end", note: error });
		}
	});

	test("a shell that ended while the tile wasn't watching ends it the same way; one the host never had opens anew", () => {
		expect(attachRefusal(refused(404, { error: "Terminal not running", ended: "expired" }))).toEqual({ then: "exit", reason: "expired" });
		expect(attachRefusal(refused(404, { error: "Terminal not running", ended: "exited" }))).toEqual({ then: "exit", reason: "exited" });
		expect(attachRefusal(refused(404, { error: "Terminal not running", ended: "shutdown" }))).toEqual({ then: "open" });
		expect(attachRefusal(refused(404, { error: "Terminal not running", ended: null }))).toEqual({ then: "open" });
	});

	test("a Face ID check or a lost browser session asks; anything else tries again", () => {
		const locked = refused(401, { error: "Terminals are locked: unlock them with Face ID.", terminalLocked: true });
		expect([attachRefusal(locked), needsFaceId(locked)]).toEqual([{ then: "refused" }, true]);
		const noSession = refused(401, { error: "Missing browser session. Reload the page." });
		expect([attachRefusal(noSession), needsFaceId(noSession)]).toEqual([{ then: "refused" }, false]);
		expect(attachRefusal(refused(502, { error: "Bad gateway" }))).toEqual({ then: "retry" });
		expect(attachRefusal(new TypeError("Failed to fetch"))).toEqual({ then: "retry" });
	});
});
