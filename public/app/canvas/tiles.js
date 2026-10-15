// Tiles on the canvas world: chrome (title bar, resize grips), drag by the title bar, resize from the
// right edge, bottom edge and corner, focus and z-order, and visibility computed from the model
// geometry (never from DOM reads). Geometry writes are coalesced to one per tile per animation frame.
import { rectsIntersect, visibleWorldRect } from "./camera.js";
import { moveRect, resizeRect, sanitizeRect } from "./layout.js";
import { trackPointer } from "./pointer.js";

/** @typedef {import("./camera.js").Rect} Rect */
/** @typedef {import("./viewport.js").createViewport} CreateViewport */
/** @typedef {ReturnType<CreateViewport>} Viewport */

/**
 * @typedef {{
 *   id: string,
 *   rect: Rect,
 *   el: HTMLElement,
 *   frame: HTMLElement,
 *   bar: HTMLElement,
 *   titleEl: HTMLElement,
 *   statusEl: HTMLElement,
 *   controlsEl: HTMLElement,
 *   body: HTMLElement,
 *   visible: boolean,
 *   written: Rect | null,
 * }} Tile
 */

export const INTERACTIVE_SELECTOR = "button, input, select, textarea, a, [contenteditable], [data-no-drag]";

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {Document} doc @param {K} tag @param {string} className
 * @returns {HTMLElementTagNameMap[K]}
 */
function make(doc, tag, className) {
	const el = doc.createElement(tag);
	el.className = className;
	return el;
}

/**
 * @param {{
 *   world: HTMLElement,
 *   viewport: Viewport,
 *   onFocusChange?: (id: string | null) => void,
 *   onCloseRequest?: (id: string) => void,
 *   onGeometryCommit?: (id: string, rect: Rect) => void,
 *   onVisibilityChange?: (id: string, visible: boolean) => void,
 * }} options
 */
export function createTileLayer({ world, viewport, onFocusChange, onCloseRequest, onGeometryCommit, onVisibilityChange }) {
	const doc = world.ownerDocument;
	const view = /** @type {Window} */ (doc.defaultView);
	/** @type {Map<string, Tile>} */
	const tiles = new Map();
	/** @type {Set<Tile>} */
	const dirty = new Set();
	/** @type {string | null} */
	let focusedId = null;
	let zTop = 0;
	let frame = 0;
	/** @type {(() => void) | null} */
	let cancelDrag = null;

	function schedule() {
		if (!frame) frame = view.requestAnimationFrame(flush);
	}

	function flush() {
		frame = 0;
		for (const tile of dirty) writeGeometry(tile);
		dirty.clear();
	}

	/** @param {Tile} tile */
	function writeGeometry(tile) {
		const { rect, written, el } = tile;
		if (!written || written.x !== rect.x || written.y !== rect.y) el.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
		if (!written || written.w !== rect.w) el.style.width = `${rect.w}px`;
		if (!written || written.h !== rect.h) el.style.height = `${rect.h}px`;
		tile.written = rect;
	}

	/** @param {Tile} tile @param {Rect} rect */
	function setRectLive(tile, rect) {
		tile.rect = rect;
		dirty.add(tile);
		schedule();
	}

	/**
	 * Show tiles that entered the padded viewport right away; hide the ones that left only once the
	 * camera settles, so a pan never pays for hiding.
	 * @param {boolean} allowHide
	 */
	function updateVisibility(allowHide) {
		const visibleRect = visibleWorldRect(viewport.getCamera(), viewport.getSize());
		for (const tile of tiles.values()) {
			const visible = rectsIntersect(visibleRect, tile.rect);
			if (visible === tile.visible || (!visible && !allowHide)) continue;
			tile.visible = visible;
			tile.el.classList.toggle("cv-offscreen", !visible);
			onVisibilityChange?.(tile.id, visible);
		}
	}

	viewport.onChange(() => updateVisibility(!viewport.isGesturing()));
	viewport.onSettle(() => updateVisibility(true));

	/**
	 * @param {{ id: string, rect: Rect, title?: string }} spec
	 */
	function addTile({ id, rect, title = "" }) {
		if (tiles.has(id)) throw new Error(`tile ${id} is already on the canvas`);
		const el = make(doc, "div", "cv-tile");
		el.dataset.tileId = id;
		const frameEl = make(doc, "div", "cv-frame");
		const bar = make(doc, "div", "cv-bar");
		const close = make(doc, "button", "cv-close");
		close.type = "button";
		close.title = "Remove from canvas (the session keeps running)";
		close.setAttribute("aria-label", "Remove from canvas");
		close.addEventListener("click", (event) => {
			event.stopPropagation();
			onCloseRequest?.(id);
		});
		const titleEl = make(doc, "div", "cv-title");
		titleEl.textContent = title;
		const statusEl = make(doc, "div", "cv-status");
		const controlsEl = make(doc, "div", "cv-controls");
		bar.append(close, titleEl, statusEl, controlsEl);
		const body = make(doc, "div", "cv-body");
		frameEl.append(bar, body);
		el.append(frameEl, make(doc, "div", "cv-grip cv-grip-e"), make(doc, "div", "cv-grip cv-grip-s"), make(doc, "div", "cv-grip cv-grip-se"));
		/** @type {Tile} */
		const tile = { id, rect: sanitizeRect(rect), el, frame: frameEl, bar, titleEl, statusEl, controlsEl, body, visible: true, written: null };
		el.style.zIndex = String(++zTop);
		writeGeometry(tile);
		tiles.set(id, tile);
		world.append(el);
		updateVisibility(true);
		return tile;
	}

	/** @param {string} id */
	function removeTile(id) {
		const tile = tiles.get(id);
		if (!tile) return;
		tiles.delete(id);
		dirty.delete(tile);
		tile.el.remove();
		if (focusedId === id) {
			focusedId = null;
			const next = [...tiles.values()].sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0];
			if (next) focusTile(next.id);
			else onFocusChange?.(null);
		}
	}

	/** @param {string | null} id */
	function focusTile(id) {
		const tile = id ? tiles.get(id) : undefined;
		if (id && !tile) return;
		if (focusedId === id) return;
		if (focusedId) tiles.get(focusedId)?.el.classList.remove("cv-focused");
		focusedId = id;
		if (tile) {
			tile.el.classList.add("cv-focused");
			if (Number(tile.el.style.zIndex) !== zTop) tile.el.style.zIndex = String(++zTop);
		}
		onFocusChange?.(id);
	}

	/** @param {PointerEvent} down @param {string} id */
	function beginDrag(down, id) {
		const tile = tiles.get(id);
		if (!tile) return;
		cancelDrag?.();
		const start = tile.rect;
		const scale = viewport.getCamera().scale;
		tile.el.classList.add("cv-dragging");
		cancelDrag = trackPointer(tile.bar, down, {
			onMove: (event) => setRectLive(tile, moveRect(start, (event.clientX - down.clientX) / scale, (event.clientY - down.clientY) / scale)),
			onEnd: () => {
				cancelDrag = null;
				tile.el.classList.remove("cv-dragging");
				if (tile.rect !== start) onGeometryCommit?.(id, tile.rect);
				updateVisibility(true);
			},
		});
	}

	/** @param {PointerEvent} down @param {string} id @param {{ right: boolean, bottom: boolean }} edges */
	function beginResize(down, id, edges) {
		const tile = tiles.get(id);
		if (!tile) return;
		cancelDrag?.();
		const start = tile.rect;
		const scale = viewport.getCamera().scale;
		tile.el.classList.add("cv-resizing");
		cancelDrag = trackPointer(tile.el, down, {
			onMove: (event) => setRectLive(tile, resizeRect(start, edges, (event.clientX - down.clientX) / scale, (event.clientY - down.clientY) / scale)),
			onEnd: () => {
				cancelDrag = null;
				tile.el.classList.remove("cv-resizing");
				if (tile.rect !== start) onGeometryCommit?.(id, tile.rect);
				updateVisibility(true);
			},
		});
	}

	/** @param {string} id @param {Rect} rect */
	function setRect(id, rect) {
		const tile = tiles.get(id);
		if (!tile) return;
		setRectLive(tile, sanitizeRect(rect));
		updateVisibility(true);
	}

	return {
		addTile,
		removeTile,
		focusTile,
		beginDrag,
		beginResize,
		setRect,
		/** @param {string} id */
		get: (id) => tiles.get(id),
		has: (/** @type {string} */ id) => tiles.has(id),
		ids: () => [...tiles.keys()],
		rects: () => [...tiles.values()].map((tile) => tile.rect),
		focusedId: () => focusedId,
		/** @param {EventTarget | null} target */
		tileIdOf(target) {
			const el = target instanceof view.Element ? target.closest(".cv-tile") : null;
			return el instanceof view.HTMLElement ? (el.dataset.tileId ?? null) : null;
		},
		destroy() {
			view.cancelAnimationFrame(frame);
			cancelDrag?.();
			for (const tile of tiles.values()) tile.el.remove();
			tiles.clear();
			dirty.clear();
		},
	};
}
