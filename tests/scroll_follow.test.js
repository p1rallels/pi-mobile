import { describe, expect, test } from "bun:test";
import { nextPinnedState } from "../public/app/session/scroll_follow.js";

describe("scroll follow", () => {
	test("re-pins whenever the reader reaches the bottom", () => {
		expect(nextPinnedState({ pinned: false, previousTop: 900, top: 800, remaining: 0 })).toBe(true);
	});

	test("unpins as soon as the reader scrolls up", () => {
		expect(nextPinnedState({ pinned: true, previousTop: 1000, top: 996, remaining: 4 })).toBe(false);
	});

	test("keeps the current state when content grows below the reader", () => {
		expect(nextPinnedState({ pinned: true, previousTop: 1000, top: 1000, remaining: 300 })).toBe(true);
		expect(nextPinnedState({ pinned: false, previousTop: 200, top: 200, remaining: 300 })).toBe(false);
	});

	test("scrolling down without reaching the bottom does not re-pin", () => {
		expect(nextPinnedState({ pinned: false, previousTop: 200, top: 400, remaining: 300 })).toBe(false);
	});
});
