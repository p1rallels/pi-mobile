import { describe, expect, test } from "bun:test";
import { freshWindowMs, isCheckFresh, verifiedAtFromStatus } from "../public/app/core/faceid.js";

const MINUTE = 60_000;

describe("face id guard decisions", () => {
	test("a check stays good for the shortest window the host enforces", () => {
		expect(freshWindowMs({ freshForSeconds: 900, commandFreshForSeconds: 3600, sessionForSeconds: 14_400 })).toBe(15 * MINUTE);
		expect(freshWindowMs({ freshForSeconds: 900, commandFreshForSeconds: 300, sessionForSeconds: 14_400 })).toBe(5 * MINUTE);
		expect(freshWindowMs({ freshForSeconds: "nope", commandFreshForSeconds: -1, sessionForSeconds: 600 })).toBe(10 * MINUTE);
	});

	test("a host that names no window gets asked on every return", () => {
		expect(freshWindowMs({})).toBe(0);
		expect(freshWindowMs(null)).toBe(0);
		expect(isCheckFresh(1_000, 0, 1_000)).toBe(false);
	});

	test("the host's check age is turned into a time on this browser's clock", () => {
		expect(verifiedAtFromStatus({ verifiedSecondsAgo: 120 }, 1_000_000)).toBe(880_000);
		expect(verifiedAtFromStatus({ verifiedSecondsAgo: 0 }, 1_000_000)).toBe(1_000_000);
		expect(verifiedAtFromStatus({ verifiedSecondsAgo: null }, 1_000_000)).toBeNull();
		expect(verifiedAtFromStatus({ verifiedSecondsAgo: -5 }, 1_000_000)).toBeNull();
		expect(verifiedAtFromStatus({ verifiedSecondsAgo: "120" }, 1_000_000)).toBeNull();
		expect(verifiedAtFromStatus({}, 1_000_000)).toBeNull();
	});

	test("fresh means younger than the window, and a clock that went backwards doesn't count", () => {
		const verifiedAt = 10 * MINUTE;
		expect(isCheckFresh(verifiedAt, 15 * MINUTE, verifiedAt + 14 * MINUTE)).toBe(true);
		expect(isCheckFresh(verifiedAt, 15 * MINUTE, verifiedAt + 15 * MINUTE)).toBe(false);
		expect(isCheckFresh(verifiedAt, 15 * MINUTE, verifiedAt - 1)).toBe(false);
		expect(isCheckFresh(null, 15 * MINUTE, verifiedAt)).toBe(false);
	});
});
