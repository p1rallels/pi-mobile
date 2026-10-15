import { computeCliCommand } from "./cli.js";
import { createChatView } from "./chat_view.js";
import { parseCompactCommand, parseQueueCommand } from "./commands.js";

/** The server pings every 5s; a stream silent for longer is dead even if the browser still calls it open. */
const STALE_STREAM_MS = 15_000;
const STALE_CHECK_MS = 5_000;

const EMPTY_QUEUE = { steering: [], followUp: [] };

/** Elsewhere states that leave nobody writing the turn, or a writer quiet long enough to take over from. */
const RESUMABLE_ELSEWHERE = new Set(["done", "stopped", "quiet"]);

/** The footer and controls read a hosted session's status; a followed one fills in what its file says. */
function elsewhereStatus(session, follow) {
	return {
		sessionId: session.sessionId,
		cwd: session.cwd,
		sessionFile: session.path,
		sessionName: session.sessionName,
		model: session.model,
		thinkingLevel: session.thinkingLevel || "—",
		projectTrust: null,
		isStreaming: follow.state === "running" || follow.state === "quiet",
		isCompacting: false,
		retryAttempt: 0,
		queuedMessages: EMPTY_QUEUE,
		stats: null,
		contextUsage: null,
	};
}

export function createSessionController({
	msgsEl,
	queuedEl,
	pillEl,
	api,
	getClientId,
	onRefreshClient = async () => {},
	onStateChange,
	onCloseMenu,
	onSidebarClose,
	onSidebarRefresh,
	extensionUi = { applySnapshot() {}, handleEvent: () => false, reset() {} },
	createSession = (payload) => api.postJson("/api/sessions", payload),
	// canvas tiles show the tail of a transcript: { unfocused, focused } entries kept, pageSize per older page
	transcriptWindow = null,
}) {
	let activeSessionId = null;
	let activeState = null;
	let controllerClientId = null;
	let role = "viewer";
	let eventSource = null;
	let lastCliCommand = null;
	let shownTripwireAlertIds = new Set();

	let pendingPrompt = false;
	let renderedSessionId = null;
	let retryStatus = null;
	let compactionReason = null;
	let hasOlderMessages = false;
	let oldestEntryId = null;
	let olderLoading = false;
	let renderGeneration = 0;
	let activeSessionPath = null;
	let connection = "idle";
	let recoveryTimer = null;
	let recoveryAttempt = 0;
	let cursor = null;
	let lastFrameAtMs = 0;
	let focused = false;
	let lastScrollTop = 0;
	/** hosted: pi-web runs the session. elsewhere: another process writes it and this page follows the file. */
	let mode = "hosted";
	let follow = null;
	let followSession = null;
	let stoppingWriter = false;
	/** The session a read-only tail came from (a dormant canvas tile), so it can page back with no session open. */
	let readOnly = null;

	const chatView = createChatView({
		msgsEl,
		queuedEl,
		pillEl,
		onTrim: (oldest) => {
			if (!historySource()) return;
			hasOlderMessages = true;
			oldestEntryId = oldest;
			syncOlderControl();
		},
	});
	chatView.setWindow(windowSize());
	msgsEl.addEventListener("scroll", onScroll, { passive: true });
	const staleTimer = setInterval(() => {
		if (connection === "live" && isStale()) reconnectNow();
	}, STALE_CHECK_MS);

	/** Entries a windowed pane keeps (Infinity on the phone). */
	function windowSize() {
		if (!transcriptWindow) return Infinity;
		return focused ? transcriptWindow.focused : transcriptWindow.unfocused;
	}

	function onScroll() {
		const top = msgsEl.scrollTop;
		const scrolledUp = top < lastScrollTop;
		lastScrollTop = top;
		maybeLoadOlderMessages({ scrolledUp });
	}

	function closeEvents() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	}

	function setConnection(next) {
		if (connection === next) return;
		connection = next;
		onStateChange();
	}

	function stopRecovery() {
		if (recoveryTimer) clearTimeout(recoveryTimer);
		recoveryTimer = null;
		recoveryAttempt = 0;
	}

	function sessionUrl(sessionId, action, params = {}, path = activeSessionPath) {
		const query = new URLSearchParams();
		if (path) query.set("path", path);
		for (const [key, value] of Object.entries(params)) {
			if (typeof value === "string" && value) query.set(key, value);
		}
		const search = query.toString();
		return `/api/sessions/${encodeURIComponent(sessionId)}/${action}${search ? `?${search}` : ""}`;
	}

	function isStale() {
		return Date.now() - lastFrameAtMs > STALE_STREAM_MS;
	}

	/** Resumes from the last entry this page rendered, so the server sends only what is missing. */
	function connectEvents(sessionId) {
		readOnly = null;
		closeEvents();
		setConnection("connecting");
		const since = renderedSessionId === sessionId ? cursor : null;
		const limit = transcriptWindow ? String(windowSize()) : null;
		const source = api.eventSource(sessionUrl(sessionId, mode === "elsewhere" ? "follow" : "events", { since, limit }));
		eventSource = source;
		lastFrameAtMs = Date.now();
		source.onopen = () => {
			if (source !== eventSource) return;
			recoveryAttempt = 0;
			lastFrameAtMs = Date.now();
			setConnection("live");
		};
		source.addEventListener("ping", () => {
			if (source !== eventSource) return;
			lastFrameAtMs = Date.now();
		});
		source.onmessage = (msg) => {
			if (source !== eventSource) return;
			lastFrameAtMs = Date.now();
			if (msg.lastEventId) cursor = msg.lastEventId;
			handleSse(JSON.parse(msg.data));
		};
		source.onerror = () => {
			if (source !== eventSource) return;
			// EventSource retries network errors itself but gives up for good on HTTP errors.
			if (source.readyState === EventSource.CLOSED) {
				scheduleRecovery(sessionId);
			} else {
				setConnection("reconnecting");
			}
		};
	}

	function scheduleRecovery(sessionId, delayMs = Math.min(30_000, 1000 * 2 ** Math.min(recoveryAttempt, 5))) {
		closeEvents();
		setConnection("reconnecting");
		if (recoveryTimer) clearTimeout(recoveryTimer);
		recoveryAttempt += 1;
		recoveryTimer = setTimeout(() => void recoverEvents(sessionId), delayMs);
	}

	async function recoverEvents(sessionId) {
		recoveryTimer = null;
		if (sessionId !== activeSessionId) return;
		try {
			await onRefreshClient();
			await api.getJson(mode === "elsewhere" ? sessionUrl(sessionId, "transcript", { limit: "1" }) : sessionUrl(sessionId, "state"));
			if (sessionId !== activeSessionId) return;
			connectEvents(sessionId);
		} catch (error) {
			if (sessionId !== activeSessionId) return;
			if (error && error.status === 404) {
				closeEvents();
				stopRecovery();
				setConnection("gone");
				chatView.appendNotice("This session is no longer running. Open it again from the sidebar.", "error");
				return;
			}
			scheduleRecovery(sessionId);
		}
	}

	function reconnectNow() {
		if (!activeSessionId || activeSessionId === "replay") return;
		stopRecovery();
		connectEvents(activeSessionId);
	}

	/** Called when the page comes back: phones often keep a dead stream that never reports an error. */
	function resumeIfStale() {
		if (!activeSessionId || activeSessionId === "replay") return;
		if (connection === "gone" || connection === "idle" || connection === "suspended") return;
		if (connection === "reconnecting" && recoveryTimer) {
			scheduleRecovery(activeSessionId, 0);
			return;
		}
		if (connection === "live" && !isStale()) return;
		if (connection === "connecting" && !isStale()) return;
		reconnectNow();
	}

	function resetTripwireAlerts() {
		shownTripwireAlertIds = new Set();
	}

	function normalizeQueuedMessages(queuedMessages) {
		return {
			steering: Array.isArray(queuedMessages?.steering) ? queuedMessages.steering.filter((message) => typeof message === "string") : [],
			followUp: Array.isArray(queuedMessages?.followUp) ? queuedMessages.followUp.filter((message) => typeof message === "string") : [],
		};
	}

	function applyQueuedMessages(queuedMessages) {
		const normalized = normalizeQueuedMessages(queuedMessages);
		if (activeState) activeState.queuedMessages = normalized;
		chatView.renderQueuedMessages(normalized);
	}

	function firstEntryId(messages) {
		const first = (messages || []).find((message) => message && typeof message.entryId === "string");
		return first ? first.entryId : null;
	}

	function syncOlderControl(state = olderLoading ? "loading" : "idle") {
		chatView.setOlderControl(hasOlderMessages && oldestEntryId ? state : "none", () => void loadOlderMessages());
	}

	/**
	 * The phone loads earlier pages whenever the reader is near the top. A windowed pane only does when
	 * focused and the reader scrolls up themselves; otherwise its "earlier messages" button does.
	 */
	function maybeLoadOlderMessages({ scrolledUp = false } = {}) {
		if (!hasOlderMessages || olderLoading || !chatView.isNearTop()) return;
		if (transcriptWindow && !(focused && scrolledUp && !chatView.isPinned())) return;
		void loadOlderMessages();
	}

	/** Where earlier pages come from: the open session, or the file a read-only tail was read from. */
	function historySource() {
		if (activeSessionId) return activeSessionId === "replay" ? null : { sessionId: activeSessionId, path: activeSessionPath };
		return readOnly;
	}

	async function loadOlderMessages() {
		const source = historySource();
		if (olderLoading || !hasOlderMessages || !oldestEntryId || !source) return;
		const { sessionId } = source;
		const generation = renderGeneration;
		const stale = () => historySource()?.sessionId !== sessionId || generation !== renderGeneration;
		olderLoading = true;
		syncOlderControl();
		try {
			const limit = transcriptWindow ? String(transcriptWindow.pageSize) : null;
			const page = await api.getJson(sessionUrl(sessionId, "transcript", { before: oldestEntryId, limit }, source.path));
			if (stale()) return;
			const messages = Array.isArray(page?.messages) ? page.messages : [];
			hasOlderMessages = Boolean(page?.hasOlder) && messages.length > 0;
			chatView.prependHistory(messages, { hasOlder: hasOlderMessages });
			oldestEntryId = firstEntryId(messages) || oldestEntryId;
			olderLoading = false;
			syncOlderControl();
			maybeLoadOlderMessages();
		} catch (error) {
			if (stale()) return;
			console.error("Failed to load earlier messages", error);
			olderLoading = false;
			syncOlderControl("error");
		}
	}

	function replaceTranscript(transcript, live, { keepPosition = false } = {}) {
		const restoreTop = keepPosition && !chatView.isPinned() ? chatView.getScrollTop() : null;
		renderGeneration += 1;
		chatView.clear();
		chatView.renderHistory(transcript.messages);
		chatView.renderLive(live);
		hasOlderMessages = transcript.hasOlder;
		oldestEntryId = firstEntryId(transcript.messages);
		olderLoading = false;
		syncOlderControl();
		chatView.flush();
		if (restoreTop === null) {
			chatView.pin();
		} else {
			chatView.restoreScroll(restoreTop);
		}
		maybeLoadOlderMessages();
	}

	/** A reconnect within the same session: redraw only the unconfirmed tail and what was missed. */
	function appendTranscript(transcript, live) {
		const wasPinned = chatView.isPinned();
		chatView.dropProvisional();
		chatView.renderHistory(transcript.messages);
		chatView.renderLive(live);
		chatView.flush();
		if (wasPinned) chatView.pin();
	}

	function initTranscript(event) {
		if (event.transcript && typeof event.transcript === "object") {
			return {
				mode: event.transcript.mode === "append" ? "append" : "replace",
				messages: Array.isArray(event.transcript.messages) ? event.transcript.messages : [],
				hasOlder: Boolean(event.transcript.hasOlder),
			};
		}
		return { mode: "replace", messages: Array.isArray(event.state?.messages) ? event.state.messages : [], hasOlder: Boolean(event.state?.hasOlderMessages) };
	}

	function appendTripwireAlert(alert) {
		if (!alert || typeof alert.id !== "string") return;
		if (shownTripwireAlertIds.has(alert.id)) return;
		shownTripwireAlertIds.add(alert.id);

		const severity = alert.severity === "critical" ? "critical" : "observe";
		const category = typeof alert.category === "string" ? alert.category.replaceAll("_", " ") : "tripwire";
		const summary = typeof alert.summary === "string" ? alert.summary : "Tripwire alert";
		const detail = typeof alert.detail === "string" && alert.detail.trim() ? ` ${alert.detail.trim()}` : "";
		const label = alert.response === "blocked" ? "blocked" : severity;
		chatView.appendNotice(`[tripwire ${label}][${category}] ${summary}${detail}`, severity === "critical" ? "error" : "info");
	}

	async function loadTripwireAlerts(sessionId) {
		if (!sessionId || sessionId === "replay") return;
		try {
			const snapshot = await api.getJson(`/api/sessions/${encodeURIComponent(sessionId)}/tripwire-alerts`);
			const unreadAlerts = Array.isArray(snapshot?.unreadAlerts) ? snapshot.unreadAlerts : [];
			for (const alert of unreadAlerts) {
				appendTripwireAlert(alert);
			}
		} catch (error) {
			console.error("Failed to sync tripwire alerts", error);
		}
	}

	function getRunStatus() {
		if (!activeState) return { kind: "idle" };
		if (mode === "elsewhere") return activeState.isStreaming ? { kind: "elsewhere" } : { kind: "idle" };
		if (activeState.isCompacting) return { kind: "compacting", reason: compactionReason };
		if (retryStatus) return { kind: "retrying", ...retryStatus };
		if (activeState.isStreaming || pendingPrompt) return { kind: "working" };
		return { kind: "idle" };
	}

	function leaveElsewhere() {
		mode = "hosted";
		follow = null;
		followSession = null;
		stoppingWriter = false;
	}

	function reset() {
		closeEvents();
		stopRecovery();
		setConnection("idle");
		leaveElsewhere();
		readOnly = null;
		activeSessionPath = null;
		cursor = null;
		retryStatus = null;
		compactionReason = null;
		hasOlderMessages = false;
		oldestEntryId = null;
		renderGeneration += 1;
		activeSessionId = null;
		activeState = null;
		controllerClientId = null;
		role = "viewer";
		lastCliCommand = null;
		pendingPrompt = false;
		renderedSessionId = null;
		resetTripwireAlerts();
		extensionUi.reset();
		chatView.clear();
		chatView.appendNotice("No session selected.");
	}

	function applyFollowState(next) {
		follow = next && typeof next === "object" ? next : follow;
		if (activeState && follow) activeState.isStreaming = follow.state === "running" || follow.state === "quiet";
		if (follow?.state === "stopped") chatView.markPendingToolsAborted("Stopped: the pi running it is gone");
		if (follow?.state === "hosted") {
			leaveElsewhere();
			connectEvents(activeSessionId);
		}
		onStateChange();
	}

	/** The read-only view of a session another process writes: same transcript rendering, no controls. */
	function handleFollowSse(event) {
		if (event.type === "follow_init") {
			const transcript = initTranscript(event);
			const sameSession = renderedSessionId !== null && renderedSessionId === event.session?.sessionId;
			if (transcript.mode === "append" && !sameSession) {
				cursor = null;
				connectEvents(activeSessionId);
				return;
			}
			if (!sameSession) onCloseMenu();
			followSession = event.session;
			follow = event.follow;
			activeState = elsewhereStatus(followSession, follow);
			activeSessionPath = followSession.path || activeSessionPath;
			controllerClientId = null;
			role = "viewer";
			pendingPrompt = false;
			retryStatus = null;
			compactionReason = null;
			if (typeof event.cursor === "string") cursor = event.cursor;
			renderedSessionId = followSession.sessionId;
			if (transcript.mode === "append") {
				appendTranscript(transcript, null);
			} else {
				replaceTranscript(transcript, null, { keepPosition: sameSession });
			}
			applyQueuedMessages(EMPTY_QUEUE);
			applyFollowState(follow);
			return;
		}

		if (event.type === "follow_entries") {
			if (event.session && typeof event.session === "object") {
				followSession = event.session;
				if (activeState) Object.assign(activeState, elsewhereStatus(followSession, follow || { state: "running" }));
			}
			const wasPinned = chatView.isPinned();
			chatView.renderHistory(Array.isArray(event.messages) ? event.messages : []);
			chatView.flush();
			if (wasPinned) chatView.pin();
			onStateChange();
			return;
		}

		if (event.type === "follow_state") applyFollowState(event.follow);
	}

	function handleSse(event) {
		if (!event || typeof event.type !== "string") return;

		if (event.type.startsWith("follow_")) {
			if (mode === "elsewhere") handleFollowSse(event);
			return;
		}

		if (event.type === "init") {
			const transcript = initTranscript(event);
			const sameSession = renderedSessionId !== null && renderedSessionId === event.state?.sessionId;
			if (transcript.mode === "append" && !sameSession) {
				cursor = null;
				connectEvents(activeSessionId);
				return;
			}
			if (!sameSession) onCloseMenu();
			const { messages: _messages, hasOlderMessages: _hasOlder, ...status } = event.state;
			activeState = status;
			activeSessionPath = activeState.sessionFile || activeSessionPath;
			controllerClientId = event.controllerClientId || null;
			role = event.role;
			lastCliCommand = computeCliCommand(activeState) || lastCliCommand;
			if (typeof event.cursor === "string") cursor = event.cursor;
			const live = event.live && typeof event.live === "object" ? event.live : null;
			retryStatus = live?.retry ? { attempt: live.retry.attempt, maxAttempts: live.retry.maxAttempts } : null;
			compactionReason = live?.compaction?.reason ?? null;
			if (!activeState.isStreaming) pendingPrompt = false;

			renderedSessionId = activeState.sessionId;
			if (transcript.mode === "append") {
				appendTranscript(transcript, live);
			} else {
				replaceTranscript(transcript, live, { keepPosition: sameSession });
			}
			applyQueuedMessages(activeState.queuedMessages);
			extensionUi.applySnapshot(event.ui);
			onStateChange();
			if (activeSessionId) {
				void loadTripwireAlerts(activeSessionId);
			}
			return;
		}

		if (event.type.startsWith("extension_ui_")) {
			extensionUi.handleEvent(event);
			return;
		}

		if (event.type === "state_patch") {
			if (!activeState) return;
			if (event.patch && typeof event.patch === "object") {
				Object.assign(activeState, event.patch);
				if (event.patch.queuedMessages) applyQueuedMessages(event.patch.queuedMessages);
				onStateChange();
			}
			return;
		}

		if (event.type === "controller_changed") {
			controllerClientId = event.controllerClientId || null;
			role = controllerClientId === getClientId() ? "controller" : "viewer";
			onStateChange();
			return;
		}

		if (event.type === "released") {
			onCloseMenu();
			const cmd = lastCliCommand;
			closeEvents();
			stopRecovery();
			setConnection("idle");
			activeSessionPath = null;
			cursor = null;
			activeSessionId = null;
			activeState = null;
			controllerClientId = null;
			role = "viewer";
			renderedSessionId = null;
			resetTripwireAlerts();
			extensionUi.reset();
			chatView.renderQueuedMessages({ steering: [], followUp: [] });

			chatView.renderReleased({ cliCommand: cmd });
			onStateChange();
			onSidebarRefresh();
			return;
		}

		if (event.type === "tripwire_alert") {
			appendTripwireAlert(event.alert);
			return;
		}

		if (event.type === "command_error") {
			pendingPrompt = false;
			chatView.appendNotice(`Error: ${event.message || "command failed"}`, "error");
			onStateChange();
			return;
		}

		if (event.type === "agent_event") {
			handleAgentEvent(event.event, typeof event.entryId === "string" ? event.entryId : undefined);
			return;
		}
	}

	function handleAgentEvent(event, entryId) {
		if (!event || typeof event.type !== "string") return;

		if (event.type === "queue_update") {
			pendingPrompt = false;
			applyQueuedMessages({ steering: event.steering, followUp: event.followUp });
			onStateChange();
			return;
		}

		if (event.type === "turn_start") {
			pendingPrompt = false;
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "agent_start") {
			pendingPrompt = false;
			if (activeState) activeState.isStreaming = true;
			onStateChange();
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "agent_end") {
			pendingPrompt = false;
			onStateChange();
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "agent_settled") {
			if (activeState) {
				activeState.isStreaming = false;
				activeState.retryAttempt = 0;
			}
			pendingPrompt = false;
			retryStatus = null;
			onStateChange();
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "auto_retry_start") {
			retryStatus = { attempt: event.attempt, maxAttempts: event.maxAttempts };
			if (activeState) activeState.retryAttempt = event.attempt;
			const seconds = Math.max(1, Math.round(Number(event.delayMs || 0) / 1000));
			const reason = typeof event.errorMessage === "string" && event.errorMessage.trim() ? `: ${event.errorMessage.trim()}` : "";
			chatView.appendNotice(`Retrying in ${seconds}s (attempt ${event.attempt}/${event.maxAttempts})${reason}`);
			onStateChange();
			return;
		}

		if (event.type === "auto_retry_end") {
			retryStatus = null;
			if (activeState) activeState.retryAttempt = 0;
			if (!event.success) {
				chatView.appendNotice(`Retry failed: ${event.finalError || "unknown error"}`, "error");
			}
			onStateChange();
			return;
		}

		if (event.type === "summarization_retry_scheduled") {
			const seconds = Math.max(1, Math.round(Number(event.delayMs || 0) / 1000));
			chatView.appendNotice(`Summary failed, retrying in ${seconds}s (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage || "unknown error"}`);
			return;
		}

		if (event.type === "session_info_changed") {
			if (activeState) activeState.sessionName = event.name;
			onStateChange();
			return;
		}

		if (event.type === "thinking_level_changed") {
			if (activeState) activeState.thinkingLevel = event.level;
			onStateChange();
			return;
		}

		if (event.type === "compaction_start") {
			if (activeState) activeState.isCompacting = true;
			compactionReason = typeof event.reason === "string" ? event.reason : null;
			onStateChange();
			return;
		}

		if (event.type === "compaction_end") {
			if (activeState) activeState.isCompacting = false;
			compactionReason = null;
			onStateChange();
			if (event.result && typeof event.result === "object") {
				const summary = { role: "compactionSummary", summary: event.result.summary, tokensBefore: event.result.tokensBefore, timestamp: Date.now() };
				chatView.appendCompactionSummary(summary, entryId);
			} else if (event.aborted) {
				chatView.appendNotice("Error: compaction cancelled", "error");
			} else {
				chatView.appendNotice(event.errorMessage || "Compaction failed", "error");
			}
			return;
		}

		if (event.type === "message_start") {
			if (event.message && event.message.role === "assistant") {
				pendingPrompt = false;
				chatView.handleAgentEvent(event, entryId);
				return;
			}
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "message_update") {
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "message_end") {
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "tool_execution_start") {
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "tool_execution_update") {
			chatView.handleAgentEvent(event, entryId);
			return;
		}

		if (event.type === "tool_execution_end") {
			chatView.handleAgentEvent(event, entryId);
			return;
		}
	}

	function waitForReplayContinue() {
		chatView.flush();
		document.documentElement.dataset.replayPaused = "1";
		return new Promise((resolve) => {
			window.addEventListener(
				"pi-replay-continue",
				() => {
					delete document.documentElement.dataset.replayPaused;
					resolve();
				},
				{ once: true },
			);
		});
	}

	async function runReplay(name) {
		const safeName = name.trim();
		if (!safeName) return;

		onCloseMenu();
		closeEvents();
		activeSessionId = null;
		activeState = null;
		controllerClientId = null;
		role = "viewer";
		renderedSessionId = null;
		cursor = null;
		resetTripwireAlerts();

		chatView.clear();
		chatView.appendNotice(`Loading replay: ${safeName}`);

		try {
			const res = await fetch(`/fixtures/${encodeURIComponent(safeName)}.json`, { headers: api.headers() });
			if (!res.ok) {
				throw new Error(`${res.status} ${res.statusText}`);
			}
			const events = await res.json();
			if (!Array.isArray(events)) {
				throw new Error("Invalid replay fixture (expected JSON array)");
			}

			chatView.clear();
			const init = events.find((ev) => ev && typeof ev === "object" && ev.type === "init");
			if (init && init.state && typeof init.state.sessionId === "string") {
				activeSessionId = init.state.sessionId;
			} else {
				activeSessionId = "replay";
			}

			for (const ev of events) {
				if (ev && typeof ev === "object" && ev.type === "replay_pause") {
					await waitForReplayContinue();
					continue;
				}
				if (ev && typeof ev === "object" && ev.type === "init") {
					handleSse({
						...ev,
						yourClientId: getClientId(),
						controllerClientId: getClientId(),
						role: "controller",
					});
					continue;
				}
				handleSse(ev);
			}
		} catch (error) {
			chatView.clear();
			chatView.appendNotice(`Replay failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			chatView.flush();
			document.documentElement.dataset.replayDone = "1";
		}
	}

	/** Follows a session another process is writing, read-only, until its turn closes or its writer is gone. */
	function openElsewhere(sessionId, path, elsewhere) {
		if (sessionId !== activeSessionId) renderedSessionId = null;
		mode = "elsewhere";
		follow = elsewhere && typeof elsewhere === "object" ? { ...elsewhere } : null;
		followSession = null;
		stoppingWriter = false;
		activeSessionId = sessionId;
		activeSessionPath = path;
		controllerClientId = null;
		role = "viewer";
		connectEvents(sessionId);
		onSidebarClose();
		onStateChange();
	}

	/** For a pane that already knows the session is another pi's (a canvas tile): follow it, whatever its file says now. */
	function followElsewhere(sessionId, path, elsewhere) {
		stopRecovery();
		resetTripwireAlerts();
		if (sessionId !== activeSessionId) extensionUi.reset();
		openElsewhere(sessionId, path, elsewhere);
	}

	function isRunningElsewhereError(error) {
		return Boolean(error && error.status === 409 && error.body && typeof error.body.elsewhere === "object");
	}

	async function selectSession(session) {
		stopRecovery();
		resetTripwireAlerts();
		if (session.id !== activeSessionId) extensionUi.reset();
		if (session.isRunning) {
			leaveElsewhere();
			activeSessionId = session.id;
			activeSessionPath = session.path || null;
			connectEvents(activeSessionId);
			onSidebarClose();
			onStateChange();
			return;
		}

		if (!session.path) {
			throw new Error("Missing session path");
		}

		if (session.elsewhere && session.elsewhere.state !== "stopped") {
			openElsewhere(session.id, session.path, session.elsewhere);
			return;
		}

		let result;
		try {
			result = await createSession({ clientId: getClientId(), resumeSessionPath: session.path });
		} catch (error) {
			if (!isRunningElsewhereError(error)) throw error;
			openElsewhere(session.id, session.path, error.body.elsewhere);
			return;
		}
		leaveElsewhere();
		activeSessionId = result.sessionId;
		activeSessionPath = session.path;
		connectEvents(activeSessionId);
		onSidebarClose();
		onStateChange();
	}

	function canResumeHere() {
		return mode === "elsewhere" && Boolean(activeSessionPath) && Boolean(follow) && RESUMABLE_ELSEWHERE.has(follow.state) && !stoppingWriter;
	}

	function canStopWriter() {
		return mode === "elsewhere" && Boolean(follow) && (follow.state === "running" || follow.state === "quiet") && !stoppingWriter;
	}

	/**
	 * Opens the followed session here as a hosted one. The transcript on screen is the same file, so the
	 * event stream resumes from the entry this page already shows.
	 */
	async function resumeHere() {
		if (!canResumeHere()) throw new Error("Another pi is still writing this session. Esc stops it.");
		const sessionId = activeSessionId;
		let result;
		try {
			result = await createSession({ clientId: getClientId(), resumeSessionPath: activeSessionPath, takeOver: follow.state === "quiet" });
		} catch (error) {
			if (isRunningElsewhereError(error) && sessionId === activeSessionId) applyFollowState({ ...error.body.elsewhere });
			throw error;
		}
		if (sessionId !== activeSessionId || mode !== "elsewhere") return;
		leaveElsewhere();
		activeSessionId = result.sessionId;
		connectEvents(activeSessionId);
		onStateChange();
		onSidebarRefresh();
	}

	/** Esc in a followed session: stop the pi writing it, so the session can be continued here. */
	async function stopWriter() {
		if (!canStopWriter()) return;
		const sessionId = activeSessionId;
		stoppingWriter = true;
		onStateChange();
		try {
			const result = await api.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/stop-elsewhere`, { path: activeSessionPath });
			if (sessionId !== activeSessionId || mode !== "elsewhere") return;
			const pids = Array.isArray(result?.stopped) ? result.stopped : [];
			chatView.appendNotice(pids.length > 0 ? `Stopped pi (pid ${pids.join(", ")}). Type to continue here.` : "Nothing was writing it any more. Type to continue here.");
			stoppingWriter = false;
			applyFollowState({ ...follow, state: "stopped", writers: [] });
		} finally {
			stoppingWriter = false;
			onStateChange();
		}
	}

	async function compact(customInstructions) {
		if (!activeSessionId) return;
		if (activeState) {
			activeState.isCompacting = true;
			activeState.isStreaming = false;
		}
		pendingPrompt = false;
		onStateChange();
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
				type: "compact",
				clientId: getClientId(),
				customInstructions,
			});
		} catch (error) {
			if (activeState?.isCompacting) activeState.isCompacting = false;
			const message = error instanceof Error ? error.message : String(error);
			chatView.appendNotice(message, "error");
			onStateChange();
		}
	}

	async function sendPrompt(text) {
		if (!activeSessionId) return;
		if (mode === "elsewhere") {
			if (!String(text || "").trim()) return;
			await resumeHere();
			if (mode === "elsewhere") throw new Error("Not resumed here.");
		}
		const compactInstructions = parseCompactCommand(text);
		if (compactInstructions !== null) {
			await compact(compactInstructions);
			return;
		}
		const queuedText = parseQueueCommand(text);
		const promptText = queuedText !== null ? queuedText : text;
		if (!String(promptText || "").trim()) return;
		pendingPrompt = true;
		chatView.pin();
		onStateChange();
		let result;
		try {
			result = await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
				type: "prompt",
				clientId: getClientId(),
				text: promptText,
				deliverAs: queuedText !== null ? "followUp" : "steer",
			});
		} catch (error) {
			pendingPrompt = false;
			onStateChange();
			throw error;
		}
		if (result && typeof result.disposition === "string" && result.disposition !== "started") {
			pendingPrompt = false;
			onStateChange();
		}
	}

	async function abortRun() {
		if (!activeSessionId) return;
		if (mode === "elsewhere") {
			await stopWriter();
			return;
		}
		const hadPendingTools = chatView.hasPendingTools();
		const hadAssistant = chatView.hasAssistant();
		const hadStreaming = Boolean(activeState?.isStreaming);
		const hadCompacting = Boolean(activeState?.isCompacting);
		const shouldShowNotice = Boolean(hadStreaming || pendingPrompt || hadAssistant || hadPendingTools);
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, { type: "abort", clientId: getClientId() });
		pendingPrompt = false;
		onStateChange();

		if (hadCompacting) return;
		chatView.markPendingToolsAborted("Operation aborted");

		if (shouldShowNotice && !hadPendingTools && !hadAssistant && !hadStreaming) {
			chatView.appendNotice("Operation aborted", "error");
		}
	}

	async function takeOver() {
		if (!activeSessionId) return;
		if (mode === "elsewhere") {
			await resumeHere();
			return;
		}
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId: getClientId() });
	}

	async function release() {
		if (!activeSessionId || mode === "elsewhere") return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/release`, { clientId: getClientId() });
	}

	/**
	 * Offscreen canvas tiles drop their stream so the server can evict idle sessions; resume() picks up
	 * from the cursor, so only what was missed comes back.
	 */
	function suspend() {
		if (!activeSessionId || activeSessionId === "replay") return;
		if (connection === "gone" || connection === "suspended") return;
		closeEvents();
		stopRecovery();
		setConnection("suspended");
	}

	function resume() {
		if (!activeSessionId || activeSessionId === "replay") return;
		if (connection !== "suspended") return;
		connectEvents(activeSessionId);
	}

	/** For panes that go away (canvas tiles): stop timers and the stream; late async work sees no session. */
	function destroy() {
		clearInterval(staleTimer);
		closeEvents();
		stopRecovery();
		readOnly = null;
		activeSessionId = null;
		renderGeneration += 1;
	}

	/**
	 * The tail of a session that isn't running, read from its file (no stream): a dormant canvas tile shows
	 * what the session was doing until you resume it. Given the session it came from (`source`), earlier
	 * pages load from the file too.
	 */
	function showReadOnly(page, notice, source = null) {
		if (activeSessionId) return;
		renderGeneration += 1;
		readOnly = source && typeof source.sessionId === "string" && typeof source.path === "string" ? { sessionId: source.sessionId, path: source.path } : null;
		const messages = Array.isArray(page?.messages) ? page.messages : [];
		chatView.clear();
		chatView.renderHistory(messages);
		hasOlderMessages = Boolean(readOnly) && Boolean(page?.hasOlder) && messages.length > 0;
		oldestEntryId = hasOlderMessages ? firstEntryId(messages) : null;
		olderLoading = false;
		syncOlderControl();
		if (notice) chatView.appendNotice(notice);
		chatView.flush();
		chatView.pin();
	}

	/** A focused canvas tile keeps more of its transcript and loads earlier pages as you scroll up. */
	function setFocused(next) {
		focused = Boolean(next);
		chatView.setWindow(windowSize());
	}

	function openSessionId(sessionId) {
		stopRecovery();
		resetTripwireAlerts();
		if (sessionId !== activeSessionId) extensionUi.reset();
		leaveElsewhere();
		activeSessionId = sessionId;
		activeSessionPath = null;
		connectEvents(activeSessionId);
		onStateChange();
	}

	return {
		getActiveSessionId: () => activeSessionId,
		getActiveState: () => activeState,
		getControllerClientId: () => controllerClientId,
		getRole: () => role,
		getPendingPrompt: () => pendingPrompt,
		getRunStatus,
		getConnection: () => connection,
		getMode: () => mode,
		getFollow: () => follow,
		canResumeHere,
		canStopWriter,
		isController: () => Boolean(activeSessionId && mode === "hosted" && controllerClientId === getClientId()),
		appendNotice: chatView.appendNotice,
		reset,
		runReplay,
		resumeIfStale,
		selectSession,
		followElsewhere,
		sendPrompt,
		abortRun,
		takeOver,
		release,
		openSessionId,
		suspend,
		resume,
		destroy,
		setFocused,
		showReadOnly,
		getShownEntryCount: () => chatView.entryCount(),
	};
}
