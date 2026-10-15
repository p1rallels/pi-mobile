// The canvas engine (public/app/canvas) driven through the mock ui's fake panes: camera gestures,
// tile drag/resize, focus retention while panning. Chromium only: the canvas is a laptop view.
import { expect, test } from "@playwright/test";

const MOCK = process.env.MOCK_UI_URL ?? "http://127.0.0.1:4321";

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the canvas is laptop chrome only");
});

/** @param {import("@playwright/test").Page} page @param {string} [query] */
async function openMock(page, query = "tiles=6&streaming=0") {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${MOCK}/canvas.html?reset=1&fps=0&${query}`);
	await page.waitForFunction(() => Boolean(window.__canvasMock));
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** @param {import("@playwright/test").Page} page */
const camera = (page) => page.evaluate(() => window.__canvasMock.canvas.viewport.getCamera());
/** @param {import("@playwright/test").Page} page @param {string} id */
const tileRect = (page, id) => page.evaluate((tileId) => window.__canvasMock.canvas.tiles.get(tileId).rect, id);
/** @param {import("@playwright/test").Page} page */
const settle = (page) => page.waitForFunction(() => !window.__canvasMock.canvas.viewport.isGesturing());
/** @param {{ x: number, y: number, scale: number }} cam @param {{ x: number, y: number }} p */
const toScreen = (cam, p) => ({ x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y });
/** @param {{ x: number, y: number, scale: number }} cam @param {{ x: number, y: number }} p */
const toWorld = (cam, p) => ({ x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale });

// mock layout at the reset camera (x 40, y 64, 60%): tiles are 800x500 on a 3-column grid, so tile 0
// spans screen x 40-520, y 64-364, and everything below y 700 is empty canvas
const EMPTY = { x: 700, y: 800 };
const TILE0_TEXT = { x: 280, y: 220 };
const TILE0_BAR = { x: 300, y: 73 };
const TILE1_TEXT = { x: 780, y: 220 };

test("pinch zooms at the cursor and clamps to 20-200%", async ({ page }) => {
	await openMock(page);
	for (const point of [EMPTY, TILE0_TEXT]) {
		await page.mouse.move(point.x, point.y);
		const before = await camera(page);
		const anchor = toWorld(before, point);
		await page.keyboard.down("Control");
		await page.mouse.wheel(0, -30);
		await page.keyboard.up("Control");
		const after = await camera(page);
		expect(after.scale).toBeGreaterThan(before.scale);
		const moved = toScreen(after, anchor);
		expect(Math.abs(moved.x - point.x)).toBeLessThan(0.01);
		expect(Math.abs(moved.y - point.y)).toBeLessThan(0.01);
		await settle(page);
	}

	await page.keyboard.down("Control");
	for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, -100);
	expect((await camera(page)).scale).toBe(2);
	await expect(page.locator(".cv-hud-zoom")).toHaveText("200%");
	for (let i = 0; i < 80; i += 1) await page.mouse.wheel(0, 100);
	await page.keyboard.up("Control");
	expect((await camera(page)).scale).toBe(0.2);
	await expect(page.locator(".cv-hud-zoom")).toHaveText("20%");
});

test("hud buttons step the zoom and 1:1 resets it", async ({ page }) => {
	await openMock(page);
	await page.locator('.cv-hud-btn[data-act="in"]').click();
	await settle(page);
	expect((await camera(page)).scale).toBeCloseTo(0.7, 9);
	await page.locator('.cv-hud-btn[data-act="out"]').click();
	await page.locator('.cv-hud-btn[data-act="out"]').click();
	await settle(page);
	expect((await camera(page)).scale).toBeCloseTo(0.5, 9);
	await page.locator('.cv-hud-btn[data-act="reset"]').click();
	await settle(page);
	expect((await camera(page)).scale).toBe(1);
	await expect(page.locator(".cv-hud-zoom")).toHaveText("100%");
});

test("wheel pans empty canvas, cmd+wheel pans over tiles, plain wheel scrolls a transcript", async ({ page }) => {
	await openMock(page);
	const start = await camera(page);
	await page.mouse.move(EMPTY.x, EMPTY.y);
	await page.mouse.wheel(30, 50);
	expect(await camera(page)).toEqual({ x: start.x - 30, y: start.y - 50, scale: start.scale });
	await settle(page);

	const msgs = page.locator('.cv-tile[data-tile-id="mock-0"] .msgs');
	const scrollBefore = await msgs.evaluate((el) => el.scrollTop);
	const beforeCmd = await camera(page);
	await page.mouse.move(TILE0_TEXT.x, TILE0_TEXT.y);
	await page.keyboard.down("Meta");
	await page.mouse.wheel(0, 40);
	await page.keyboard.up("Meta");
	const afterCmd = await camera(page);
	expect(afterCmd.y).toBeCloseTo(beforeCmd.y - 40, 6);
	expect(await msgs.evaluate((el) => el.scrollTop)).toBe(scrollBefore);
	await settle(page);

	const beforeScroll = await camera(page);
	await page.mouse.move(TILE0_TEXT.x, TILE0_TEXT.y);
	await page.mouse.wheel(0, -200);
	await expect.poll(() => msgs.evaluate((el) => el.scrollTop)).toBeLessThan(scrollBefore);
	expect(await camera(page)).toEqual(beforeScroll);
});

test("dragging empty canvas pans, and cmd+drag pans over a tile without moving it", async ({ page }) => {
	await openMock(page);
	const start = await camera(page);
	await page.mouse.move(EMPTY.x, EMPTY.y);
	await page.mouse.down();
	await page.mouse.move(EMPTY.x + 100, EMPTY.y + 50, { steps: 4 });
	await page.mouse.up();
	const panned = await camera(page);
	expect(panned.x).toBeCloseTo(start.x + 100, 6);
	expect(panned.y).toBeCloseTo(start.y + 50, 6);
	await settle(page);

	const rect = await tileRect(page, "mock-0");
	const before = await camera(page);
	const over = toScreen(before, { x: rect.x + 300, y: rect.y + 200 });
	await page.keyboard.down("Meta");
	await page.mouse.move(over.x, over.y);
	await page.mouse.down();
	await page.mouse.move(over.x + 50, over.y + 30, { steps: 3 });
	await page.mouse.up();
	await page.keyboard.up("Meta");
	const after = await camera(page);
	expect(after.x - before.x).toBeCloseTo(50, 0);
	expect(after.y - before.y).toBeCloseTo(30, 0);
	expect(await tileRect(page, "mock-0")).toEqual(rect);
});

test("tiles move by the title bar and resize from the edges and corner, down to 320x220", async ({ page }) => {
	await openMock(page);
	const cam = await camera(page);
	const start = await tileRect(page, "mock-0");
	await page.mouse.move(TILE0_BAR.x, TILE0_BAR.y);
	await page.mouse.down();
	await page.mouse.move(TILE0_BAR.x + 60, TILE0_BAR.y + 30, { steps: 4 });
	await page.mouse.up();
	const moved = await tileRect(page, "mock-0");
	expect(moved).toEqual({ x: start.x + 100, y: start.y + 50, w: 800, h: 500 });
	expect(await camera(page)).toEqual(cam);
	await expect(page.locator('.cv-tile[data-tile-id="mock-0"]')).toHaveClass(/cv-focused/);

	const corner = toScreen(cam, { x: moved.x + moved.w - 2, y: moved.y + moved.h - 2 });
	await page.mouse.move(corner.x, corner.y);
	await page.mouse.down();
	await page.mouse.move(corner.x - 1000, corner.y - 1000, { steps: 5 });
	await page.mouse.up();
	expect(await tileRect(page, "mock-0")).toEqual({ x: moved.x, y: moved.y, w: 320, h: 220 });

	const edge = toScreen(cam, { x: moved.x + 320 + 1, y: moved.y + 110 });
	await page.mouse.move(edge.x, edge.y);
	await page.mouse.down();
	await page.mouse.move(edge.x + 60, edge.y + 40, { steps: 3 });
	await page.mouse.up();
	expect(await tileRect(page, "mock-0")).toEqual({ x: moved.x, y: moved.y, w: 420, h: 220 });

	const box = await page.locator('.cv-tile[data-tile-id="mock-0"]').boundingBox();
	expect(box?.width).toBeCloseTo(420 * cam.scale, 0);
});

test("a focused tile keeps the keyboard while panning and using the hud", async ({ page }) => {
	await openMock(page);
	await page.mouse.click(TILE1_TEXT.x, TILE1_TEXT.y);
	const input = page.locator('.cv-tile[data-tile-id="mock-1"] textarea');
	await expect(input).toBeFocused();
	await expect(page.locator('.cv-tile[data-tile-id="mock-1"]')).toHaveClass(/cv-focused/);
	await page.keyboard.type("hello");

	await page.mouse.move(EMPTY.x, EMPTY.y);
	await page.mouse.down();
	await page.mouse.move(EMPTY.x - 80, EMPTY.y - 40, { steps: 3 });
	await page.mouse.up();
	await expect(input).toBeFocused();

	await page.keyboard.down("Meta");
	await page.mouse.wheel(0, 60);
	await page.keyboard.up("Meta");
	await page.mouse.click(EMPTY.x, EMPTY.y);
	await page.locator('.cv-hud-btn[data-act="in"]').click();
	await expect(input).toBeFocused();
	await page.keyboard.type(" world");
	await expect(input).toHaveValue("hello world");

	const cam = await camera(page);
	const tile0 = await tileRect(page, "mock-0");
	const text0 = toScreen(cam, { x: tile0.x + 300, y: tile0.y + 150 });
	await page.mouse.click(text0.x, text0.y);
	await expect(page.locator('.cv-tile[data-tile-id="mock-0"] textarea')).toBeFocused();
	await expect(page.locator('.cv-tile[data-tile-id="mock-1"]')).not.toHaveClass(/cv-focused/);
});

test("esc aborts the focused tile's run", async ({ page }) => {
	await openMock(page, "tiles=3&streaming=1&rate=60");
	const pill = page.locator('.cv-tile[data-tile-id="mock-0"] .cv-pill');
	await expect(pill).toHaveText("working");
	await page.mouse.click(TILE0_TEXT.x, TILE0_TEXT.y);
	await page.keyboard.press("Escape");
	await expect(pill).toHaveText("idle");
	await expect(page.locator('.cv-tile[data-tile-id="mock-0"] .notice-text.error')).toHaveText("Operation aborted");
	await expect(page.locator('.cv-tile[data-tile-id="mock-1"] .cv-pill')).toHaveText("idle");
});

test("double-click on empty canvas, the hud's new tile and the red dot", async ({ page }) => {
	await openMock(page, "tiles=3&streaming=0");
	const cam = await camera(page);
	await page.mouse.dblclick(EMPTY.x, EMPTY.y);
	await expect(page.locator(".cv-tile")).toHaveCount(4);
	const placed = await tileRect(page, "mock-3");
	const center = toWorld(cam, EMPTY);
	expect(placed.x + placed.w / 2).toBeCloseTo(center.x, -1);
	expect(placed.y + placed.h / 2).toBeCloseTo(center.y, -1);
	await expect(page.locator('.cv-tile[data-tile-id="mock-3"] textarea')).toBeFocused();

	await page.locator('.cv-hud-btn[data-act="new"]').click();
	await expect(page.locator(".cv-tile")).toHaveCount(5);
	await settle(page);
	const fresh = await page.locator('.cv-tile[data-tile-id="mock-4"]').boundingBox();
	expect(fresh && fresh.x >= 0 && fresh.y >= 0 && fresh.x + fresh.width <= 1440 && fresh.y + fresh.height <= 900).toBe(true);

	await page.locator('.cv-tile[data-tile-id="mock-4"] .cv-close').click();
	await expect(page.locator(".cv-tile")).toHaveCount(4);
	expect(await page.evaluate(() => window.__canvasMock.paneCount())).toBe(4);
});

test("tiles outside the padded viewport skip rendering once the camera settles", async ({ page }, testInfo) => {
	await openMock(page, "tiles=12&streaming=4");
	await page.screenshot({ path: testInfo.outputPath("canvas-mock.png") });
	await testInfo.attach("canvas-mock", { path: testInfo.outputPath("canvas-mock.png"), contentType: "image/png" });
	await expect(page.locator(".cv-tile.cv-offscreen")).toHaveCount(0);
	await page.evaluate(() => window.__canvasMock.canvas.viewport.setCamera({ x: -100_000, y: 0, scale: 1 }));
	await expect(page.locator(".cv-tile.cv-offscreen")).toHaveCount(12);
	// at 100% only the top-left 2x2 tiles are within the viewport + 200px
	await page.evaluate(() => window.__canvasMock.canvas.viewport.setCamera({ x: 40, y: 64, scale: 1 }));
	await expect(page.locator(".cv-tile.cv-offscreen")).toHaveCount(8);
});
