import { describe, expect, test } from "bun:test";
import {
	MAX_SCALE,
	MIN_SCALE,
	boundsOf,
	cameraCentering,
	cameraFitting,
	cameraRevealing,
	cameraTransform,
	clampScale,
	easeInOutCubic,
	interpolateCamera,
	isRectVisible,
	panBy,
	sanitizeCamera,
	screenToWorld,
	snapCamera,
	stepScale,
	visibleWorldRect,
	wheelPixels,
	wheelZoomFactor,
	worldRectToScreen,
	worldToScreen,
	zoomAt,
	zoomBy,
} from "../public/app/canvas/camera.js";

const viewport = { w: 1440, h: 900 };
const cameras = [
	{ x: 0, y: 0, scale: 1 },
	{ x: -320.5, y: 140.25, scale: 0.37 },
	{ x: 812, y: -1900, scale: 1.8 },
	{ x: 3, y: 7, scale: 0.2 },
];
const anchors = [
	{ x: 0, y: 0 },
	{ x: 720, y: 450 },
	{ x: 1439, y: 3 },
	{ x: 200.5, y: 777.25 },
];

const near = (a, b) => {
	expect(a.x).toBeCloseTo(b.x, 6);
	expect(a.y).toBeCloseTo(b.y, 6);
};

// Infinite's offsetForMagnifiedScale with its center-anchored scaleEffect: screen = center + (p - center) * s + offset.
function infiniteZoom({ offset, scale }, anchor, nextScale) {
	const ratio = nextScale / scale;
	const center = { x: viewport.w / 2, y: viewport.h / 2 };
	return { offset: { x: offset.x * ratio + (1 - ratio) * (anchor.x - center.x), y: offset.y * ratio + (1 - ratio) * (anchor.y - center.y) }, scale: nextScale };
}
const infiniteToScreen = ({ offset, scale }, p) => ({
	x: viewport.w / 2 + (p.x - viewport.w / 2) * scale + offset.x,
	y: viewport.h / 2 + (p.y - viewport.h / 2) * scale + offset.y,
});

describe("canvas camera", () => {
	test("world and screen coordinates round-trip", () => {
		for (const cam of cameras) {
			for (const p of anchors) near(worldToScreen(cam, screenToWorld(cam, p)), p);
		}
	});

	test("the point under the cursor stays fixed while zooming", () => {
		for (const cam of cameras) {
			for (const anchor of anchors) {
				for (const scale of [0.2, 0.5, 1, 1.25, 2]) {
					const before = screenToWorld(cam, anchor);
					const zoomed = zoomAt(cam, anchor, scale);
					expect(zoomed.scale).toBe(scale);
					near(screenToWorld(zoomed, anchor), before);
					near(worldToScreen(zoomed, before), anchor);
				}
			}
		}
	});

	test("matches Infinite's center-anchored offsetForMagnifiedScale", () => {
		const world = [
			{ x: 0, y: 0 },
			{ x: 500, y: 350 },
			{ x: -1200, y: 4000 },
		];
		for (const anchor of anchors) {
			const infinite = { offset: { x: 33, y: -71 }, scale: 0.8 };
			const cam = { x: (viewport.w / 2) * (1 - 0.8) + 33, y: (viewport.h / 2) * (1 - 0.8) - 71, scale: 0.8 };
			for (const p of world) near(worldToScreen(cam, p), infiniteToScreen(infinite, p));
			const theirs = infiniteZoom(infinite, anchor, 1.6);
			const ours = zoomAt(cam, anchor, 1.6);
			for (const p of world) near(worldToScreen(ours, p), infiniteToScreen(theirs, p));
		}
	});

	test("zoom is clamped to 20-200% and pinning at a limit doesn't drift the view", () => {
		expect(clampScale(5)).toBe(MAX_SCALE);
		expect(clampScale(0.01)).toBe(MIN_SCALE);
		expect(clampScale(Number.NaN)).toBe(1);
		const atMax = { x: 10, y: 20, scale: MAX_SCALE };
		expect(zoomAt(atMax, { x: 700, y: 400 }, 9)).toEqual(atMax);
		expect(zoomBy(atMax, { x: 700, y: 400 }, 1.5)).toEqual(atMax);
		const atMin = { x: 10, y: 20, scale: MIN_SCALE };
		expect(zoomBy(atMin, { x: 5, y: 5 }, 0.1)).toEqual(atMin);
	});

	test("hud steps land on round percentages", () => {
		expect(stepScale(1, 1)).toBe(1.1);
		expect(stepScale(1, -1)).toBe(0.9);
		expect(stepScale(1.1, 1)).toBe(1.2);
		expect(stepScale(0.25, 1)).toBe(0.3);
		expect(stepScale(0.25, -1)).toBe(0.2);
		expect(stepScale(0.2, -1)).toBe(MIN_SCALE);
		expect(stepScale(1.95, 1)).toBe(MAX_SCALE);
		expect(stepScale(2, 1)).toBe(MAX_SCALE);
		let scale = 1;
		for (let i = 0; i < 5; i += 1) scale = stepScale(scale, -1);
		expect(scale).toBe(0.5);
	});

	test("panning moves the translation only", () => {
		expect(panBy({ x: 1, y: 2, scale: 0.5 }, 10, -20)).toEqual({ x: 11, y: -18, scale: 0.5 });
	});

	test("the visible rect is the viewport plus 200 screen px of padding, in world units", () => {
		expect(visibleWorldRect({ x: 0, y: 0, scale: 1 }, viewport)).toEqual({ x: -200, y: -200, w: 1840, h: 1300 });
		expect(visibleWorldRect({ x: 100, y: -50, scale: 0.5 }, viewport, 0)).toEqual({ x: -200, y: 100, w: 2880, h: 1800 });
		const cam = { x: -1000, y: 0, scale: 0.5 };
		const left = visibleWorldRect(cam, viewport).x;
		expect(isRectVisible(cam, viewport, { x: left - 800, y: 0, w: 800, h: 500 })).toBe(false);
		expect(isRectVisible(cam, viewport, { x: left - 799, y: 0, w: 800, h: 500 })).toBe(true);
		expect(isRectVisible(cam, viewport, { x: left, y: 2199, w: 800, h: 500 })).toBe(true);
		expect(isRectVisible(cam, viewport, { x: left, y: 2200, w: 800, h: 500 })).toBe(false);
	});

	test("presented rects scale with the camera", () => {
		expect(worldRectToScreen({ x: 10, y: 20, scale: 0.5 }, { x: 100, y: 100, w: 800, h: 500 })).toEqual({ x: 60, y: 70, w: 400, h: 250 });
	});

	test("centering, fitting and revealing a tile", () => {
		const tile = { x: 1000, y: 600, w: 800, h: 500 };
		const centered = cameraCentering(viewport, tile, 1);
		near(worldToScreen(centered, { x: 1400, y: 850 }), { x: 720, y: 450 });

		const huge = { x: 0, y: 0, w: 8000, h: 5000 };
		expect(cameraFitting(viewport, huge).scale).toBeCloseTo((900 - 96) / 5000 > MIN_SCALE ? (900 - 96) / 5000 : MIN_SCALE, 6);
		expect(cameraFitting(viewport, { x: 0, y: 0, w: 100, h: 100 }).scale).toBe(1);
		expect(cameraFitting(viewport, { x: 0, y: 0, w: 100, h: 100 }, { maxScale: 2 }).scale).toBe(2);

		expect(cameraRevealing({ x: 0, y: 0, scale: 0.3 }, viewport, tile).scale).toBe(1);
		expect(cameraRevealing({ x: 0, y: 0, scale: 1.4 }, viewport, tile).scale).toBe(1.4);
		const tall = { x: 0, y: 0, w: 800, h: 1600 };
		expect(cameraRevealing({ x: 0, y: 0, scale: 1 }, viewport, tall).scale).toBeCloseTo((900 - 96) / 1600, 6);
	});

	test("bounds of tiles", () => {
		expect(boundsOf([])).toBeNull();
		expect(
			boundsOf([
				{ x: 0, y: 0, w: 800, h: 500 },
				{ x: 840, y: -100, w: 400, h: 300 },
			]),
		).toEqual({ x: 0, y: -100, w: 1240, h: 600 });
	});

	test("fly-to interpolation starts and ends on the cameras and zooms geometrically", () => {
		const from = { x: 0, y: 0, scale: 0.25 };
		const to = cameraCentering(viewport, { x: 3000, y: 2000, w: 800, h: 500 }, 1);
		expect(interpolateCamera(from, to, 0, viewport)).toEqual(from);
		const end = interpolateCamera(from, to, 1, viewport);
		near(end, to);
		expect(end.scale).toBeCloseTo(1, 9);
		expect(interpolateCamera(from, to, 0.5, viewport).scale).toBeCloseTo(0.5, 9);
		expect(easeInOutCubic(0)).toBe(0);
		expect(easeInOutCubic(1)).toBe(1);
		expect(easeInOutCubic(0.5)).toBe(0.5);
	});

	test("wheel deltas normalize to pixels and pinch deltas to zoom factors", () => {
		expect(wheelPixels({ deltaX: 1, deltaY: -2, deltaMode: 0 }, viewport)).toEqual({ x: 1, y: -2 });
		expect(wheelPixels({ deltaX: 1, deltaY: -2, deltaMode: 1 }, viewport)).toEqual({ x: 16, y: -32 });
		expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, viewport)).toEqual({ x: 0, y: 900 });
		expect(wheelZoomFactor(-5)).toBeGreaterThan(1);
		expect(wheelZoomFactor(5)).toBeLessThan(1);
		expect(wheelZoomFactor(7) * wheelZoomFactor(-7)).toBeCloseTo(1, 12);
		expect(wheelZoomFactor(1000)).toBe(wheelZoomFactor(50));
	});

	test("camera transform, device-pixel snapping and sanitizing stored cameras", () => {
		expect(cameraTransform({ x: 12.5, y: -3, scale: 0.75 })).toBe("translate3d(12.5px, -3px, 0) scale(0.75)");
		expect(snapCamera({ x: 10.3, y: -4.8, scale: 0.5 }, 2)).toEqual({ x: 10.5, y: -5, scale: 0.5 });
		expect(snapCamera({ x: 10.3, y: -4.8, scale: 0.5 }, 0)).toEqual({ x: 10, y: -5, scale: 0.5 });
		expect(sanitizeCamera(null)).toEqual({ x: 0, y: 0, scale: 1 });
		expect(sanitizeCamera({ x: "1", y: Number.POSITIVE_INFINITY, scale: 9 })).toEqual({ x: 0, y: 0, scale: MAX_SCALE });
		expect(sanitizeCamera({ x: 5, y: 6, scale: 0.5 })).toEqual({ x: 5, y: 6, scale: 0.5 });
	});
});
