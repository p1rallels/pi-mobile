const DEFAULT_TITLE = "pi";

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function secondsLeft(expiresAt) {
	return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

/** One line per status, joined like the pi TUI footer. */
export function formatStatuses(statuses) {
	return Object.entries(statuses || {})
		.filter(([, text]) => typeof text === "string" && text.trim())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text.trim())
		.join(" · ");
}

/**
 * Shows what extensions ask through ctx.ui: dialogs answered by POST from any device (first answer wins),
 * footer statuses, text widgets around the composer, notifications and the page title.
 */
export function createExtensionUi({ api, getSessionId, onNotice, onEditorText, statusEl, aboveEl, belowEl }) {
	let dialogs = [];
	let chrome = { statuses: {}, widgets: {}, title: null };
	let overlay = null;
	let shownId = null;
	let countdown = null;
	let refreshMeta = () => {};

	function stopCountdown() {
		if (countdown) clearInterval(countdown);
		countdown = null;
	}

	function closeOverlay() {
		stopCountdown();
		overlay?.remove();
		overlay = null;
		shownId = null;
		refreshMeta = () => {};
	}

	async function answer(request, response, errorEl) {
		const sessionId = getSessionId();
		if (!sessionId) return;
		for (const button of overlay?.querySelectorAll("button") ?? []) button.disabled = true;
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/ui-response`, { id: request.id, ...response });
			removeDialog(request.id);
		} catch (error) {
			if (error && error.status === 410) {
				removeDialog(request.id);
				return;
			}
			for (const button of overlay?.querySelectorAll("button") ?? []) button.disabled = false;
			errorEl.textContent = error instanceof Error ? error.message : String(error);
		}
	}

	function dialogBody(request, card, errorEl) {
		const submitValue = (value) => void answer(request, { value }, errorEl);
		const actions = el("div", "ext-dialog-actions");
		const cancel = el("button", "ext-dialog-btn", "Cancel");
		cancel.type = "button";
		cancel.addEventListener("click", () => void answer(request, { cancelled: true }, errorEl));

		if (request.method === "select") {
			const list = el("div", "ext-dialog-options");
			for (const option of Array.isArray(request.options) ? request.options : []) {
				const button = el("button", "ext-dialog-option", option);
				button.type = "button";
				button.addEventListener("click", () => submitValue(option));
				list.appendChild(button);
			}
			card.appendChild(list);
			actions.appendChild(cancel);
			return { actions, focus: list.querySelector("button") };
		}

		if (request.method === "confirm") {
			if (request.message) card.appendChild(el("div", "ext-dialog-message", request.message));
			const no = el("button", "ext-dialog-btn", "No");
			no.type = "button";
			no.addEventListener("click", () => void answer(request, { confirmed: false }, errorEl));
			const yes = el("button", "ext-dialog-btn primary", "Yes");
			yes.type = "button";
			yes.addEventListener("click", () => void answer(request, { confirmed: true }, errorEl));
			actions.append(no, yes);
			return { actions, focus: yes };
		}

		const multiline = request.method === "editor";
		const field = el(multiline ? "textarea" : "input", "ext-dialog-field");
		if (multiline) {
			field.rows = 10;
			field.value = typeof request.prefill === "string" ? request.prefill : "";
		} else {
			field.type = "text";
			field.placeholder = typeof request.placeholder === "string" ? request.placeholder : "";
		}
		field.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.isComposing) return;
			if (multiline && !(event.metaKey || event.ctrlKey)) return;
			event.preventDefault();
			submitValue(field.value);
		});
		card.appendChild(field);
		const ok = el("button", "ext-dialog-btn primary", "Submit");
		ok.type = "button";
		ok.addEventListener("click", () => submitValue(field.value));
		actions.append(cancel, ok);
		return { actions, focus: field };
	}

	function showNext() {
		const request = dialogs[0];
		if (!request) {
			closeOverlay();
			return;
		}
		if (shownId === request.id) {
			refreshMeta();
			return;
		}
		closeOverlay();
		shownId = request.id;

		overlay = el("div", "ext-dialog-overlay");
		overlay.dataset.dialogId = request.id;
		const card = el("div", "ext-dialog-card");
		card.setAttribute("role", "dialog");
		card.setAttribute("aria-modal", "true");
		card.appendChild(el("div", "ext-dialog-title", request.title || "Extension"));
		const errorEl = el("div", "ext-dialog-error");
		const { actions, focus } = dialogBody(request, card, errorEl);
		const meta = el("div", "ext-dialog-meta");
		refreshMeta = () => {
			const parts = [];
			const queued = dialogs.length - 1;
			if (typeof request.expiresAt === "number") parts.push(`closes in ${secondsLeft(request.expiresAt)}s`);
			if (queued > 0) parts.push(`${queued} more waiting`);
			meta.textContent = parts.join(" · ");
		};
		refreshMeta();
		if (typeof request.expiresAt === "number") countdown = setInterval(() => refreshMeta(), 1000);
		card.append(errorEl, actions, meta);
		overlay.appendChild(card);
		document.body.appendChild(overlay);
		focus?.focus();
	}

	function removeDialog(id) {
		dialogs = dialogs.filter((dialog) => dialog.id !== id);
		if (shownId === id) closeOverlay();
		showNext();
	}

	function renderWidgets() {
		const render = (container, placement) => {
			if (!container) return;
			container.textContent = "";
			const widgets = Object.entries(chrome.widgets || {})
				.filter(([, widget]) => widget && widget.placement === placement && Array.isArray(widget.lines))
				.sort(([a], [b]) => a.localeCompare(b));
			for (const [key, widget] of widgets) {
				const block = el("div", "ext-widget", widget.lines.join("\n"));
				block.dataset.widgetKey = key;
				container.appendChild(block);
			}
			container.hidden = widgets.length === 0;
		};
		render(aboveEl, "aboveEditor");
		render(belowEl, "belowEditor");
	}

	function renderChrome() {
		if (statusEl) {
			const text = formatStatuses(chrome.statuses);
			statusEl.textContent = text;
			statusEl.hidden = !text;
		}
		renderWidgets();
		document.title = chrome.title || DEFAULT_TITLE;
	}

	function applyChrome(next) {
		chrome = {
			statuses: next && typeof next.statuses === "object" && next.statuses ? next.statuses : {},
			widgets: next && typeof next.widgets === "object" && next.widgets ? next.widgets : {},
			title: next && typeof next.title === "string" ? next.title : null,
		};
		renderChrome();
	}

	/** The init snapshot is authoritative: dialogs answered elsewhere while disconnected disappear here. */
	function applySnapshot(snapshot) {
		applyChrome(snapshot);
		dialogs = Array.isArray(snapshot?.dialogs) ? snapshot.dialogs.filter((dialog) => dialog && typeof dialog.id === "string") : [];
		if (shownId && !dialogs.some((dialog) => dialog.id === shownId)) closeOverlay();
		showNext();
	}

	function handleEvent(event) {
		switch (event.type) {
			case "extension_ui_request":
				if (event.request && typeof event.request.id === "string" && !dialogs.some((dialog) => dialog.id === event.request.id)) {
					dialogs = [...dialogs, event.request];
					showNext();
				}
				return true;
			case "extension_ui_closed":
				removeDialog(event.id);
				return true;
			case "extension_ui_chrome":
				applyChrome(event.chrome);
				return true;
			case "extension_ui_notify":
				onNotice(event.message, event.notifyType === "error" ? "error" : "info");
				return true;
			case "extension_ui_editor_text":
				if (typeof event.text === "string") onEditorText(event.text);
				return true;
			default:
				return false;
		}
	}

	function reset() {
		dialogs = [];
		closeOverlay();
		applyChrome(null);
	}

	function cancelShown() {
		const request = dialogs.find((dialog) => dialog.id === shownId);
		if (!request) return false;
		const errorEl = overlay?.querySelector(".ext-dialog-error");
		void answer(request, { cancelled: true }, errorEl ?? el("div"));
		return true;
	}

	return { applySnapshot, handleEvent, reset, isOpen: () => shownId !== null, cancelShown };
}
