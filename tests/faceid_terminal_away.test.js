import { describe, expect, test } from "bun:test";
import { awayLocksTerminals } from "../public/app/core/faceid.js";

describe("what going away does to the terminals", () => {
	test("out of sight locks them, with or without a prompt or a dialog up", () => {
		for (const prompting of [false, true]) {
			for (const holdingFocus of [false, true]) {
				expect(awayLocksTerminals({ how: "hidden", prompting, holdingFocus })).toBe(true);
			}
		}
	});

	test("out of focus locks them, unless our prompt's sheet or a held dialog took it", () => {
		expect(awayLocksTerminals({ how: "blur", prompting: false, holdingFocus: false })).toBe(true);
		expect(awayLocksTerminals({ how: "blur", prompting: true, holdingFocus: false })).toBe(false);
		expect(awayLocksTerminals({ how: "blur", prompting: false, holdingFocus: true })).toBe(false);
		expect(awayLocksTerminals({ how: "blur", prompting: true, holdingFocus: true })).toBe(false);
	});
});
