// What a terminal tile makes of a request the host refused. No page needed, so tests import it as is.

/** @param {unknown} error */
export const messageOf = (error) => (error instanceof Error ? error.message : String(error));
/** @param {unknown} error */
export const statusOf = (error) => /** @type {any} */ (error)?.status;
/** The host wants a (fresher) Face ID check; other 401s mean the browser session cookie is gone. @param {unknown} error */
export const needsFaceId = (error) => statusOf(error) === 401 && /face id/i.test(messageOf(error));

/**
 * @typedef {{ then: "exit", reason: string }
 *   | { then: "open" }
 *   | { then: "refused" }
 *   | { then: "end", note: string }
 *   | { then: "retry" }} AttachRefusal
 */

/**
 * Where a refused attach (GET /api/terminals/<id>) leaves the tile:
 * - exit: the shell ended while the tile wasn't watching (locked, reloaded); it ends here the way it ended there, never
 *   as a new local shell standing in for, say, an ssh that timed out
 * - open: the host never heard of it (a restart): a new shell in its folder
 * - refused: it needs a Face ID check, or a new browser session
 * - end: the host won't let this device at shells (revoked, expired, not allowed); asking again won't change that, so
 *   the tile ends with the host's reason instead of polling
 * - retry: anything else (the host restarting, the network) is worth another try
 * @param {unknown} error
 * @returns {AttachRefusal}
 */
export function attachRefusal(error) {
	const status = statusOf(error);
	const ended = status === 404 ? /** @type {any} */ (error).body?.ended : null;
	if (typeof ended === "string" && ended !== "shutdown") return { then: "exit", reason: ended };
	if (status === 404) return { then: "open" };
	if (status === 401) return { then: "refused" };
	if (status === 403) return { then: "end", note: messageOf(error) };
	return { then: "retry" };
}
