import { describe, expect, test } from "bun:test";
import {
	MIN_TILE_H,
	MIN_TILE_W,
	TILE_GAP,
	TILE_H,
	TILE_W,
	gridSlot,
	gripRules,
	gripScaleFor,
	moveRect,
	nextFreeSlot,
	rectCenteredAt,
	resizeRect,
	sanitizeRect,
} from "../public/app/canvas/layout.js";
import { createLocalLayoutStore, loadCamera, parseLayout, saveCamera } from "../public/app/canvas/layout_store.js";

function memoryStorage() {
	const map = new Map();
	return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
}

describe("canvas layout", () => {
	test("grid slots are 3 columns of 800x500 tiles, 40px apart", () => {
		expect(gridSlot(0)).toEqual({ x: 0, y: 0, w: TILE_W, h: TILE_H });
		expect(gridSlot(2)).toEqual({ x: 2 * (TILE_W + TILE_GAP), y: 0, w: TILE_W, h: TILE_H });
		expect(gridSlot(3)).toEqual({ x: 0, y: TILE_H + TILE_GAP, w: TILE_W, h: TILE_H });
	});

	test("new tiles take the first free slot", () => {
		expect(nextFreeSlot([])).toEqual(gridSlot(0));
		expect(nextFreeSlot([gridSlot(0), gridSlot(1)])).toEqual(gridSlot(2));
		expect(nextFreeSlot([gridSlot(0), { x: 900, y: 20, w: 300, h: 300 }])).toEqual(gridSlot(2));
		expect(nextFreeSlot([{ x: 10, y: 10, w: 100, h: 100 }])).toEqual(gridSlot(1));
	});

	test("resizing clamps to the minimum and only moves the dragged edges", () => {
		const start = { x: 5, y: 6, w: 800, h: 500 };
		expect(resizeRect(start, { right: true, bottom: true }, -2000, -2000)).toEqual({ x: 5, y: 6, w: MIN_TILE_W, h: MIN_TILE_H });
		expect(resizeRect(start, { right: true, bottom: false }, 100.4, 999)).toEqual({ x: 5, y: 6, w: 900, h: 500 });
		expect(resizeRect(start, { right: false, bottom: true }, 999, -50)).toEqual({ x: 5, y: 6, w: 800, h: 450 });
		expect(moveRect(start, 10.6, -6)).toEqual({ x: 16, y: 0, w: 800, h: 500 });
		expect(rectCenteredAt({ x: 1000, y: 1000 })).toEqual({ x: 600, y: 750, w: TILE_W, h: TILE_H });
	});

	test("stored rects are sanitized", () => {
		expect(sanitizeRect({ x: "a", y: Number.NaN, w: 10, h: 1e9 })).toEqual({ x: 0, y: 0, w: MIN_TILE_W, h: 3000 });
		expect(sanitizeRect(null)).toEqual({ x: 0, y: 0, w: TILE_W, h: TILE_H });
	});

	test("layouts parse defensively and keep one tile per session", () => {
		const layout = parseLayout({
			tiles: [
				{ sessionId: "a", path: "/p/a.jsonl", title: "pi-web · a", x: 10, y: 20, w: 900, h: 600 },
				{ sessionId: "a", x: 99, y: 99 },
				{ sessionId: "", x: 1 },
				{ nope: true },
				{ sessionId: "b", x: 1.4, y: 2.6, w: 100, h: 100 },
			],
		});
		expect(layout.tiles).toEqual([
			{ sessionId: "a", path: "/p/a.jsonl", title: "pi-web · a", x: 10, y: 20, w: 900, h: 600 },
			{ sessionId: "b", path: null, title: null, x: 1, y: 3, w: MIN_TILE_W, h: MIN_TILE_H },
		]);
		expect(parseLayout("garbage")).toEqual({ tiles: [] });
	});

	test("the local store keeps one layout per host, and the camera per host", async () => {
		const storage = memoryStorage();
		const mini = createLocalLayoutStore(storage, "https://mini.example");
		const laptop = createLocalLayoutStore(storage, "http://127.0.0.1:4317");
		await mini.save({ tiles: [{ sessionId: "s1", path: null, title: null, x: 0, y: 0, w: 800, h: 500 }] });
		expect((await mini.load()).tiles.map((t) => t.sessionId)).toEqual(["s1"]);
		expect(await laptop.load()).toEqual({ tiles: [] });
		storage.setItem("pi-web.canvas.layout:http://127.0.0.1:4317", "{not json");
		expect(await laptop.load()).toEqual({ tiles: [] });

		expect(loadCamera(storage, "https://mini.example")).toBeNull();
		saveCamera(storage, "https://mini.example", { x: 1, y: 2, scale: 9 });
		expect(loadCamera(storage, "https://mini.example")).toEqual({ x: 1, y: 2, scale: 2 });
	});
});

describe("resize grips when zoomed out", () => {
	test("grow with the inverse zoom, in quarter steps, between 1x and 3x", () => {
		expect(gripScaleFor(2)).toBe(1);
		expect(gripScaleFor(1)).toBe(1);
		expect(gripScaleFor(0.6)).toBe(1.75);
		expect(gripScaleFor(0.5)).toBe(2);
		expect(gripScaleFor(0.2)).toBe(3);
		expect(gripScaleFor(Number.NaN)).toBe(1);
		expect(gripScaleFor(0)).toBe(1);
	});

	test("scale every grip's size and overhang", () => {
		const rules = gripRules(2);
		expect(rules).toContain(".cv-grip-e{width:20px;right:-10px}");
		expect(rules).toContain(".cv-grip-s{height:20px;bottom:-10px}");
		expect(rules).toContain(".cv-grip-se{width:36px;height:36px;right:-12px;bottom:-12px}");
	});
});
