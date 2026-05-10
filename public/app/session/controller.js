import { computeCliCommand } from "./cli.js";
import { createChatView } from "./chat_view.js";

export function createSessionController({
	msgsEl,
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

	let pendingPrompt = false;

	const chatView = createChatView({ msgsEl, isPhoneLikeFn });

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

	function resetTripwireAlerts() {
		shownTripwireAlertIds = new Set();
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
		activeSessionId = null;
		activeState = null;
		controllerClientId = null;
		role = "viewer";
		lastCliCommand = null;
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

			chatView.clear();
			chatView.renderHistory(activeState.messages || []);
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
			activeSessionId = null;
			activeState = null;
			controllerClientId = null;
			role = "viewer";
			resetTripwireAlerts();

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

	async function selectSession(session) {
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

	async function sendPrompt(text) {
		if (!activeSessionId) return;
		pendingPrompt = true;
		onStateChange();
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
				type: "prompt",
				clientId: getClientId(),
				text,
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
		const shouldShowNotice = Boolean(hadStreaming || pendingPrompt || hadAssistant || hadPendingTools);
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, { type: "abort", clientId: getClientId() });
		pendingPrompt = false;
		onStateChange();

		// Mirror TUI: pending tools become error on abort.
		chatView.markPendingToolsAborted("Operation aborted");

		// If there was nothing else to render (abort before streaming starts), show a notice.
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
		selectSession,
		sendPrompt,
		abortRun,
		takeOver,
		release,
		openSessionId,
	};
}
