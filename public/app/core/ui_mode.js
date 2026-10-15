// Which shell to run: the phone ui (default) or the laptop canvas. ?ui=canvas / ?ui=phone switch and
// are remembered per device; phones never get the canvas. canvasCapable() is the detection helper for
// switching auto-detection on later (fine pointer and a short side of at least 700 css px).

export const UI_MODE_KEY = "pi-web.ui";
const MODES = new Set(["canvas", "phone"]);
const CANVAS_MIN_SHORT_SIDE = 700;

/** @param {{ finePointer: boolean, shortSide: number }} device */
export const canvasCapable = ({ finePointer, shortSide }) => finePointer && shortSide >= CANVAS_MIN_SHORT_SIDE;

/**
 * @param {{ requested: string | null, stored: string | null, phone: boolean }} input
 * @returns {{ mode: "canvas" | "phone", remember: "canvas" | "phone" | null }}
 */
export function resolveUiMode({ requested, stored, phone }) {
	const asked = requested && MODES.has(requested) ? /** @type {"canvas" | "phone"} */ (requested) : null;
	const remembered = stored && MODES.has(stored) ? /** @type {"canvas" | "phone"} */ (stored) : null;
	const wanted = asked ?? remembered ?? "phone";
	return { mode: phone ? "phone" : wanted, remember: asked };
}

/** @param {Window} win */
export function detectCanvasCapable(win) {
	const finePointer = typeof win.matchMedia === "function" && win.matchMedia("(pointer: fine)").matches;
	return canvasCapable({ finePointer, shortSide: Math.min(win.screen?.width ?? 0, win.screen?.height ?? 0) });
}

/**
 * Reads ?ui= and localStorage, remembers an explicit choice, and returns the mode to boot.
 * @param {Window} win @param {boolean} phone
 */
export function uiModeForPage(win, phone) {
	let stored = null;
	try {
		stored = win.localStorage.getItem(UI_MODE_KEY);
	} catch {
		stored = null;
	}
	const { mode, remember } = resolveUiMode({ requested: new URL(win.location.href).searchParams.get("ui"), stored, phone });
	if (remember) {
		try {
			win.localStorage.setItem(UI_MODE_KEY, remember);
		} catch {
			// private mode: the choice just isn't remembered
		}
	}
	return mode;
}
