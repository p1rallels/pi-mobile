// Pure text for a session pane's chrome: footer lines, composer placeholder, labels.

/** @param {unknown} n */
export function formatTokens(n) {
	const num = Number(n || 0);
	if (!Number.isFinite(num) || num <= 0) return "0";
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 10_000) return `${Math.round(num / 1_000)}k`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
	return String(Math.round(num));
}

/** @param {unknown} cost */
export function formatCost(cost) {
	const num = Number(cost || 0);
	if (!Number.isFinite(num) || num <= 0) return null;
	return `$${num.toFixed(3)}`;
}

/** @param {any} state */
export function buildSessionMetrics(state) {
	if (!state || typeof state !== "object") return "";

	const parts = [];
	const stats = state.stats && typeof state.stats === "object" ? state.stats : null;
	const tokens = stats && stats.tokens && typeof stats.tokens === "object" ? stats.tokens : null;

	const inputTokens = tokens && typeof tokens.input === "number" ? tokens.input : 0;
	const outputTokens = tokens && typeof tokens.output === "number" ? tokens.output : 0;
	const cacheRead = tokens && typeof tokens.cacheRead === "number" ? tokens.cacheRead : 0;
	const cacheWrite = tokens && typeof tokens.cacheWrite === "number" ? tokens.cacheWrite : 0;
	const cost = stats && typeof stats.cost === "number" ? stats.cost : 0;

	if (inputTokens) parts.push(`↑${formatTokens(inputTokens)}`);
	if (outputTokens) parts.push(`↓${formatTokens(outputTokens)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);

	const costStr = formatCost(cost);
	if (costStr) parts.push(costStr);

	const usage = state.contextUsage && typeof state.contextUsage === "object" ? state.contextUsage : null;
	const cw = usage && typeof usage.contextWindow === "number" ? usage.contextWindow : 0;
	if (cw > 0) {
		const percent = typeof usage.percent === "number" ? usage.percent : null;
		const auto = state.autoCompactionEnabled ? " (auto)" : "";
		if (percent === null) {
			parts.push(`?/${formatTokens(cw)}${auto}`);
		} else {
			parts.push(`${Math.round(percent)}%/${formatTokens(cw)}${auto}`);
		}
	}

	return parts.join(" ");
}

/** @param {any} state */
export const modelLabel = (state) => (state?.model ? `${state.model.provider}/${state.model.id}` : null);

/**
 * The pane footer: cwd (plus the untrusted-project hint), then metrics • session id and model • thinking.
 * @param {any} state @param {{ hostLabel?: string | null, baseUrl: string }} host
 */
export function footerLines(state, host) {
	if (!state) return { line1: host.hostLabel ? `host: ${host.hostLabel}` : "—", left2: "—", right2: host.baseUrl };
	const trust = state.projectTrust;
	const untrusted = trust && trust.gated && !trust.trusted ? " · project .pi resources skipped (untrusted)" : "";
	const metrics = buildSessionMetrics(state);
	const left = metrics ? [metrics] : [];
	left.push(String(state.sessionId || "").slice(0, 8));
	return { line1: `${state.cwd || "—"}${untrusted}`, left2: left.join(" • "), right2: `${modelLabel(state) ?? "(no model)"} • ${state.thinkingLevel}` };
}

/** @param {{ kind: string, reason?: string | null, attempt?: number, maxAttempts?: number }} status */
export function workingLabel(status) {
	if (status.kind === "compacting") return status.reason && status.reason !== "manual" ? `Compacting context (${status.reason})...` : "Compacting context...";
	if (status.kind === "retrying") return `Retrying (${status.attempt}/${status.maxAttempts})...`;
	return "Working...";
}

/** @param {{ hasSession: boolean, compacting: boolean, isController: boolean, streaming: boolean, phone: boolean }} s */
export function composerPlaceholder({ hasSession, compacting, isController, streaming, phone }) {
	if (!hasSession) return "";
	if (compacting) return "Compacting context…";
	if (!isController) return "Viewer mode — Take over to type";
	if (phone) return "Type a prompt (Enter steers, /queue waits)";
	return streaming ? "Streaming… (Enter steers, /queue waits)" : "Type a prompt (Enter to send, Shift+Enter for newline)";
}

/** @param {string} role @param {string} connection @param {boolean} hasSession */
export function roleBadge(role, connection, hasSession) {
	const offline = hasSession && (connection === "reconnecting" || connection === "gone");
	if (!offline) return { text: role, kind: role };
	return { text: connection === "gone" ? "ended" : "reconnecting", kind: "offline" };
}
