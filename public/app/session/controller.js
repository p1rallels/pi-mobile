import { computeCliCommand } from "./cli.js";
import { createChatView } from "./chat_view.js";

export function createSessionController({
	msgsEl,
	api,
	clientId,
	token,
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

		const qs = new URLSearchParams({ clientId });
		if (token) qs.set("token", token);

		eventSource = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events?${qs.toString()}`);
		eventSource.onmessage = (msg) => {
			const payload = JSON.parse(msg.data);
			handleSse(payload);
		};
		eventSource.onerror = () => {
			// Browser will auto-retry; keep UI stable.
		};
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
			role = controllerClientId === clientId ? "controller" : "viewer";
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

			chatView.renderReleased({ cliCommand: cmd });
			onStateChange();
			onSidebarRefresh();
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
						yourClientId: clientId,
						controllerClientId: clientId,
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

		const result = await api.postJson("/api/sessions", { clientId, resumeSessionPath: session.path });
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
				clientId,
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
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, { type: "abort", clientId });
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
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId });
	}

	async function release() {
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/release`, { clientId });
	}

	function openSessionId(sessionId) {
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
		isController: () => Boolean(activeSessionId && controllerClientId === clientId),
		appendNotice: chatView.appendNotice,
		runReplay,
		selectSession,
		sendPrompt,
		abortRun,
		takeOver,
		release,
		openSessionId,
	};
}
