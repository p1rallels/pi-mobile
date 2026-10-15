// The canvas view: a world layer of tiles under one camera, plus the HUD. Routes input the way
// Infinite does: drag a title bar to move, the edges to resize, empty canvas or cmd anywhere to pan,
// pinch to zoom; a click on a tile focuses it and the tile keeps the keyboard while you pan.
import { boundsOf, cameraFitting } from "./camera.js";
import { createHud } from "./hud.js";
import { INTERACTIVE_SELECTOR, createTileLayer } from "./tiles.js";
import { createViewport } from "./viewport.js";

/** @typedef {import("./camera.js").Camera} Camera */
/** @typedef {import("./camera.js").Rect} Rect */

/**
 * @param {{
 *   root: HTMLElement,
 *   camera?: unknown,
 *   onNewTile: () => void,
 *   onEmptyDoubleClick?: (world: { x: number, y: number }) => void,
 *   onFocusChange?: (id: string | null) => void,
 *   focusComposer?: (id: string) => void,
 *   onActivate?: (id: string) => void,
 *   onCloseRequest?: (id: string) => void,
 *   onGeometryCommit?: (id: string, rect: Rect) => void,
 *   onVisibilityChange?: (id: string, visible: boolean) => void,
 *   onCameraSettle?: (camera: Camera) => void,
 *   onEscape?: (id: string, event: KeyboardEvent) => void,
 * }} options
 */
export function createCanvas(options) {
	const { root } = options;
	const doc = root.ownerDocument;
	const view = /** @type {Window} */ (doc.defaultView);
	root.classList.add("cv-root");
	const world = doc.createElement("div");
	world.className = "cv-world";
	root.append(world);

	/** @param {EventTarget | null} target */
	const elementOf = (target) => (target instanceof view.Element ? target : null);
	/** @param {EventTarget | null} target */
	const isEmptyCanvas = (target) => !elementOf(target)?.closest(".cv-tile, .cv-hud");

	const viewport = createViewport({ root, world, camera: options.camera, isEmptyCanvas });
	const tiles = createTileLayer({
		world,
		viewport,
		onFocusChange: options.onFocusChange,
		onCloseRequest: options.onCloseRequest,
		onGeometryCommit: options.onGeometryCommit,
		onVisibilityChange: options.onVisibilityChange,
	});

	function fitAll() {
		const bounds = boundsOf(tiles.rects());
		if (bounds) viewport.flyTo(cameraFitting(viewport.getSize(), bounds, { maxScale: 1 }));
	}

	const hud = createHud({ root, viewport, onNewTile: options.onNewTile, onFit: fitAll });
	const unsubscribeSettle = viewport.onSettle((camera) => options.onCameraSettle?.(camera));

	/** @typedef {{ kind: "pan" } | { kind: "drag", id: string } | { kind: "resize", id: string, edges: { right: boolean, bottom: boolean } } | { kind: "content", id: string } | { kind: "hud" }} Press */

	/** @param {MouseEvent} event @returns {Press | null} */
	function classify(event) {
		if (event.button === 1 || (event.button === 0 && event.metaKey)) return { kind: "pan" };
		if (event.button !== 0) return null;
		const target = elementOf(event.target);
		if (!target) return null;
		if (target.closest(".cv-hud")) return { kind: "hud" };
		const id = tiles.tileIdOf(target);
		if (!id) return { kind: "pan" };
		const grip = target.closest(".cv-grip");
		if (grip) return { kind: "resize", id, edges: { right: !grip.classList.contains("cv-grip-s"), bottom: !grip.classList.contains("cv-grip-e") } };
		if (target.closest(".cv-bar") && !target.closest(INTERACTIVE_SELECTOR)) return { kind: "drag", id };
		return { kind: "content", id };
	}

	/** @param {PointerEvent} event */
	function onPointerDown(event) {
		const press = classify(event);
		if (!press) return;
		switch (press.kind) {
			case "pan":
				viewport.beginPanDrag(event);
				return;
			case "drag":
				tiles.focusTile(press.id);
				options.focusComposer?.(press.id);
				tiles.beginDrag(event, press.id);
				return;
			case "resize":
				tiles.focusTile(press.id);
				tiles.beginResize(event, press.id, press.edges);
				return;
			case "content":
				tiles.focusTile(press.id);
				return;
			case "hud":
				return;
		}
	}

	// Cancelling mousedown (not pointerdown) is what stops the browser from moving focus or starting a
	// text selection, so pressing empty canvas, a title bar or a grip leaves the composer focused.
	/** @param {MouseEvent} event */
	function onMouseDown(event) {
		const press = classify(event);
		if (press && press.kind !== "content") event.preventDefault();
	}

	/** @param {MouseEvent} event */
	function onClick(event) {
		const press = classify(event);
		if (!press || press.kind !== "content") return;
		const target = elementOf(event.target);
		if (target?.closest(INTERACTIVE_SELECTOR)) return;
		if (!view.getSelection()?.isCollapsed) return;
		options.focusComposer?.(press.id);
		options.onActivate?.(press.id);
	}

	/** @param {MouseEvent} event */
	function onDoubleClick(event) {
		const press = classify(event);
		if (press?.kind === "pan" && !event.metaKey) {
			options.onEmptyDoubleClick?.(viewport.clientToWorld(event));
			return;
		}
		if (press?.kind === "drag") revealTile(press.id);
	}

	/** @param {KeyboardEvent} event */
	function onKeyDown(event) {
		const focused = tiles.focusedId();
		if (!focused) return;
		if (event.key === "Escape") {
			if (event.isComposing || event.defaultPrevented) return;
			options.onEscape?.(focused, event);
			return;
		}
		// typing with nothing focused (after a click on the hud, say) goes to the focused tile's composer
		const active = doc.activeElement;
		const typing = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
		if (typing && (!active || active === doc.body || active === root)) options.focusComposer?.(focused);
	}

	/** @param {string} id */
	function revealTile(id) {
		const tile = tiles.get(id);
		if (tile) viewport.reveal(tile.rect);
	}

	root.addEventListener("pointerdown", onPointerDown);
	root.addEventListener("mousedown", onMouseDown);
	root.addEventListener("click", onClick);
	root.addEventListener("dblclick", onDoubleClick);
	doc.addEventListener("keydown", onKeyDown);

	return {
		root,
		world,
		viewport,
		tiles,
		hud,
		fitAll,
		revealTile,
		destroy() {
			root.removeEventListener("pointerdown", onPointerDown);
			root.removeEventListener("mousedown", onMouseDown);
			root.removeEventListener("click", onClick);
			root.removeEventListener("dblclick", onDoubleClick);
			doc.removeEventListener("keydown", onKeyDown);
			unsubscribeSettle();
			hud.destroy();
			tiles.destroy();
			viewport.destroy();
			world.remove();
			root.classList.remove("cv-root");
		},
	};
}
