import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_LAYOUT_MAX_TILES, createCanvasLayoutStore, parseCanvasLayout } from "../src/canvas-layout.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempPath(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-canvas-layout-"));
	dirs.push(dir);
	return join(dir, "pi-web", "canvas.json");
}

describe("canvas layout store", () => {
	test("parses defensively: one tile per session, clamped geometry, bounded strings", () => {
		const layout = parseCanvasLayout({
			tiles: [
				{ sessionId: "a", path: "/s/a.jsonl", title: "repo · a", x: 10.4, y: -20.6, w: 100, h: 99999 },
				{ sessionId: "a", x: 5 },
				{ sessionId: "", x: 1 },
				{ sessionId: "x".repeat(201) },
				"nope",
				{ sessionId: "b", path: 42, title: "t".repeat(500), x: Number.NaN, y: "1" },
			],
		});
		expect(layout.tiles).toEqual([
			{ sessionId: "a", path: "/s/a.jsonl", title: "repo · a", x: 10, y: -21, w: 320, h: 3000 },
			{ sessionId: "b", path: null, title: "t".repeat(200), x: 0, y: 0, w: 800, h: 500 },
		]);
		expect(parseCanvasLayout(null)).toEqual({ version: 1, tiles: [], updatedAt: null });
		const many = parseCanvasLayout({ tiles: Array.from({ length: CANVAS_LAYOUT_MAX_TILES + 20 }, (_, i) => ({ sessionId: `s${i}` })) });
		expect(many.tiles).toHaveLength(CANVAS_LAYOUT_MAX_TILES);
	});

	test("a missing file is an empty layout; saves are atomic, private and last-write-wins", async () => {
		const path = await tempPath();
		let clock = 0;
		const store = createCanvasLayoutStore(path, () => new Date(Date.UTC(2026, 9, 15, 3, 0, clock++)));
		expect(await store.load()).toEqual({ version: 1, tiles: [], updatedAt: null });

		const first = store.save({ tiles: [{ sessionId: "a", x: 1, y: 2, w: 800, h: 500 }] });
		const second = store.save({ tiles: [{ sessionId: "b", x: 3, y: 4, w: 900, h: 600 }] });
		await Promise.all([first, second]);
		const loaded = await store.load();
		expect(loaded.tiles.map((tile) => ("sessionId" in tile ? tile.sessionId : null))).toEqual(["b"]);
		expect(loaded.updatedAt).toBe("2026-10-15T03:00:01.000Z");
		expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);

		await writeFile(path, "{broken");
		await expect(store.load()).rejects.toThrow();
	});
});
