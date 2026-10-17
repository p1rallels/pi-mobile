// The camera bound to the page: one transform on the world layer, written at most once per animation
// frame. Pinch (ctrl+wheel in Chrome, gesture* in Safari) zooms at the cursor, wheel on empty canvas and
// cmd+wheel anywhere pan, drags pan. will-change is set only while a gesture or flight runs, so the
// compositor scales the existing raster mid-gesture and text re-rasterizes crisp once it settles.
import {
	cameraRevealing,
	cameraTransform,
	easeInOutCubic,
	interpolateCamera,
	panBy,
	sameCamera,
	sanitizeCamera,
	screenToWorld,
	snapCamera,
	stepScale,
	viewportCenter,
	wheelPixels,
	wheelZoomFactor,
	zoomAt,
} from "./camera.js";
import { trackPointer } from "./pointer.js";

const GESTURE_IDLE_MS = 180;
const FLY_MS = 420;
const STEP_MS = 160;

/** @typedef {import("./camera.js").Camera} Camera */
/** @typedef {import("./camera.js").Rect} Rect */
/** @typedef {import("./camera.js").Size} Size */
/** @typedef {(camera: Camera, size: Size) => void} CameraListener */

/**
 * @param {{
 *   root: HTMLElement,
 *   world: HTMLElement,
 *   camera?: unknown,
 *   isEmptyCanvas: (target: EventTarget | null) => boolean,
 * }} options
 */
export function createViewport({ root, world, camera: initialCamera, isEmptyCanvas }) {
	const view = /** @type {Window} */ (root.ownerDocument.defaultView);
	let camera = sanitizeCamera(initialCamera);
	/** @type {Camera | null} */
	let written = null;
	let size = measure();
	let frame = 0;
	let gesturing = false;
	let idleTimer = 0;
	/** @type {{ from: Camera, to: Camera, start: number, duration: number } | null} */
	let flight = null;
	/** @type {{ scale: number } | null} */
	let safariPinch = null;
	let wheelPanLatched = false;
	/** @type {(() => void) | null} */
	let cancelPan = null;
	/** @type {Set<CameraListener>} */
	const changeListeners = new Set();
	/** @type {Set<CameraListener>} */
	const settleListeners = new Set();

	function measure() {
		const box = root.getBoundingClientRect();
		return { w: Math.max(box.width, 1), h: Math.max(box.height, 1), left: box.left, top: box.top };
	}

	/** @param {{ clientX: number, clientY: number }} event */
	const local = (event) => ({ x: event.clientX - size.left, y: event.clientY - size.top });

	function schedule() {
		if (!frame) frame = view.requestAnimationFrame(flush);
	}

	/** @param {number} now */
	function flush(now) {
		frame = 0;
		if (flight) advanceFlight(now);
		if (written && sameCamera(written, camera)) return;
		world.style.transform = cameraTransform(camera);
		written = camera;
		for (const listener of changeListeners) listener(camera, size);
	}

	/** @param {number} now */
	function advanceFlight(now) {
		if (!flight) return;
		const t = flight.duration > 0 ? (now - flight.start) / flight.duration : 1;
		if (t >= 1) {
			camera = flight.to;
			flight = null;
			endGesture();
			return;
		}
		camera = interpolateCamera(flight.from, flight.to, easeInOutCubic(Math.max(t, 0)), size);
		schedule();
	}

	function beginGesture() {
		if (!gesturing) {
			gesturing = true;
			world.style.willChange = "transform";
			root.classList.add("cv-gesturing");
		}
		view.clearTimeout(idleTimer);
		idleTimer = 0;
	}

	function scheduleGestureEnd() {
		view.clearTimeout(idleTimer);
		idleTimer = view.setTimeout(endGesture, GESTURE_IDLE_MS);
	}

	function endGesture() {
		view.clearTimeout(idleTimer);
		idleTimer = 0;
		wheelPanLatched = false;
		if (!gesturing || flight || cancelPan || safariPinch) return;
		gesturing = false;
		world.style.willChange = "";
		root.classList.remove("cv-gesturing");
		camera = snapCamera(camera, view.devicePixelRatio || 1);
		schedule();
		for (const listener of settleListeners) listener(camera, size);
	}

	/** @param {Camera} next */
	function moveLive(next) {
		flight = null;
		beginGesture();
		camera = next;
		schedule();
	}

	/** @param {Camera} next */
	function liveFromWheel(next) {
		moveLive(next);
		scheduleGestureEnd();
	}

	/**
	 * Runs in the capture phase and stops what it acts on (pinch, cmd+wheel, a pan that started on empty canvas), so a
	 * tile that takes every wheel itself (a terminal running vim) never eats a zoom or a pan. Plain wheels over a tile
	 * go on to the tile.
	 * @param {WheelEvent} event
	 */
	function onWheel(event) {
		if (safariPinch) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const delta = wheelPixels(event, size);
		if (event.ctrlKey) {
			event.preventDefault();
			event.stopPropagation();
			liveFromWheel(zoomAt(camera, local(event), camera.scale * wheelZoomFactor(delta.y)));
			return;
		}
		// a wheel pan that started on empty canvas keeps panning when the cursor drifts over a tile
		if (!event.metaKey && !wheelPanLatched && !isEmptyCanvas(event.target)) return;
		event.preventDefault();
		event.stopPropagation();
		wheelPanLatched = true;
		const horizontal = event.shiftKey && delta.x === 0;
		liveFromWheel(panBy(camera, horizontal ? -delta.y : -delta.x, horizontal ? 0 : -delta.y));
	}

	/** @param {Event} event */
	function onGestureStart(event) {
		event.preventDefault();
		flight = null;
		beginGesture();
		safariPinch = { scale: camera.scale };
	}

	/** @param {Event} event */
	function onGestureChange(event) {
		event.preventDefault();
		if (!safariPinch) return;
		const gesture = /** @type {Event & { scale: number, clientX: number, clientY: number }} */ (event);
		camera = zoomAt(camera, local(gesture), safariPinch.scale * gesture.scale);
		schedule();
	}

	/** @param {Event} event */
	function onGestureEnd(event) {
		event.preventDefault();
		safariPinch = null;
		scheduleGestureEnd();
	}

	/**
	 * Pan by dragging, from empty canvas or with cmd held anywhere.
	 * @param {PointerEvent} down
	 */
	function beginPanDrag(down) {
		cancelPan?.();
		const start = camera;
		root.classList.add("cv-panning");
		moveLive(camera);
		cancelPan = trackPointer(root, down, {
			onMove: (event) => moveLive(panBy(start, event.clientX - down.clientX, event.clientY - down.clientY)),
			onEnd: () => {
				cancelPan = null;
				root.classList.remove("cv-panning");
				scheduleGestureEnd();
			},
		});
	}

	/**
	 * @param {Camera} target @param {number} [duration]
	 */
	function flyTo(target, duration = FLY_MS) {
		const to = sanitizeCamera(target);
		if (sameCamera(to, camera)) return;
		cancelPan?.();
		beginGesture();
		flight = { from: camera, to, start: view.performance.now(), duration };
		schedule();
	}

	/** @param {1 | -1} direction */
	const zoomStep = (direction) => flyTo(zoomAt(flight?.to ?? camera, viewportCenter(size), stepScale((flight?.to ?? camera).scale, direction)), STEP_MS);

	/** @param {Camera} next */
	function setCamera(next) {
		flight = null;
		camera = sanitizeCamera(next);
		schedule();
		if (!gesturing) for (const listener of settleListeners) listener(camera, size);
	}

	const resizeObserver = new ResizeObserver(() => {
		size = measure();
		written = null;
		schedule();
	});
	resizeObserver.observe(root);

	root.addEventListener("wheel", onWheel, { passive: false, capture: true });
	root.addEventListener("gesturestart", onGestureStart);
	root.addEventListener("gesturechange", onGestureChange);
	root.addEventListener("gestureend", onGestureEnd);
	schedule();

	return {
		getCamera: () => camera,
		getSize: () => /** @type {Size} */ ({ w: size.w, h: size.h }),
		isGesturing: () => gesturing,
		/** @param {{ clientX: number, clientY: number }} event */
		clientToWorld: (event) => screenToWorld(camera, local(event)),
		setCamera,
		flyTo,
		/** @param {Rect} rect */
		reveal: (rect) => flyTo(cameraRevealing(camera, size, rect)),
		zoomStep,
		resetZoom: () => flyTo(zoomAt(camera, viewportCenter(size), 1), STEP_MS),
		beginPanDrag,
		/** @param {CameraListener} listener */
		onChange(listener) {
			changeListeners.add(listener);
			return () => changeListeners.delete(listener);
		},
		/** @param {CameraListener} listener */
		onSettle(listener) {
			settleListeners.add(listener);
			return () => settleListeners.delete(listener);
		},
		destroy() {
			view.cancelAnimationFrame(frame);
			view.clearTimeout(idleTimer);
			cancelPan?.();
			resizeObserver.disconnect();
			root.removeEventListener("wheel", onWheel, { capture: true });
			root.removeEventListener("gesturestart", onGestureStart);
			root.removeEventListener("gesturechange", onGestureChange);
			root.removeEventListener("gestureend", onGestureEnd);
			changeListeners.clear();
			settleListeners.clear();
		},
	};
}
