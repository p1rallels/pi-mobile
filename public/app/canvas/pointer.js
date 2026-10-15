// Follow one pointer from pointerdown to pointerup with capture, so drags keep tracking outside the element.

/**
 * @param {HTMLElement} el
 * @param {PointerEvent} down
 * @param {{ onMove: (event: PointerEvent) => void, onEnd: (event: PointerEvent | null) => void }} handlers
 * @returns {() => void} cancels the drag (onEnd gets null)
 */
export function trackPointer(el, down, { onMove, onEnd }) {
	const id = down.pointerId;
	let active = true;
	try {
		el.setPointerCapture(id);
	} catch {
		// synthetic events and already-released pointers can't be captured; window listeners still follow them
	}
	const target = /** @type {EventTarget} */ (el.ownerDocument.defaultView ?? el);
	/** @param {Event} event */
	const move = (event) => {
		const pointer = /** @type {PointerEvent} */ (event);
		if (pointer.pointerId === id) onMove(pointer);
	};
	/** @param {Event} event */
	const up = (event) => {
		const pointer = /** @type {PointerEvent} */ (event);
		if (pointer.pointerId !== id) return;
		finish(pointer);
	};
	/** @param {PointerEvent | null} event */
	function finish(event) {
		if (!active) return;
		active = false;
		target.removeEventListener("pointermove", move);
		target.removeEventListener("pointerup", up);
		target.removeEventListener("pointercancel", up);
		try {
			el.releasePointerCapture(id);
		} catch {
			// already released
		}
		onEnd(event);
	}
	target.addEventListener("pointermove", move);
	target.addEventListener("pointerup", up);
	target.addEventListener("pointercancel", up);
	return () => finish(null);
}
