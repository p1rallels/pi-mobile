import { describe, expect, test } from "bun:test";
import { entryIdsInOrder, windowStart } from "../public/app/session/chat_view.js";

const node = (entryId) => ({ dataset: entryId ? { entryId } : {} });

describe("transcript window", () => {
	test("counts an assistant block and its tool boxes as one entry, and skips nodes without one", () => {
		const nodes = [node(null), node("u1"), node("a1"), node("a1"), node("a1"), node(null), node("u2"), node("a2")];
		expect(entryIdsInOrder(nodes)).toEqual(["u1", "a1", "u2", "a2"]);
	});

	test("keeps the newest entries", () => {
		const ids = ["u1", "a1", "u2", "a2", "u3", "a3"];
		expect(windowStart(ids, 2)).toBe("u3");
		expect(windowStart(ids, 5)).toBe("a1");
	});

	test("keeps everything when it fits or there is no window", () => {
		const ids = ["u1", "a1", "u2"];
		expect(windowStart(ids, 3)).toBeNull();
		expect(windowStart(ids, 10)).toBeNull();
		expect(windowStart(ids, Infinity)).toBeNull();
		expect(windowStart([], 0)).toBeNull();
	});

	test("never drops the newest entry", () => {
		expect(windowStart(["u1", "a1"], 0.5)).toBe("a1");
	});
});
