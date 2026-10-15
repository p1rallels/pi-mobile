// Camera math for the canvas view, ported from Infinite's InfiniteCanvasView (offsetForMagnifiedScale,
// presentedRect). A camera is { x, y, scale } and maps world to screen as p * scale + (x, y), which is
// exactly `transform: translate3d(x, y, 0) scale(scale)` with `transform-origin: 0 0` on the world layer.
// Zoom is a camera operation only: tiles keep their logical size and never reflow.

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 2;
export const VISIBILITY_PADDING = 200;
export const ZOOM_STEP = 0.1;
const WHEEL_ZOOM_SPEED = 0.01;
const WHEEL_ZOOM_MAX_DELTA = 50;
const LINE_HEIGHT_PX = 16;

/** @typedef {{ x: number, y: number, scale: number }} Camera */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ w: number, h: number }} Size */

/** @type {Camera} */
export const IDENTITY = Object.freeze({ x: 0, y: 0, scale: 1 });

/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** @param {number} scale */
export const clampScale = (scale) => clamp(Number.isFinite(scale) ? scale : 1, MIN_SCALE, MAX_SCALE);

/** @param {unknown} value @returns {Camera} */
export function sanitizeCamera(value) {
	const raw = /** @type {Partial<Camera> | null} */ (value && typeof value === "object" ? value : null);
	const finite = (/** @type {unknown} */ n) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
	return { x: finite(raw?.x), y: finite(raw?.y), scale: clampScale(typeof raw?.scale === "number" ? raw.scale : 1) };
}

/** @param {Camera} cam @param {Point} p @returns {Point} */
export const worldToScreen = (cam, p) => ({ x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y });

/** @param {Camera} cam @param {Point} p @returns {Point} */
export const screenToWorld = (cam, p) => ({ x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale });

/** @param {Camera} cam @param {number} dx @param {number} dy @returns {Camera} */
export const panBy = (cam, dx, dy) => ({ x: cam.x + dx, y: cam.y + dy, scale: cam.scale });

/**
 * Zoom to `scale` keeping the screen point `anchor` fixed: t' = c - (c - t) * (s' / s).
 * @param {Camera} cam @param {Point} anchor @param {number} scale @returns {Camera}
 */
export function zoomAt(cam, anchor, scale) {
	const next = clampScale(scale);
	const ratio = next / cam.scale;
	return { x: anchor.x - (anchor.x - cam.x) * ratio, y: anchor.y - (anchor.y - cam.y) * ratio, scale: next };
}

/** @param {Camera} cam @param {Point} anchor @param {number} factor @returns {Camera} */
export const zoomBy = (cam, anchor, factor) => zoomAt(cam, anchor, cam.scale * factor);

/**
 * HUD +/- steps to the next multiple of 10% in that direction (Infinite's zoomIn/zoomOut, but
 * landing on round percentages after a pinch).
 * @param {number} scale @param {1 | -1} direction
 */
export function stepScale(scale, direction) {
	const steps = scale / ZOOM_STEP;
	const next = direction > 0 ? Math.floor(steps + 1e-6) + 1 : Math.ceil(steps - 1e-6) - 1;
	return clampScale(next / Math.round(1 / ZOOM_STEP));
}

/** @param {Size} viewport @returns {Point} */
export const viewportCenter = (viewport) => ({ x: viewport.w / 2, y: viewport.h / 2 });

/** @param {Camera} cam */
export const cameraTransform = (cam) => `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${cam.scale})`;

/**
 * Round the translation to device pixels so text rasterizes crisp once a gesture settles.
 * @param {Camera} cam @param {number} dpr @returns {Camera}
 */
export function snapCamera(cam, dpr) {
	const ratio = dpr > 0 ? dpr : 1;
	return { x: Math.round(cam.x * ratio) / ratio, y: Math.round(cam.y * ratio) / ratio, scale: cam.scale };
}

/** @param {Camera} cam @param {Rect} rect @returns {Rect} */
export function worldRectToScreen(cam, rect) {
	const origin = worldToScreen(cam, rect);
	return { x: origin.x, y: origin.y, w: rect.w * cam.scale, h: rect.h * cam.scale };
}

/**
 * The world-space rect the viewport shows, grown by `padding` screen pixels on each side
 * (Infinite's viewportRect.insetBy(-200)). Computed from the model, never from DOM reads.
 * @param {Camera} cam @param {Size} viewport @param {number} [padding] @returns {Rect}
 */
export function visibleWorldRect(cam, viewport, padding = VISIBILITY_PADDING) {
	const origin = screenToWorld(cam, { x: -padding, y: -padding });
	return { x: origin.x, y: origin.y, w: (viewport.w + 2 * padding) / cam.scale, h: (viewport.h + 2 * padding) / cam.scale };
}

/** @param {Rect} a @param {Rect} b */
export const rectsIntersect = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** @param {Camera} cam @param {Size} viewport @param {Rect} rect @param {number} [padding] */
export const isRectVisible = (cam, viewport, rect, padding = VISIBILITY_PADDING) => rectsIntersect(visibleWorldRect(cam, viewport, padding), rect);

/**
 * Camera that centers `rect` at `scale`.
 * @param {Size} viewport @param {Rect} rect @param {number} scale @returns {Camera}
 */
export function cameraCentering(viewport, rect, scale) {
	const s = clampScale(scale);
	const center = viewportCenter(viewport);
	return { x: center.x - (rect.x + rect.w / 2) * s, y: center.y - (rect.y + rect.h / 2) * s, scale: s };
}

/** @param {Size} viewport @param {Rect} rect @param {number} [padding] */
export function fitScale(viewport, rect, padding = 48) {
	const w = Math.max(viewport.w - 2 * padding, 1);
	const h = Math.max(viewport.h - 2 * padding, 1);
	return clampScale(Math.min(w / Math.max(rect.w, 1), h / Math.max(rect.h, 1)));
}

/**
 * Fit `rect` (a tile, or the bounds of all tiles) in the viewport, never zooming in past `maxScale`.
 * @param {Size} viewport @param {Rect} rect @param {{ padding?: number, maxScale?: number }} [options] @returns {Camera}
 */
export function cameraFitting(viewport, rect, { padding = 48, maxScale = 1 } = {}) {
	return cameraCentering(viewport, rect, Math.min(fitScale(viewport, rect, padding), maxScale));
}

/**
 * Where to fly when revealing a tile: zoomed out views come up to 100%, zoomed in views stay
 * zoomed in, and either way the whole tile has to fit.
 * @param {Camera} cam @param {Size} viewport @param {Rect} rect @param {number} [padding] @returns {Camera}
 */
export function cameraRevealing(cam, viewport, rect, padding = 48) {
	return cameraCentering(viewport, rect, Math.min(fitScale(viewport, rect, padding), Math.max(cam.scale, 1)));
}

/** @param {Rect[]} rects @returns {Rect | null} */
export function boundsOf(rects) {
	if (rects.length === 0) return null;
	const left = Math.min(...rects.map((r) => r.x));
	const top = Math.min(...rects.map((r) => r.y));
	const right = Math.max(...rects.map((r) => r.x + r.w));
	const bottom = Math.max(...rects.map((r) => r.y + r.h));
	return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Fly-to interpolation: the scale moves geometrically and the world point at the viewport
 * center moves linearly, so zooming and travelling feel like one motion.
 * @param {Camera} from @param {Camera} to @param {number} t @param {Size} viewport @returns {Camera}
 */
export function interpolateCamera(from, to, t, viewport) {
	const k = clamp(t, 0, 1);
	const center = viewportCenter(viewport);
	const a = screenToWorld(from, center);
	const b = screenToWorld(to, center);
	const scale = Math.exp(Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * k);
	const focus = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
	return { x: center.x - focus.x * scale, y: center.y - focus.y * scale, scale };
}

/** @param {number} t */
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Wheel deltas in pixels, whatever the deltaMode (0 pixels, 1 lines, 2 pages).
 * @param {{ deltaX: number, deltaY: number, deltaMode: number }} event @param {Size} page @returns {Point}
 */
export function wheelPixels(event, page) {
	const unit = event.deltaMode === 1 ? LINE_HEIGHT_PX : 1;
	if (event.deltaMode === 2) return { x: event.deltaX * page.w, y: event.deltaY * page.h };
	return { x: event.deltaX * unit, y: event.deltaY * unit };
}

/**
 * Zoom factor for a ctrl+wheel event (what Chrome sends for a trackpad pinch). Small pinch deltas map
 * smoothly; big mouse-wheel notches are capped so one notch can't jump across the whole range.
 * @param {number} deltaYPixels
 */
export const wheelZoomFactor = (deltaYPixels) => Math.exp(-clamp(deltaYPixels, -WHEEL_ZOOM_MAX_DELTA, WHEEL_ZOOM_MAX_DELTA) * WHEEL_ZOOM_SPEED);

/** @param {Camera} a @param {Camera} b */
export const sameCamera = (a, b) => a.x === b.x && a.y === b.y && a.scale === b.scale;
