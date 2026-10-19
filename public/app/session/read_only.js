// Sessions pi-web only shows and never loads (the host's msg-subs.ts): a sub, which its parent session manages through
// msg, or a session whose folder is gone. Every way in opens them in the follow view with nothing to type into and
// nothing to take over; while another pi runs one, Esc still stops it.

/** @typedef {{ reason: "sub", parent: string } | { reason: "folder" }} ReadOnly */

/**
 * The host's reason a session opens read-only, checked; null for anything else (a session it may load).
 * @param {unknown} value @returns {ReadOnly | null}
 */
export function readOnlyOf(value) {
	if (!value || typeof value !== "object") return null;
	const { reason, parent } = /** @type {{ reason?: unknown, parent?: unknown }} */ (value);
	if (reason === "sub") return { reason, parent: typeof parent === "string" ? parent : "" };
	return reason === "folder" ? { reason } : null;
}

/**
 * The host refused to resume or attach a session it only shows (409 `{ readOnly }`): why, else null.
 * @param {any} error
 */
export const readOnlyOfError = (error) => (error && error.status === 409 && error.body && typeof error.body === "object" ? readOnlyOf(error.body.readOnly) : null);

/**
 * The parent's name for a sub's note: the lineage's label when it names the same session, else its short id.
 * @param {ReadOnly} readOnly @param {any} state the pane's state, with the lineage the host sent
 */
export function parentLabel(readOnly, state) {
	if (readOnly.reason !== "sub") return null;
	const parent = state?.lineage?.parent;
	if (parent && parent.id === readOnly.parent && typeof parent.label === "string" && parent.label.trim()) return parent.label.trim();
	return readOnly.parent ? readOnly.parent.slice(0, 8) : null;
}

/**
 * What a read-only pane says where its composer would be: why, and that Esc stops the pi running it while one does.
 * @param {ReadOnly} readOnly @param {{ parent?: string | null, writing?: boolean }} [options]
 */
export function readOnlyNote(readOnly, { parent = null, writing = false } = {}) {
	const why = readOnly.reason === "sub" ? `${parent || "its parent"} manages this sub` : "its folder is gone";
	return `Read-only: ${why}${writing ? " · Esc stops it" : ""}`;
}
