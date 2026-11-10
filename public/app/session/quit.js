// /quit and Release do the same thing: stop the session this pane runs here, the way quitting pi does, and hand the
// pane back to the shell (a canvas tile goes back to its launcher, the phone opens its New sheet). The session file
// stays, so it resumes from the list. Both refuse while pi works.

/** @typedef {"command" | "release"} QuitVia /quit typed in the composer, or a Release button or menu item. */

/**
 * Why the session can't be stopped right now, or null when it can.
 * @param {{ isStreaming?: boolean, isCompacting?: boolean } | null | undefined} state
 */
export function quitRefusal(state) {
	return state?.isStreaming || state?.isCompacting ? "pi is still working. Esc stops it first" : null;
}

/** The notice a /quit or Release that didn't stop the session leaves. @param {QuitVia} via @param {string} reason */
export function notStoppedNotice(via, reason) {
	return `${via === "release" ? "Not released" : "Not quit"}: ${reason}`;
}

/** What a pane watching a session says once another browser (or tab) released it or typed /quit there. */
export const STOPPED_ELSEWHERE = "This session was stopped elsewhere. It resumes from the list.";
