// A session nobody sent anything to was never saved: pi writes a session's file with its first message, like the
// cli. When such a session stops running (a server restart), there is nothing to resume, and as far as pi goes it
// never existed. A pane that had one open goes "fresh" instead: it keeps the folder, the composer and the settings,
// with no session behind it, and the first send starts a new session there (the controller's openFresh).

const EMPTY_QUEUE = { steering: [], followUp: [] };

/**
 * The host's never-saved answer in a 404 (attach, resume, file read): `{ cwd }`, null cwd when the host can't
 * tell the folder; null for any other error.
 * @param {any} error
 * @returns {{ cwd: string | null } | null}
 */
export function neverSavedOf(error) {
	const body = error && error.status === 404 && error.body && typeof error.body === "object" ? error.body : null;
	if (!body || body.neverSaved !== true) return null;
	return { cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : null };
}

/**
 * "This session only" trust answers live with the session, so the one standing in for it gets the same answer.
 * @param {any} trust the session's projectTrust
 * @returns {"trust_session" | "distrust_session" | null}
 */
export function sessionTrustChoice(trust) {
	if (!trust || typeof trust !== "object" || trust.source !== "session") return null;
	return trust.trusted ? "trust_session" : "distrust_session";
}

/**
 * @typedef {{
 *   cwd: string,
 *   model: { provider: string, id: string } | null,
 *   thinkingLevel: string | null,
 *   projectTrust: "trust_session" | "distrust_session" | null,
 *   gitBranch: string | null,
 * }} FreshRecord
 */

/**
 * What a fresh pane keeps of the session it stands in for: the folder, and what the new session starts with.
 * @param {string} cwd @param {any} [state] the old session's last state, when the pane still has it
 * @returns {FreshRecord}
 */
export function freshRecord(cwd, state = null) {
	const model = state?.model;
	return {
		cwd,
		model: model && typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : null,
		thinkingLevel: typeof state?.thinkingLevel === "string" && state.thinkingLevel ? state.thinkingLevel : null,
		projectTrust: sessionTrustChoice(state?.projectTrust),
		gitBranch: typeof state?.gitBranch === "string" && state.gitBranch ? state.gitBranch : null,
	};
}

/**
 * The footer and controls of a fresh pane: its folder and settings, no session yet.
 * @param {FreshRecord} record
 */
export function freshStatus(record) {
	return {
		sessionId: "",
		cwd: record.cwd,
		gitBranch: record.gitBranch,
		sessionFile: null,
		model: record.model,
		thinkingLevel: record.thinkingLevel || "—",
		projectTrust: null,
		isStreaming: false,
		isCompacting: false,
		retryAttempt: 0,
		queuedMessages: EMPTY_QUEUE,
		stats: null,
		contextUsage: null,
	};
}

/**
 * POST /api/sessions for the session a fresh pane starts.
 * @param {FreshRecord} record @param {string | null} clientId
 */
export function freshPayload(record, clientId) {
	return {
		clientId,
		cwd: record.cwd,
		...(record.projectTrust ? { projectTrust: record.projectTrust } : {}),
		...(record.model ? { model: record.model } : {}),
		...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
	};
}
