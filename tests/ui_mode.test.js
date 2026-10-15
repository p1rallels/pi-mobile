import { describe, expect, test } from "bun:test";
import { canvasCapable, resolveUiMode } from "../public/app/core/ui_mode.js";

describe("ui mode", () => {
	test("the phone ui is the default and ?ui= switches and is remembered", () => {
		expect(resolveUiMode({ requested: null, stored: null, phone: false })).toEqual({ mode: "phone", remember: null });
		expect(resolveUiMode({ requested: "canvas", stored: null, phone: false })).toEqual({ mode: "canvas", remember: "canvas" });
		expect(resolveUiMode({ requested: null, stored: "canvas", phone: false })).toEqual({ mode: "canvas", remember: null });
		expect(resolveUiMode({ requested: "phone", stored: "canvas", phone: false })).toEqual({ mode: "phone", remember: "phone" });
		expect(resolveUiMode({ requested: "bogus", stored: "nonsense", phone: false })).toEqual({ mode: "phone", remember: null });
	});

	test("phones never get the canvas, whatever was asked or stored", () => {
		expect(resolveUiMode({ requested: "canvas", stored: "canvas", phone: true }).mode).toBe("phone");
		expect(resolveUiMode({ requested: null, stored: "canvas", phone: true }).mode).toBe("phone");
	});

	test("canvas detection wants a fine pointer and a short side of at least 700px", () => {
		expect(canvasCapable({ finePointer: true, shortSide: 900 })).toBe(true);
		expect(canvasCapable({ finePointer: true, shortSide: 700 })).toBe(true);
		expect(canvasCapable({ finePointer: true, shortSide: 699 })).toBe(false);
		expect(canvasCapable({ finePointer: false, shortSide: 1024 })).toBe(false);
	});
});
