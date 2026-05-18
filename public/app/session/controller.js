import { computeCliCommand } from "./cli.js";
import { createChatView } from "./chat_view.js";
import { parseCompactCommand, parseQueueCommand } from "./commands.js";

export function createSessionController({
	msgsEl,
	queuedEl,
	api,
	getClientId,
	isPhoneLikeFn,
	onStateChange,
	onCloseMenu,
	onSidebarClose,
	onSidebarRefresh,
}) {
	let activeSessionId = null;
	let activeState = null;
	let controllerClientId = null;
	let role = "viewer";
	let eventSource = null;
	let lastCliCommand = null;
	let shownTripwireAlertIds = new Set();
	let pendingCompactionSummary = null;
	let syncInFlight = false;
	let followUpSyncTimer = null;

	let pendingPrompt = false;

	const chatView = createChatView({ msgsEl, queuedEl, isPhoneLikeFn });

	function closeEvents() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	}

	function connectEvents(sessionId) {
		closeEvents();
		eventSource = api.eventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
		eventSource.onmessage = (msg) => {
			const payload = JSON.parse(msg.data);
			handleSse(payload);
		};
		eventSource.onerror = () => {
			// Browser will auto-retry; keep UI stable.
		};
	}

	function clearFollowUpSync() {
		if (!followUpSyncTimer) return;
		clearTimeout(followUpSyncTimer);
		followUpSyncTimer = null;
	}

	function scheduleFollowUpSync(delayMs = 1500) {
		if (followUpSyncTimer || !activeSessionId || activeSessionId === "replay") return;
		followUpSyncTimer = setTimeout(() => {
			followUpSyncTimer = null;
			if (document.visibilityState === "hidden") return;
			void syncState();
		}, delayMs);
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

	function compactionMatches(message, pending) {
		return (
			message &&
			pending &&
			message.role === "compactionSummary" &&
			message.summary === pending.summary &&
			message.tokensBefore === pending.tokensBefore
		);
	}

	function applyQueuedMessages(queuedMessages) {
		const normalized = normalizeQueuedMessages(queuedMessages);
		if (activeState) activeState.queuedMessages = normalized;
		chatView.renderQueuedMessages(normalized);
	}

	function messageFingerprint(message) {
		if (!message || typeof message !== "object") return "";
		const role = typeof message.role === "string" ? message.role : "";
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : "";
		const summary = typeof message.summary === "string" ? message.summary.length : "";
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
		return `${role}:${timestamp}:${summary}:${stopReason}`;
	}

	function messagesChanged(previousMessages, nextMessages) {
		if (!Array.isArray(previousMessages) || !Array.isArray(nextMessages)) return true;
		if (previousMessages.length !== nextMessages.length) return true;
		return messageFingerprint(previousMessages[previousMessages.length - 1]) !== messageFingerprint(nextMessages[nextMessages.length - 1]);
	}

	function renderStateMessages(messages) {
		chatView.clear();
		chatView.renderHistory(messages || []);
		if (pendingCompactionSummary && !(messages || []).some((message) => compactionMatches(message, pendingCompactionSummary))) {
			chatView.appendCompactionSummary(pendingCompactionSummary);
		}
		pendingCompactionSummary = null;
		applyQueuedMessages(activeState?.queuedMessages);
		chatView.scrollToBottom();
	}

	function appendTripwireAlert(alert) {
		if (!alert || typeof alert.id !== "string") return;
		if (shownTripwireAlertIds.has(alert.id)) return;
		shownTripwireAlertIds.add(alert.id);

		const severity = alert.severity === "critical" ? "critical" : "observe";
		const category = typeof alert.category === "string" ? alert.category.replaceAll("_", " ") : "tripwire";
		const summary = typeof alert.summary === "string" ? alert.summary : "Tripwire alert";
		const detail = typeof alert.detail === "string" && alert.detail.trim() ? ` ${alert.detail.trim()}` : "";
		chatView.appendNotice(`[tripwire ${severity}][${category}] ${summary}${detail}`, severity === "critical" ? "error" : "info");
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

	function reset() {
		closeEvents();
		clearFollowUpSync();
		activeSessionId = null;
		activeState = null;
		controllerClientId = null;
		role = "viewer";
		lastCliCommand = null;
		pendingCompactionSummary = null;
		pendingPrompt = false;
		resetTripwireAlerts();
		chatView.clear();
		chatView.appendNotice("No session selected.");
	}

	function handleSse(event) {
		if (!event || typeof event.type !== "string") return;

		if (event.type === "init") {
			onCloseMenu();
			activeState = event.state;
			controllerClientId = event.controllerClientId || null;
			role = event.role;
			lastCliCommand = computeCliCommand(activeState) || lastCliCommand;

			renderStateMessages(activeState.messages || []);
			onStateChange();
			if (activeSessionId) {
				void loadTripwireAlerts(activeSessionId);
			}
			chatView.scrollToBottom();
			return;
		}

		if (event.type === "state_patch") {
			if (!activeState) return;
			if (event.patch && typeof event.patch === "object") {
				Object.assign(activeState, event.patch);
				if (Array.isArray(event.patch.messages)) {
					renderStateMessages(event.patch.messages);
				} else if (event.patch.queuedMessages) {
					applyQueuedMessages(event.patch.queuedMessages);
				}
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
			clearFollowUpSync();
			activeSessionId = null;
			activeState = null;
			controllerClientId = null;
			role = "viewer";
			resetTripwireAlerts();
			pendingCompactionSummary = null;
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

		if (event.type === "agent_event") {
			handleAgentEvent(event.event);
			return;
		}
	}

	function handleAgentEvent(event) {
		if (!event || typeof event.type !== "string") return;

		if (event.type === "queue_update") {
			pendingPrompt = false;
			applyQueuedMessages({ steering: event.steering, followUp: event.followUp });
			onStateChange();
			return;
		}

		if (event.type === "turn_start") {
			pendingPrompt = false;
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "agent_start") {
			pendingPrompt = false;
			if (activeState) activeState.isStreaming = true;
			onStateChange();
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "agent_end") {
			if (activeState) activeState.isStreaming = false;
			pendingPrompt = false;
			onStateChange();
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "compaction_start") {
			if (activeState) {
				activeState.isCompacting = true;
				activeState.isStreaming = false;
			}
			pendingPrompt = false;
			scheduleFollowUpSync();
			onStateChange();
			return;
		}

		if (event.type === "compaction_end") {
			clearFollowUpSync();
			if (activeState) {
				activeState.isCompacting = false;
				activeState.isStreaming = false;
			}
			pendingPrompt = false;
			onStateChange();
			if (event.result && typeof event.result === "object") {
				pendingCompactionSummary = {
					role: "compactionSummary",
					summary: event.result.summary,
					tokensBefore: event.result.tokensBefore,
					timestamp: Date.now(),
				};
				chatView.appendCompactionSummary(pendingCompactionSummary);
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
				chatView.handleAgentEvent(event);
				return;
			}
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "message_update") {
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "message_end") {
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "tool_execution_start") {
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "tool_execution_update") {
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "tool_execution_end") {
			chatView.handleAgentEvent(event);
			return;
		}
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
		pendingCompactionSummary = null;
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
			document.documentElement.dataset.replayDone = "1";
		}
	}

	async function syncState() {
		if (!activeSessionId || activeSessionId === "replay" || syncInFlight) return;
		syncInFlight = true;
		try {
			const previousState = activeState;
			const state = await api.getJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/state`);
			activeState = state;
			lastCliCommand = computeCliCommand(activeState) || lastCliCommand;
			const shouldRenderMessages =
				!activeState.isStreaming &&
				!activeState.isCompacting &&
				(Boolean(previousState?.isCompacting) || messagesChanged(previousState?.messages, activeState.messages));
			if (shouldRenderMessages) {
				renderStateMessages(activeState.messages || []);
			} else {
				applyQueuedMessages(activeState.queuedMessages);
			}
			onStateChange();
			if (activeState?.isCompacting) scheduleFollowUpSync();
		} catch (error) {
			console.error("Failed to sync session state", error);
			if (activeState?.isCompacting) scheduleFollowUpSync(3000);
		} finally {
			syncInFlight = false;
		}
	}

	async function selectSession(session) {
		clearFollowUpSync();
		pendingCompactionSummary = null;
		resetTripwireAlerts();
		if (session.isRunning) {
			activeSessionId = session.id;
			connectEvents(activeSessionId);
			onSidebarClose();
			onStateChange();
			return;
		}

		if (!session.path) {
			throw new Error("Missing session path");
		}

		const result = await api.postJson("/api/sessions", { clientId: getClientId(), resumeSessionPath: session.path });
		activeSessionId = result.sessionId;
		connectEvents(activeSessionId);
		onSidebarClose();
		onStateChange();
	}

	async function compact(customInstructions) {
		if (!activeSessionId) return;
		if (activeState) {
			activeState.isCompacting = true;
			activeState.isStreaming = false;
		}
		pendingPrompt = false;
		scheduleFollowUpSync();
		onStateChange();
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
				type: "compact",
				clientId: getClientId(),
				customInstructions,
			});
		} catch (error) {
			clearFollowUpSync();
			if (activeState?.isCompacting) activeState.isCompacting = false;
			const message = error instanceof Error ? error.message : String(error);
			chatView.appendNotice(message, "error");
			onStateChange();
		}
	}

	async function sendPrompt(text) {
		if (!activeSessionId) return;
		const compactInstructions = parseCompactCommand(text);
		if (compactInstructions !== null) {
			await compact(compactInstructions);
			return;
		}
		const queuedText = parseQueueCommand(text);
		const promptText = queuedText !== null ? queuedText : text;
		if (!String(promptText || "").trim()) return;
		pendingPrompt = true;
		onStateChange();
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
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
	}

	async function abortRun() {
		if (!activeSessionId) return;
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
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId: getClientId() });
	}

	async function release() {
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/release`, { clientId: getClientId() });
	}

	function openSessionId(sessionId) {
		clearFollowUpSync();
		pendingCompactionSummary = null;
		resetTripwireAlerts();
		activeSessionId = sessionId;
		connectEvents(activeSessionId);
		onStateChange();
	}

	return {
		getActiveSessionId: () => activeSessionId,
		getActiveState: () => activeState,
		getControllerClientId: () => controllerClientId,
		getRole: () => role,
		getPendingPrompt: () => pendingPrompt,
		isController: () => Boolean(activeSessionId && controllerClientId === getClientId()),
		appendNotice: chatView.appendNotice,
		reset,
		runReplay,
		syncState,
		selectSession,
		sendPrompt,
		abortRun,
		takeOver,
		release,
		openSessionId,
	};
}
