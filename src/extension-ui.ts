import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

/** A blocking `ctx.ui` dialog, shaped like pi's rpc `extension_ui_request` plus an absolute deadline for late viewers. */
export type ApiExtensionUiRequest = { id: string; title: string; timeout?: number; expiresAt?: number } & (
	| { method: "select"; options: string[] }
	| { method: "confirm"; message: string }
	| { method: "input"; placeholder?: string }
	| { method: "editor"; prefill?: string }
);

export interface ApiExtensionUiResponse {
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

export type ApiNotifyType = "info" | "warning" | "error";

export interface ApiExtensionWidget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

/** Persistent bits of extension UI that a (re)connecting viewer should see. */
export interface ApiExtensionUiChrome {
	statuses: Record<string, string>;
	widgets: Record<string, ApiExtensionWidget>;
	title: string | null;
}

export interface ApiExtensionUiSnapshot extends ApiExtensionUiChrome {
	dialogs: ApiExtensionUiRequest[];
}

export type ExtensionUiEvent =
	| { type: "extension_ui_request"; request: ApiExtensionUiRequest }
	| { type: "extension_ui_closed"; id: string }
	| { type: "extension_ui_notify"; message: string; notifyType: ApiNotifyType }
	| { type: "extension_ui_chrome"; chrome: ApiExtensionUiChrome }
	| { type: "extension_ui_editor_text"; text: string };

export interface ExtensionUiBridge {
	context: ExtensionUIContext;
	respond(response: ApiExtensionUiResponse): "answered" | "unknown" | "invalid";
	snapshot(): ApiExtensionUiSnapshot;
	/** Dismisses every open dialog, as if each was cancelled. */
	dispose(): void;
}

type DialogDraft = ApiExtensionUiRequest extends infer R ? (R extends ApiExtensionUiRequest ? Omit<R, "id" | "expiresAt"> : never) : never;

interface PendingDialog {
	request: ApiExtensionUiRequest;
	settle(response: ApiExtensionUiResponse | null): void;
}

export const MAX_DIALOG_TEXT_CHARS = 200_000;
const MAX_WIDGET_LINES = 100;
const MAX_CHROME_TEXT_CHARS = 1_000;

/** Accepts the rpc-shaped answer body; anything else is rejected rather than coerced. */
export function parseExtensionUiResponse(raw: Record<string, unknown>): ApiExtensionUiResponse | null {
	const { id, value, confirmed, cancelled } = raw;
	if (typeof id !== "string" || id.length === 0 || id.length > 100) return null;
	if (value !== undefined && typeof value !== "string") return null;
	if (confirmed !== undefined && typeof confirmed !== "boolean") return null;
	if (cancelled !== undefined && typeof cancelled !== "boolean") return null;
	return {
		id,
		...(value === undefined ? {} : { value }),
		...(confirmed === undefined ? {} : { confirmed }),
		...(cancelled === undefined ? {} : { cancelled }),
	};
}

function clip(text: string, max = MAX_CHROME_TEXT_CHARS): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isValidAnswer(request: ApiExtensionUiRequest, response: ApiExtensionUiResponse): boolean {
	if (response.cancelled === true) return true;
	switch (request.method) {
		case "select":
			return typeof response.value === "string" && request.options.includes(response.value);
		case "confirm":
			return typeof response.confirmed === "boolean";
		case "input":
		case "editor":
			return typeof response.value === "string" && response.value.length <= MAX_DIALOG_TEXT_CHARS;
	}
}

function answerValue(response: ApiExtensionUiResponse | null): string | undefined {
	return response && response.cancelled !== true ? response.value : undefined;
}

function answerConfirmed(response: ApiExtensionUiResponse | null): boolean {
	return Boolean(response && response.cancelled !== true && response.confirmed === true);
}

/**
 * The browser side of `ctx.ui` for in-process sessions: dialogs go out as events and wait for a POSTed answer
 * from any viewer, mirroring pi's rpc extension UI (timeouts and abort signals resolve to the default answer).
 */
export function createExtensionUiBridge({
	emit,
	fallback,
	now = Date.now,
}: {
	emit: (event: ExtensionUiEvent) => void;
	fallback: ExtensionUIContext;
	now?: () => number;
}): ExtensionUiBridge {
	const pending = new Map<string, PendingDialog>();
	const statuses = new Map<string, string>();
	const widgets = new Map<string, ApiExtensionWidget>();
	let title: string | null = null;

	const chrome = (): ApiExtensionUiChrome => ({ statuses: Object.fromEntries(statuses), widgets: Object.fromEntries(widgets), title });
	const emitChrome = () => emit({ type: "extension_ui_chrome", chrome: chrome() });

	function openDialog<T>(draft: DialogDraft, opts: ExtensionUIDialogOptions | undefined, fallbackValue: T, parse: (response: ApiExtensionUiResponse | null) => T): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(fallbackValue);
		const id = randomUUID();
		const timeout = typeof draft.timeout === "number" && draft.timeout > 0 ? draft.timeout : undefined;
		const request = { ...draft, id, ...(timeout ? { timeout, expiresAt: now() + timeout } : {}) } as ApiExtensionUiRequest;
		return new Promise<T>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => settle(null);
			function settle(response: ApiExtensionUiResponse | null): void {
				if (!pending.delete(id)) return;
				if (timer) clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				emit({ type: "extension_ui_closed", id });
				resolve(response ? parse(response) : fallbackValue);
			}
			pending.set(id, { request, settle });
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (timeout) timer = setTimeout(() => settle(null), timeout);
			emit({ type: "extension_ui_request", request });
		});
	}

	const context: ExtensionUIContext = {
		...fallback,
		select: (dialogTitle, options, opts) =>
			openDialog({ method: "select", title: dialogTitle, options: [...options], timeout: opts?.timeout }, opts, undefined, answerValue),
		confirm: (dialogTitle, message, opts) => openDialog({ method: "confirm", title: dialogTitle, message, timeout: opts?.timeout }, opts, false, answerConfirmed),
		input: (dialogTitle, placeholder, opts) => openDialog({ method: "input", title: dialogTitle, placeholder, timeout: opts?.timeout }, opts, undefined, answerValue),
		editor: (dialogTitle, prefill) => openDialog({ method: "editor", title: dialogTitle, prefill }, undefined, undefined, answerValue),
		notify(message, type) {
			emit({ type: "extension_ui_notify", message: clip(String(message), MAX_DIALOG_TEXT_CHARS), notifyType: type ?? "info" });
		},
		setStatus(key, text) {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, clip(String(text)));
			emitChrome();
		},
		setWidget(key: string, content: unknown, options?: { placement?: ApiExtensionWidget["placement"] }) {
			if (content === undefined) {
				widgets.delete(key);
			} else if (Array.isArray(content)) {
				const lines = content.slice(0, MAX_WIDGET_LINES).map((line) => clip(String(line)));
				widgets.set(key, { lines, placement: options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor" });
			} else {
				return;
			}
			emitChrome();
		},
		setTitle(nextTitle) {
			title = clip(String(nextTitle));
			emitChrome();
		},
		setEditorText(text) {
			emit({ type: "extension_ui_editor_text", text: clip(String(text), MAX_DIALOG_TEXT_CHARS) });
		},
		pasteToEditor(text) {
			emit({ type: "extension_ui_editor_text", text: clip(String(text), MAX_DIALOG_TEXT_CHARS) });
		},
		getEditorText: () => "",
	};

	return {
		context,
		respond(response) {
			const dialog = pending.get(response.id);
			if (!dialog) return "unknown";
			if (!isValidAnswer(dialog.request, response)) return "invalid";
			dialog.settle(response);
			return "answered";
		},
		snapshot: () => ({ ...chrome(), dialogs: [...pending.values()].map((dialog) => dialog.request) }),
		dispose() {
			for (const dialog of [...pending.values()]) dialog.settle(null);
		},
	};
}
