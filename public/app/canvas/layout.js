// Tile geometry for the canvas view (Infinite's numbers: 800x500 tiles, 3 columns, 40px apart).
import { rectsIntersect } from "./camera.js";

export const TILE_W = 800;
export const TILE_H = 500;
export const MIN_TILE_W = 320;
export const MIN_TILE_H = 220;
export const MAX_TILE_W = 4000;
export const MAX_TILE_H = 3000;
export const TILE_GAP = 40;
export const GRID_COLUMNS = 3;
const MAX_GRID_SLOTS = 10_000;

/** @typedef {import("./camera.js").Rect} Rect */

/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** @param {unknown} n @param {number} fallback */
const finiteOr = (n, fallback) => (typeof n === "number" && Number.isFinite(n) ? n : fallback);

/**
 * A tile rect with a finite position and a size inside the allowed range, whatever was stored.
 * @param {unknown} value @returns {Rect}
 */
export function sanitizeRect(value) {
	const raw = /** @type {Partial<Rect> | null} */ (value && typeof value === "object" ? value : null);
	return {
		x: Math.round(finiteOr(raw?.x, 0)),
		y: Math.round(finiteOr(raw?.y, 0)),
		w: Math.round(clamp(finiteOr(raw?.w, TILE_W), MIN_TILE_W, MAX_TILE_W)),
		h: Math.round(clamp(finiteOr(raw?.h, TILE_H), MIN_TILE_H, MAX_TILE_H)),
	};
}

/** @param {number} index @returns {Rect} */
export function gridSlot(index) {
	const col = index % GRID_COLUMNS;
	const row = Math.floor(index / GRID_COLUMNS);
	return { x: col * (TILE_W + TILE_GAP), y: row * (TILE_H + TILE_GAP), w: TILE_W, h: TILE_H };
}

/** @param {Rect} a @param {Rect} b */
const overlapsWithGap = (a, b) => rectsIntersect({ x: a.x - TILE_GAP / 2, y: a.y - TILE_GAP / 2, w: a.w + TILE_GAP, h: a.h + TILE_GAP }, b);

/**
 * First grid slot (3 columns, row by row) that no existing tile overlaps.
 * @param {Rect[]} existing @returns {Rect}
 */
export function nextFreeSlot(existing) {
	for (let index = 0; index < MAX_GRID_SLOTS; index += 1) {
		const slot = gridSlot(index);
		if (!existing.some((rect) => overlapsWithGap(slot, rect))) return slot;
	}
	return gridSlot(existing.length);
}

/**
 * A default-size tile centered on a world point (double-click on empty canvas).
 * @param {{ x: number, y: number }} point @returns {Rect}
 */
export const rectCenteredAt = (point) => ({ x: Math.round(point.x - TILE_W / 2), y: Math.round(point.y - TILE_H / 2), w: TILE_W, h: TILE_H });

/**
 * Apply a resize drag (world-space deltas) on the right edge, bottom edge or corner.
 * @param {Rect} start @param {{ right: boolean, bottom: boolean }} edges @param {number} dx @param {number} dy @returns {Rect}
 */
export function resizeRect(start, edges, dx, dy) {
	return {
		x: start.x,
		y: start.y,
		w: edges.right ? Math.round(clamp(start.w + dx, MIN_TILE_W, MAX_TILE_W)) : start.w,
		h: edges.bottom ? Math.round(clamp(start.h + dy, MIN_TILE_H, MAX_TILE_H)) : start.h,
	};
}

/** @param {Rect} start @param {number} dx @param {number} dy @returns {Rect} */
export const moveRect = (start, dx, dy) => ({ x: Math.round(start.x + dx), y: Math.round(start.y + dy), w: start.w, h: start.h });
