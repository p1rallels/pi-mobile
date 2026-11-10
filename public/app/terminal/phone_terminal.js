// The phone's terminal: one shell at a time on a full screen above the session, run by the same controller as a canvas
// tile (open, attach, reconnect, Face ID, the expiry countdown). Below the screen sits a key bar for what the iOS
// keyboard lacks (esc, a sticky ctrl, tab, arrows, paste), and "select" shows the screen as text iOS can select.
//
// pbcopy: iOS lets a page write the clipboard only during a tap or a key press, and pbcopy's text reaches the page from
// the host after the return that ran it. So a return that runs a pbcopy you typed or recalled (copy_intent.js decides,
// the same way as on the laptop) starts a clipboard write right then and hands it the text once it arrives (WebKit
// takes a promise for the data). Text that comes any other way (printed by output, pbcopy inside a script, a write iOS
// refused) waits in a "tap to copy" bar instead.
//
// Opening the screen asks for Face ID every time, and closing it locks the terminals again (see TerminalLock in
// core/faceid.js). Locked while open (the app went away), it drops the screen, the select sheet and any copy waiting.
import { noTerminalLock } from "../core/faceid.js";
import { ARM_MS, copySummary, lineCount } from "./copy_intent.js";
import { createTerminalTile } from "./terminal_tile.js";

const FONT_SIZE = 12;
/** The select sheet keeps the end of a long scrollback. */
const SHEET_LINES = 3_000;

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** ctrl plus a key, the way a terminal sends it: ctrl-c is 0x03, ctrl-[ is esc; null for keys ctrl doesn't change. @param {string} key */
function controlCode(key) {
	if (key === "?") return "\x7f";
	if (key === " ") return "\x00";
	const upper = key.toUpperCase();
	const code = upper.charCodeAt(0);
	return upper.length === 1 && code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
}

/** @typedef {{ resolve: (blob: Blob) => void, reject: (error: Error) => void, timer: number, text: string | null }} ArmedCopy */

/**
 * @param {{
 *   doc: Document,
 *   api: { getJson: (path: string) => Promise<any>, postJson: (path: string, body: unknown) => Promise<any>, resolveUrl: (path: string) => string },
 *   refreshClient: () => Promise<unknown>,
 *   onClosed: () => void,
 *   lock?: import("../core/faceid.js").TerminalLock,
 * }} options
 */
export function createPhoneTerminal({ doc, api, refreshClient, onClosed, lock = noTerminalLock }) {
	const view = /** @type {Window} */ (doc.defaultView);

	/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} className @param {string} [text] */
	function h(tag, className, text) {
		const el = doc.createElement(tag);
		el.className = className;
		if (text !== undefined) el.textContent = text;
		return el;
	}

	/** @param {string} className @param {string} text @param {string} [label] */
	function button(className, text, label) {
		const el = h("button", className, text);
		el.type = "button";
		if (label) el.setAttribute("aria-label", label);
		return el;
	}

	/**
	 * Key bar keys act without taking focus from the terminal, so the iOS keyboard stays up: no focus change on press,
	 * and on touch the action runs on touchend (still a user gesture, which paste needs) instead of the click.
	 * @param {HTMLElement} el @param {() => void} action
	 */
	function onPress(el, action) {
		el.addEventListener("mousedown", (event) => event.preventDefault());
		el.addEventListener(
			"touchend",
			(event) => {
				event.preventDefault();
				action();
			},
			{ passive: false },
		);
		el.addEventListener("click", () => action());
	}

	const root = h("div", "ph-term");
	root.hidden = true;
	const header = h("div", "ph-term-hdr");
	const back = button("ph-term-hbtn", "‹", "Back to the session (the shell keeps running)");
	const titleEl = h("span", "ph-term-title");
	const statusEl = h("span", "ph-term-status");
	const selectBtn = button("ph-term-hbtn", "select", "Show the screen as text you can select");
	const closeBtn = button("ph-term-hbtn ph-term-close", "×", "Close the shell");
	header.append(back, titleEl, statusEl, selectBtn, closeBtn);

	const body = h("div", "ph-term-body");

	// where a paste goes when the page may not read the clipboard (the Paste bubble dismissed, an older iOS)
	const pasteBox = h("div", "ph-term-paste");
	pasteBox.hidden = true;
	const pasteField = h("textarea", "ph-term-paste-field");
	pasteField.rows = 1;
	pasteField.placeholder = "touch and hold here, then Paste";
	pasteField.setAttribute("autocapitalize", "off");
	pasteField.setAttribute("autocorrect", "off");
	pasteField.spellcheck = false;
	const pasteCancel = button("ph-term-copy-x", "\u00d7", "Cancel the paste");
	pasteBox.append(pasteField, pasteCancel);

	const copyBar = h("div", "ph-term-copy");
	copyBar.hidden = true;
	const copyText = h("span", "ph-term-copy-text");
	const copyBtn = button("ph-term-copy-btn", "tap to copy");
	const copyDismiss = button("ph-term-copy-x", "×", "Dismiss");
	copyBar.append(copyText, copyBtn, copyDismiss);

	const keys = h("div", "ph-term-keys");
	const ctrlKey = button("ph-term-key", "ctrl");
	/** @type {Array<[string, () => void]>} */
	const keySpecs = [
		["esc", () => typeKey("\x1b")],
		["ctrl", () => setCtrl(!ctrl)],
		["tab", () => typeKey("\t")],
		["←", () => arrow("D")],
		["↓", () => arrow("B")],
		["↑", () => arrow("A")],
		["→", () => arrow("C")],
		["paste", () => void pasteClipboard()],
	];
	for (const [label, action] of keySpecs) {
		const key = label === "ctrl" ? ctrlKey : button("ph-term-key", label);
		onPress(key, action);
		keys.append(key);
	}

	const sheet = h("div", "ph-term-sheet");
	sheet.hidden = true;
	const sheetBar = h("div", "ph-term-sheet-bar");
	const sheetHint = h("span", "ph-term-sheet-hint", "touch and hold to select");
	const sheetCopyAll = button("ph-term-hbtn", "copy all");
	const sheetDone = button("ph-term-hbtn", "done");
	sheetBar.append(sheetHint, sheetCopyAll, sheetDone);
	const sheetText = h("pre", "ph-term-sheet-text");
	sheet.append(sheetBar, sheetText);

	root.append(header, body, pasteBox, copyBar, keys, sheet);
	doc.body.append(root);

	/** @type {ReturnType<typeof createTerminalTile> | null} */
	let controller = null;
	let ctrl = false;
	/** @type {ArmedCopy | null} */
	let armed = null;
	/** @type {string | null} */
	let pendingCopy = null;

	/** @param {boolean} next */
	function setCtrl(next) {
		ctrl = next;
		ctrlKey.classList.toggle("is-on", ctrl);
	}

	/** @param {string} data */
	function typeKey(data) {
		setCtrl(false);
		controller?.getView()?.input(data);
	}

	/** @param {"A" | "B" | "C" | "D"} direction */
	function arrow(direction) {
		const screen = controller?.getView();
		if (!screen) return;
		setCtrl(false);
		screen.input(`\x1b${screen.appCursorKeys() ? "O" : "["}${direction}`);
	}

	/** Typed input with ctrl down: one key becomes its control code, and ctrl lets go either way. @param {string} data */
	function mapInput(data) {
		let out = data;
		if (ctrl) {
			setCtrl(false);
			if (data.length === 1) out = controlCode(data) ?? data;
		}
		return out;
	}

	/** iOS asks with its Paste bubble; a page it won't let read the clipboard gets a field to paste into instead. */
	async function pasteClipboard() {
		const screen = controller?.getView();
		if (!screen) return;
		try {
			const text = await navigator.clipboard.readText();
			if (text) screen.paste(text);
			return;
		} catch {
			// the paste box below
		}
		pasteField.value = "";
		pasteBox.hidden = false;
		pasteField.focus({ preventScroll: true });
	}

	function hidePasteBox() {
		pasteBox.hidden = true;
		pasteField.value = "";
	}

	/** @param {string} text */
	function finishPaste(text) {
		hidePasteBox();
		controller?.getView()?.paste(text);
		controller?.focus();
	}

	/** @param {string} text */
	function copied(text) {
		controller?.flash(`copied ${lineCount(text)}`);
		if (pendingCopy === text) hideCopyBar();
	}

	/** @param {string} text */
	function showCopyBar(text) {
		pendingCopy = text;
		copyText.textContent = copySummary(text);
		copyBtn.textContent = "tap to copy";
		copyBar.hidden = false;
	}

	function hideCopyBar() {
		pendingCopy = null;
		copyBar.hidden = true;
	}

	function disarm() {
		if (!armed) return;
		const current = armed;
		armed = null;
		view.clearTimeout(current.timer);
		current.reject(new Error("pbcopy sent nothing"));
	}

	/** A return that runs pbcopy: the clipboard write starts inside the key press and gets the text when it comes. */
	function armCopy() {
		disarm();
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return;
		/** @type {(blob: Blob) => void} */
		let resolve = () => {};
		/** @type {(error: Error) => void} */
		let reject = () => {};
		/** @type {Promise<Blob>} */
		const data = new Promise((ok, fail) => {
			resolve = ok;
			reject = fail;
		});
		/** @type {ArmedCopy} */
		const entry = { resolve, reject, timer: 0, text: null };
		try {
			navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]).then(
				() => {
					if (entry.text !== null) copied(entry.text);
				},
				() => {
					// refused, or pbcopy came too late: the text (if any) waits for a tap
					if (entry.text !== null) showCopyBar(entry.text);
				},
			);
		} catch {
			return;
		}
		entry.timer = view.setTimeout(() => {
			if (armed === entry) disarm();
		}, ARM_MS);
		armed = entry;
	}

	/**
	 * What the terminal sent for the clipboard (OSC 52), `intended` when a return that runs pbcopy came before it.
	 * @param {string} text @param {boolean} intended
	 */
	function onClipboard(text, intended) {
		if (!intended) {
			showCopyBar(text);
			return;
		}
		if (armed) {
			const entry = armed;
			armed = null;
			view.clearTimeout(entry.timer);
			entry.text = text;
			entry.resolve(new Blob([text], { type: "text/plain" }));
			return;
		}
		// no promise write to hand it to (no ClipboardItem): a browser that lets a focused page copy without a tap just
		// copies, one that says no shows the bar
		navigator.clipboard.writeText(text).then(
			() => copied(text),
			() => showCopyBar(text),
		);
	}

	function openSheet() {
		const screen = controller?.getView();
		if (!screen) return;
		const lines = screen.screenText().split("\n");
		sheetText.textContent = lines.slice(-SHEET_LINES).join("\n");
		sheet.hidden = false;
		// the keyboard goes down so the sheet gets the whole screen
		if (doc.activeElement instanceof HTMLElement) doc.activeElement.blur();
		sheetText.scrollTop = sheetText.scrollHeight;
	}

	function closeSheet() {
		sheet.hidden = true;
		sheetText.textContent = "";
	}

	/** The screen follows the part of the page iOS leaves visible above its keyboard. */
	function fitViewport() {
		const viewport = view.visualViewport;
		if (root.hidden || !viewport) return;
		root.style.top = `${viewport.offsetTop}px`;
		root.style.height = `${viewport.height}px`;
	}

	function reset() {
		disarm();
		hideCopyBar();
		hidePasteBox();
		closeSheet();
		setCtrl(false);
	}

	function close() {
		if (!controller) return;
		const current = controller;
		controller = null;
		current.destroy();
		reset();
		root.hidden = true;
		root.style.top = "";
		root.style.height = "";
		doc.body.classList.remove("ph-term-open");
		statusEl.replaceChildren();
		// out of use: the next open asks again, and the host turns away this browser until then
		lock.lock();
		onClosed();
	}

	/**
	 * Shows a shell: the one with `terminalId`, or a new one in `cwd` (also when the host no longer has that one).
	 * @param {{ terminalId: string | null, cwd: string | null, title?: string | null }} spec
	 */
	function open({ terminalId, cwd, title = null }) {
		if (controller) close();
		reset();
		statusEl.replaceChildren();
		root.hidden = false;
		doc.body.classList.add("ph-term-open");
		fitViewport();
		controller = createTerminalTile({
			doc,
			api,
			tile: { body, titleEl, statusEl },
			terminalId,
			cwd,
			title,
			getScale: () => 1,
			isFocused: () => true,
			refreshClient,
			onIdChange: () => {},
			onChange: () => {},
			onRemove: () => close(),
			view: { fontSize: FONT_SIZE, mapInput, onArm: armCopy, onClipboard },
			lock,
			askFirst: true,
		});
		controller.setVisible(true);
	}

	back.addEventListener("click", () => close());
	closeBtn.addEventListener("click", () => void controller?.requestClose());
	selectBtn.addEventListener("click", () => openSheet());
	sheetDone.addEventListener("click", () => closeSheet());
	sheetCopyAll.addEventListener("click", () => {
		const text = sheetText.textContent ?? "";
		navigator.clipboard.writeText(text).then(
			() => {
				copied(text);
				closeSheet();
			},
			(error) => controller?.flash(`couldn't copy: ${messageOf(error)}`, "error"),
		);
	});
	onPress(copyBtn, () => {
		const text = pendingCopy;
		if (text === null) return;
		navigator.clipboard.writeText(text).then(
			() => copied(text),
			(error) => {
				copyBtn.textContent = "try again";
				controller?.flash(`couldn't copy: ${messageOf(error)}`, "error");
			},
		);
	});
	onPress(copyDismiss, () => hideCopyBar());
	pasteField.addEventListener("paste", (event) => {
		const text = event.clipboardData?.getData("text/plain") ?? "";
		if (!text) return;
		event.preventDefault();
		finishPaste(text);
	});
	pasteField.addEventListener("input", () => {
		if (pasteField.value) finishPaste(pasteField.value);
	});
	pasteCancel.addEventListener("click", () => {
		hidePasteBox();
		controller?.focus();
	});
	view.visualViewport?.addEventListener("resize", fitViewport);
	view.visualViewport?.addEventListener("scroll", fitViewport);
	lock.watch({
		onLock: () => {
			if (controller) reset();
		},
		onUnlock: () => {},
		wantsUnlock: () => false,
	});

	return {
		open,
		close,
		isOpen: () => controller !== null,
		currentId: () => controller?.getId() ?? null,
	};
}
