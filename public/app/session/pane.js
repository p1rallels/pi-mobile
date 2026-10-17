// One session pane: transcript, queued messages, working line, composer, footer and the per-session
// controls (role, model, thinking, take over, abort, release), with its own controller, extension ui
// and menus. The phone shell runs one pane on the static markup in index.html; the canvas runs one per
// tile on markup from pane_dom.js. Everything the pane touches comes in through `refs`.
import { isPhoneLike } from "../core/device.js";
import { createExtensionUi } from "../ui/extension_ui.js";
import { createMenu } from "../ui/menu.js";
import { isQuitCommand } from "./commands.js";
import { createSessionController } from "./controller.js";
import { composerPlaceholder, elsewherePlaceholder, footerLines, modelLabel, roleBadge, workingLabel } from "./pane_format.js";
import { choiceForLabel, createSessionWithTrust, trustPromptRequest } from "./project_trust.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMPOSER_MAX_PX = 200;
const STOP_WRITER_TITLE = "Stop the pi writing this session (Esc)";

/**
 * @typedef {{
 *   msgs: HTMLElement,
 *   jumpLatest: HTMLElement | null,
 *   queuedPanel: HTMLElement,
 *   input: HTMLTextAreaElement,
 *   working?: HTMLElement | null,
 *   workingSpin?: HTMLElement | null,
 *   workingText?: HTMLElement | null,
 *   footerLine1: HTMLElement,
 *   footerLeft2: HTMLElement,
 *   footerRight2: HTMLElement,
 *   footerExtStatus?: HTMLElement | null,
 *   extAbove?: HTMLElement | null,
 *   extBelow?: HTMLElement | null,
 *   rolePill?: HTMLElement | null,
 *   btnModel?: HTMLButtonElement | null,
 *   btnThinking?: HTMLButtonElement | null,
 *   lblModel?: HTMLElement | null,
 *   lblThinking?: HTMLElement | null,
 *   btnTakeover?: HTMLButtonElement | null,
 *   btnAbort?: HTMLButtonElement | null,
 *   btnRelease?: HTMLButtonElement | null,
 *   kbEsc?: HTMLButtonElement | null,
 *   kbTakeover?: HTMLButtonElement | null,
 *   kbRelease?: HTMLButtonElement | null,
 *   kbEnter?: HTMLButtonElement | null,
 * }} PaneRefs
 */

/** @param {HTMLTextAreaElement} el */
export function autoResize(el) {
	el.style.height = "auto";
	el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX_PX) + "px";
}

/**
 * @param {{
 *   refs: PaneRefs,
 *   api: any,
 *   getClientId: () => string | null,
 *   refreshClient?: () => Promise<unknown>,
 *   menuDom: { menuOverlay: HTMLElement | null, menuScrim: HTMLElement | null, menuPanel: HTMLElement | null },
 *   getHost: () => { hostLabel?: string | null, baseUrl: string },
 *   onStateChange?: () => void,
 *   onSidebarClose?: () => void,
 *   onSidebarRefresh?: () => void,
 *   transcriptWindow?: { unfocused: number, focused: number, pageSize: number } | null,
 *   tileUi?: { dialogHost: HTMLElement, hasKeyboard: () => boolean, onTitle: (title: string | null) => void } | null,
 *   onFreshStarted?: (sessionId: string) => void,
 *   goneNotice?: string | null,
 *   onQuit?: (() => void) | null,
 * }} options
 * `transcriptWindow` keeps only the newest entries of the transcript (canvas tiles); the phone keeps them all.
 * `tileUi` keeps extension dialogs and the extension title inside a canvas tile instead of on the page.
 * `onFreshStarted` hears the session a fresh pane's first send started (see fresh.js); `goneNotice` replaces
 * what the pane says when its session ended for good (null: nothing, the shell says it).
 * `onQuit` makes a message starting with /quit stop the session instead of going to pi, and then hears that the
 * pane is done (a canvas tile goes back to its launcher); without it /quit is sent like any prompt.
 */
export function createSessionPane({
	refs,
	api,
	getClientId,
	refreshClient,
	menuDom,
	getHost,
	onStateChange,
	onSidebarClose,
	onSidebarRefresh,
	transcriptWindow = null,
	tileUi = null,
	onFreshStarted,
	goneNotice,
	onQuit = null,
}) {
	const { input } = refs;
	const abortTitle = refs.btnAbort?.title ?? "";
	/** @type {ReturnType<typeof setInterval> | null} */
	let workingIntervalId = null;
	let workingFrame = 0;
	let destroyed = false;
	let quitting = false;

	const extensionUi = createExtensionUi({
		api,
		getSessionId: () => sessionCtrl.getActiveSessionId(),
		onNotice: (/** @type {string} */ text, /** @type {string} */ kind) => sessionCtrl.appendNotice(text, kind),
		onEditorText: (/** @type {string} */ text) => {
			input.value = text;
			autoResize(input);
		},
		statusEl: refs.footerExtStatus ?? null,
		aboveEl: refs.extAbove ?? null,
		belowEl: refs.extBelow ?? null,
		...(tileUi
			? {
					dialogHost: tileUi.dialogHost,
					shouldFocus: tileUi.hasKeyboard,
					onTitle: tileUi.onTitle,
					onChange: () => onStateChange?.(),
				}
			: {}),
	});

	/** @param {any} prompt */
	async function askProjectTrust(prompt) {
		const response = await extensionUi.askLocal(trustPromptRequest(prompt));
		return response.cancelled ? null : choiceForLabel(prompt, response.value);
	}

	/** @param {any} payload */
	const createSession = (payload) => createSessionWithTrust({ api, payload, ask: askProjectTrust });

	const sessionCtrl = createSessionController({
		msgsEl: refs.msgs,
		queuedEl: refs.queuedPanel,
		pillEl: refs.jumpLatest,
		api,
		getClientId,
		onRefreshClient: refreshClient,
		onStateChange: () => {
			render();
			onStateChange?.();
		},
		onCloseMenu: () => menuCtrl?.close(),
		onSidebarClose: () => onSidebarClose?.(),
		onSidebarRefresh: () => onSidebarRefresh?.(),
		extensionUi,
		createSession,
		transcriptWindow,
		onFreshStarted: (/** @type {string} */ sessionId) => onFreshStarted?.(sessionId),
		...(goneNotice !== undefined ? { goneNotice } : {}),
	});

	const menuCtrl = createMenu({
		...menuDom,
		btnModel: refs.btnModel ?? null,
		btnThinking: refs.btnThinking ?? null,
		api,
		getClientId,
		onNotice: sessionCtrl.appendNotice,
		getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
		getActiveState: () => sessionCtrl.getActiveState(),
	});

	/** Where a session another pi writes stands, or null when this pane hosts its session. */
	function followed() {
		return sessionCtrl.getMode() === "elsewhere" ? sessionCtrl.getFollow() : null;
	}

	function renderFooter() {
		const lines = footerLines(sessionCtrl.getActiveState(), getHost(), followed());
		refs.footerLine1.textContent = lines.line1;
		refs.footerLeft2.textContent = lines.left2;
		refs.footerRight2.textContent = lines.right2;
	}

	function renderRolePill() {
		if (!refs.rolePill) return;
		const badge = roleBadge(sessionCtrl.getRole(), sessionCtrl.getConnection(), Boolean(sessionCtrl.getActiveSessionId()), followed());
		refs.rolePill.textContent = badge.text;
		refs.rolePill.classList.remove("controller", "viewer", "offline", "elsewhere");
		refs.rolePill.classList.add(badge.kind);
	}

	function renderSelectors() {
		const activeState = sessionCtrl.getActiveState();
		const model = modelLabel(activeState) ?? "—";
		if (refs.lblModel) {
			refs.lblModel.textContent = model;
			refs.lblModel.title = model;
		}
		const thinking = activeState?.thinkingLevel ? String(activeState.thinkingLevel) : "—";
		if (refs.lblThinking) {
			refs.lblThinking.textContent = thinking;
			refs.lblThinking.title = thinking;
		}
	}

	function renderWorking() {
		if (!refs.working) return;
		const status = sessionCtrl.getRunStatus();
		const show = isPhoneLike() && status.kind !== "idle";
		refs.working.classList.toggle("open", show);
		if (refs.workingText) refs.workingText.textContent = workingLabel(status);

		const updateFrame = () => {
			if (refs.workingSpin) refs.workingSpin.textContent = SPINNER_FRAMES[workingFrame % SPINNER_FRAMES.length];
			workingFrame = (workingFrame + 1) % SPINNER_FRAMES.length;
		};

		if (show) {
			if (!workingIntervalId) {
				workingFrame = 0;
				updateFrame();
				workingIntervalId = setInterval(updateFrame, 80);
			}
		} else if (workingIntervalId) {
			clearInterval(workingIntervalId);
			workingIntervalId = null;
		}
	}

	/** A followed session: Esc stops its writer, and typing or Take over continue it here once nobody writes it. */
	function renderElsewhereControls() {
		const canStop = sessionCtrl.canStopWriter();
		const canResume = sessionCtrl.canResumeHere();
		if (refs.btnAbort) {
			refs.btnAbort.title = STOP_WRITER_TITLE;
			refs.btnAbort.disabled = !canStop;
		}
		if (refs.btnTakeover) refs.btnTakeover.disabled = !canResume;
		if (refs.btnRelease) refs.btnRelease.disabled = true;
		input.disabled = !canResume;
		if (refs.btnModel) refs.btnModel.disabled = true;
		if (refs.btnThinking) refs.btnThinking.disabled = true;
		if (refs.kbEsc) refs.kbEsc.disabled = !canStop;
		if (refs.kbTakeover) refs.kbTakeover.disabled = !canResume;
		if (refs.kbRelease) refs.kbRelease.disabled = true;
		if (refs.kbEnter) refs.kbEnter.disabled = !canResume;
		input.placeholder = elsewherePlaceholder(sessionCtrl.getFollow());
		renderSelectors();
		renderWorking();
	}

	/** No session yet (the one this pane had was never saved): typing and sending work, sending starts one; nothing else applies. */
	function renderFreshControls() {
		if (refs.btnAbort) {
			refs.btnAbort.title = abortTitle;
			refs.btnAbort.disabled = true;
		}
		if (refs.btnTakeover) refs.btnTakeover.disabled = true;
		if (refs.btnRelease) refs.btnRelease.disabled = true;
		input.disabled = false;
		if (refs.btnModel) refs.btnModel.disabled = true;
		if (refs.btnThinking) refs.btnThinking.disabled = true;
		if (refs.kbEsc) refs.kbEsc.disabled = true;
		if (refs.kbTakeover) refs.kbTakeover.disabled = true;
		if (refs.kbRelease) refs.kbRelease.disabled = true;
		if (refs.kbEnter) refs.kbEnter.disabled = false;
		input.placeholder = composerPlaceholder({ hasSession: true, compacting: false, isController: true, streaming: false, phone: isPhoneLike() });
		renderSelectors();
		renderWorking();
	}

	function renderControls() {
		renderRolePill();

		if (sessionCtrl.getActiveSessionId() && sessionCtrl.getMode() === "elsewhere") {
			renderElsewhereControls();
			return;
		}
		if (sessionCtrl.isFresh()) {
			renderFreshControls();
			return;
		}

		const hasSession = Boolean(sessionCtrl.getActiveSessionId());
		if (refs.btnAbort) refs.btnAbort.title = abortTitle;
		const isController = hasSession && sessionCtrl.isController();
		const activeState = sessionCtrl.getActiveState();
		const compacting = Boolean(activeState && activeState.isCompacting);
		const streaming = Boolean(activeState && activeState.isStreaming);
		const busy = streaming || compacting;
		const canChangeSettings = hasSession && isController && !busy;

		if (refs.btnAbort) refs.btnAbort.disabled = !hasSession;
		if (refs.btnTakeover) refs.btnTakeover.disabled = !hasSession || isController;
		if (refs.btnRelease) refs.btnRelease.disabled = !hasSession || !isController;
		input.disabled = !hasSession || !isController || compacting;
		if (refs.btnModel) refs.btnModel.disabled = !canChangeSettings;
		if (refs.btnThinking) refs.btnThinking.disabled = !canChangeSettings;

		if (refs.kbEsc) refs.kbEsc.disabled = !hasSession;
		if (refs.kbTakeover) refs.kbTakeover.disabled = !hasSession || isController;
		if (refs.kbRelease) refs.kbRelease.disabled = !hasSession || !isController;
		if (refs.kbEnter) refs.kbEnter.disabled = !hasSession || !isController || compacting;

		input.placeholder = composerPlaceholder({ hasSession, compacting, isController, streaming, phone: isPhoneLike() });

		renderSelectors();
		renderWorking();
	}

	function render() {
		if (destroyed) return;
		renderFooter();
		renderControls();
	}

	/** @param {string} text */
	function restoreComposerText(text) {
		input.value = input.value.trim() ? `${text}\n${input.value}` : text;
		autoResize(input);
	}

	async function sendPromptFromInput() {
		if (input.disabled || quitting) return;
		const text = input.value;
		if (!text.trim()) return;
		input.value = "";
		autoResize(input);
		input.focus();
		if (onQuit && isQuitCommand(text)) {
			await quitFromInput(onQuit, text);
			return;
		}
		try {
			await sessionCtrl.sendPrompt(text);
		} catch (error) {
			restoreComposerText(text);
			sessionCtrl.appendNotice(`Not sent: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	/**
	 * /quit: stops the session, then hands the pane back to the shell; if it couldn't stop it, /quit goes back in the composer.
	 * @param {() => void} done @param {string} text
	 */
	async function quitFromInput(done, text) {
		quitting = true;
		try {
			await sessionCtrl.quit();
		} catch (error) {
			quitting = false;
			if (destroyed) return;
			restoreComposerText(text);
			sessionCtrl.appendNotice(`Not quit: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (!destroyed) done();
	}

	/** @param {() => Promise<unknown>} action */
	function runAction(action) {
		void action().catch((error) => {
			sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
		});
	}

	const abort = () => runAction(sessionCtrl.abortRun);
	const takeOver = () => runAction(sessionCtrl.takeOver);
	const release = () => runAction(sessionCtrl.release);

	/** @type {Array<[EventTarget | null | undefined, string, EventListener]>} */
	const bindings = [
		[refs.btnAbort, "click", abort],
		[refs.btnTakeover, "click", takeOver],
		[refs.btnRelease, "click", release],
		[refs.btnModel, "click", () => void menuCtrl.openModelMenu()],
		[refs.btnThinking, "click", () => menuCtrl.openThinkingMenu()],
		[refs.kbEsc, "click", abort],
		[refs.kbTakeover, "click", takeOver],
		[refs.kbRelease, "click", release],
		[refs.kbEnter, "click", () => void sendPromptFromInput()],
		[input, "input", () => autoResize(input)],
		[
			input,
			"keydown",
			(event) => {
				const key = /** @type {KeyboardEvent} */ (event);
				if (isPhoneLike()) return;
				if (key.key === "Enter" && !key.shiftKey) {
					key.preventDefault();
					void sendPromptFromInput();
				}
			},
		],
	];
	for (const [target, type, listener] of bindings) target?.addEventListener(type, listener);

	return {
		refs,
		extensionUi,
		createSession,
		appendNotice: sessionCtrl.appendNotice,
		getSessionId: () => sessionCtrl.getActiveSessionId(),
		getState: () => sessionCtrl.getActiveState(),
		getRunStatus: () => sessionCtrl.getRunStatus(),
		getRole: () => sessionCtrl.getRole(),
		getConnection: () => sessionCtrl.getConnection(),
		isController: () => sessionCtrl.isController(),
		/** "hosted", or "elsewhere" while it follows a session another pi writes. */
		getMode: () => sessionCtrl.getMode(),
		getFollow: () => sessionCtrl.getFollow(),
		/** No session behind the pane yet: the one it had was never saved, and sending starts one (see fresh.js). */
		isFresh: () => sessionCtrl.isFresh(),
		/** @returns {import("./fresh.js").FreshRecord | null} */
		getFresh: () => sessionCtrl.getFresh(),
		/** @param {import("./fresh.js").FreshRecord} record */
		openFresh(record) {
			sessionCtrl.openFresh(record);
			render();
		},
		canStopWriter: () => sessionCtrl.canStopWriter(),
		canResumeHere: () => sessionCtrl.canResumeHere(),
		/** @param {any} session */
		selectSession: (session) => sessionCtrl.selectSession(session),
		/** Follows a session another pi writes, read-only. @param {string} sessionId @param {string} path @param {any} elsewhere */
		followElsewhere: (sessionId, path, elsewhere) => sessionCtrl.followElsewhere(sessionId, path, elsewhere),
		/** @param {string} sessionId */
		openSessionId(sessionId) {
			sessionCtrl.openSessionId(sessionId);
			render();
		},
		reset() {
			sessionCtrl.reset();
			render();
		},
		/** @param {string} name */
		runReplay: (name) => sessionCtrl.runReplay(name),
		resumeIfStale: () => sessionCtrl.resumeIfStale(),
		suspend: () => sessionCtrl.suspend(),
		resume: () => sessionCtrl.resume(),
		/** @param {boolean} focused */
		setFocused: (focused) => sessionCtrl.setFocused(focused),
		/**
		 * @param {{ messages: unknown[], hasOlder?: boolean }} page
		 * @param {{ sessionId: string, path: string } | null} [source] the session it came from, to page back through its file
		 */
		showReadOnly: (page, source = null) => sessionCtrl.showReadOnly(page, source),
		getShownEntryCount: () => sessionCtrl.getShownEntryCount(),
		sendPromptFromInput,
		abort,
		takeOver,
		release,
		openModelMenu: () => menuCtrl.openModelMenu(),
		openThinkingMenu: () => menuCtrl.openThinkingMenu(),
		closeMenu: () => menuCtrl.close(),
		/** A custom menu in the shared overlay, closed by Esc like the model menu. @param {HTMLElement} anchor @param {(panel: HTMLElement) => void} build */
		openMenu: (anchor, build) => menuCtrl.openCustom(anchor, build),
		/**
		 * Esc closes this pane's extension dialog or menu first, otherwise aborts its run.
		 * @param {KeyboardEvent} event
		 */
		handleEscape(event) {
			if (extensionUi.isOpen()) {
				event.preventDefault();
				extensionUi.cancelShown();
				return;
			}
			if (menuCtrl.isOpen()) {
				event.preventDefault();
				menuCtrl.close();
				return;
			}
			abort();
		},
		focusComposer: () => input.focus({ preventScroll: true }),
		render,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			for (const [target, type, listener] of bindings) target?.removeEventListener(type, listener);
			if (workingIntervalId) clearInterval(workingIntervalId);
			workingIntervalId = null;
			menuCtrl.destroy();
			extensionUi.reset();
			sessionCtrl.destroy();
		},
	};
}
