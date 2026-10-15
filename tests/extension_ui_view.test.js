import { describe, expect, test } from "bun:test";
import { formatStatuses } from "../public/app/ui/extension_ui.js";

describe("extension ui view", () => {
	test("joins non-empty statuses in key order", () => {
		expect(formatStatuses({ timer: "12s", op: "1P: ready", blank: "  " })).toBe("1P: ready · 12s");
		expect(formatStatuses(undefined)).toBe("");
	});
});
