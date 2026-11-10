// A terminal tile's screen: xterm (served from the host's node_modules) on a websocket to a shell on the host. The host
// sends the screen first (a snapshot of its mirror), then the shell's raw output as binary frames; keys, pastes and size
// changes go back as JSON. pbcopy in the shell reaches the browser's clipboard as OSC 52, write only: nothing that runs in
// the shell can read the clipboard back. Output alone never writes it: a write follows a return on a pbcopy line (see
// copy_intent.js), and anything else the terminal sends for the clipboard waits in a small bar for a click.
import { FitAddon } from "/vendor/xterm/addon-fit.mjs";
import { Terminal } from "/vendor/xterm/xterm.mjs";
import { NO_INTENT, afterInput, afterReturn, copySummary, isReturnKey, osc52Text, takeCopy } from "./copy_intent.js";

const FONT_FAMILY = '"Cascadia Code", "SF Mono", ui-monospace, "Fira Code", Menlo, monospace';
const THEME = {
	background: "#18181e",
	foreground: "#d4d4d4",
	cursor: "#8abeb7",
	cursorAccent: "#18181e",
	selectionBackground: "rgba(138, 190, 183, 0.3)",
};
const SCROLLBACK = 10_000;
const MOUSE_EVENTS = ["mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu", "wheel"];

/** @typedef {{ screen: HTMLElement, getScale: () => number }} ScaledScreen */

/** @type {Promise<void> | null} */
let cssLoaded = null;

/** xterm's stylesheet, loaded once before the first terminal opens (it lays out the screen xterm measures). @param {Document} doc */
export function loadTerminalStyles(doc) {
	cssLoaded ??= new Promise((resolve) => {
		const link = doc.createElement("link");
		link.rel = "stylesheet";
		link.href = "/vendor/xterm/xterm.css";
		link.addEventListener("load", () => resolve());
		link.addEventListener("error", () => resolve());
		doc.head.append(link);
	});
	return cssLoaded;
}

/** @type {WeakMap<Element, ScaledScreen>} */
const screens = new WeakMap();
/** @type {ScaledScreen | null} */
let dragging = null;
let mouseFixInstalled = false;

/**
 * xterm maps a mouse event to a cell with the screen's on-screen rect (scaled by the canvas camera) and unscaled cell
 * sizes, so zoomed in or out every click, selection and mouse report lands on the wrong cell. On the way in (window,
 * capture), events over a terminal, and the rest of a drag that started on one, get their clientX/clientY moved so the
 * offset from the screen's corner is in unscaled px. Cmd/ctrl wheels are the canvas's (pan, zoom at the real cursor).
 * @param {Window} view
 */
function installMouseFix(view) {
	if (mouseFixInstalled) return;
	mouseFixInstalled = true;
	/** @param {Event} event */
	const fix = (event) => {
		const mouse = /** @type {MouseEvent} */ (event);
		if (event.type === "wheel" && (mouse.ctrlKey || mouse.metaKey)) return;
		const target = event.target instanceof view.Element ? event.target.closest(".xterm") : null;
		const over = target ? screens.get(target) : undefined;
		if (event.type === "mousedown") dragging = over ?? null;
		else if (event.type === "mousemove" && mouse.buttons === 0 && !over) dragging = null;
		const entry = over ?? dragging;
		if (!entry) return;
		const scale = entry.getScale();
		if (!(scale > 0) || Math.abs(scale - 1) < 0.001) return;
		const rect = entry.screen.getBoundingClientRect();
		try {
			Object.defineProperty(event, "clientX", { configurable: true, value: rect.left + (mouse.clientX - rect.left) / scale });
			Object.defineProperty(event, "clientY", { configurable: true, value: rect.top + (mouse.clientY - rect.top) / scale });
		} catch {
			// an event that won't take it keeps its coordinates
		}
	};
	for (const type of MOUSE_EVENTS) view.addEventListener(type, fix, { capture: true });
	// after xterm's own (document) mouseup listener has seen the end of the drag
	view.addEventListener("mouseup", () => {
		dragging = null;
	});
}

/**
 * The laptop's copy bar: what the terminal sends for the clipboard without a pbcopy return before it waits here (how long
 * it is, how it starts) until a click copies it or × drops it. A newer one takes its place.
 * @param {Document} doc @param {HTMLElement} container @param {() => void} refocus
 * @param {{ onCopied: (text: string) => void, onCopyFailed: (error: unknown) => void }} report
 */
function createCopyBar(doc, container, refocus, report) {
	/** @param {string} className @param {string} text */
	const button = (className, text) => {
		const el = doc.createElement("button");
		el.type = "button";
		el.className = className;
		el.textContent = text;
		return el;
	};
	const bar = doc.createElement("div");
	bar.className = "cv-term-copy";
	bar.hidden = true;
	bar.title = "The terminal sent this for the clipboard. Copy it if you meant to.";
	const label = doc.createElement("span");
	label.className = "cv-term-copy-text";
	const copyBtn = button("cv-term-btn", "copy");
	const dismiss = button("cv-term-btn cv-term-copy-x", "\u00d7");
	dismiss.setAttribute("aria-label", "Dismiss");
	bar.append(label, copyBtn, dismiss);
	container.append(bar);
	/** @type {string | null} */
	let pending = null;

	function hide() {
		pending = null;
		bar.hidden = true;
	}

	/** Done with the bar: the keyboard goes back to the terminal if the bar had it. */
	function done() {
		const hadFocus = bar.contains(doc.activeElement);
		hide();
		if (hadFocus) refocus();
	}

	// a click leaves the keyboard with the terminal
	bar.addEventListener("mousedown", (event) => event.preventDefault());
	copyBtn.addEventListener("click", () => {
		const text = pending;
		if (text === null) return;
		navigator.clipboard.writeText(text).then(
			() => {
				if (pending === text) done();
				report.onCopied(text);
			},
			(error) => {
				copyBtn.textContent = "try again";
				report.onCopyFailed(error);
			},
		);
	});
	dismiss.addEventListener("click", () => done());

	return {
		/** @param {string} text */
		offer(text) {
			pending = text;
			label.textContent = copySummary(text);
			copyBtn.textContent = "copy";
			bar.hidden = false;
		},
		/** Copied another way (a pbcopy return): the same text needs no click. @param {string} text */
		copied(text) {
			if (pending === text) hide();
		},
		hide,
		remove: () => bar.remove(),
	};
}

/**
 * What the phone's terminal screen adds: a smaller font, a map over typed input (its sticky ctrl key) and its own
 * handling of what pbcopy sends. `onArm` runs inside the key press of a return that showed copy intent (where iOS lets
 * a clipboard write start); `onClipboard` gets every OSC 52 write, `intended` when such a return armed it.
 * @typedef {{
 *   fontSize?: number,
 *   mapInput?: (data: string) => string,
 *   onArm?: () => void,
 *   onClipboard?: (text: string, intended: boolean) => void,
 * }} TerminalViewExtras
 */

/**
 * @param {{
 *   container: HTMLElement,
 *   socketUrl: (size: { cols: number, rows: number } | null) => string,
 *   getScale: () => number,
 *   onTitle: (title: string) => void,
 *   onLive: () => void,
 *   onExpires: (at: number | null) => void,
 *   onExit: (reason: string, code: number | null) => void,
 *   onLost: () => void,
 *   onCopied: (text: string) => void,
 *   onCopyFailed: (error: unknown) => void,
 * } & TerminalViewExtras} options
 */
export function createTerminalView(options) {
	const { container } = options;
	const doc = container.ownerDocument;
	const view = /** @type {Window} */ (doc.defaultView);
	installMouseFix(view);

	const term = new Terminal({
		fontFamily: FONT_FAMILY,
		fontSize: options.fontSize ?? 13,
		theme: THEME,
		scrollback: SCROLLBACK,
		cursorBlink: true,
		// option+drag selects over programs that take the mouse (vim's mouse=a, tmux)
		macOptionClickForcesSelection: true,
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.open(container);
	const root = /** @type {HTMLElement} */ (container.querySelector(".xterm"));
	const screen = /** @type {HTMLElement} */ (container.querySelector(".xterm-screen"));
	if (root && screen) screens.set(root, { screen, getScale: options.getScale });

	/** @type {WebSocket | null} */
	let socket = null;
	/** The host said the shell ended, so the socket closing after that isn't a lost connection. */
	let ended = false;
	let disposed = false;
	/** Let go of (locked): output still in the parser from before can't reach the clipboard. */
	let detached = false;
	/** What the keys pressed so far say about copying. */
	let intent = NO_INTENT;

	/** @param {unknown} message */
	function send(message) {
		if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	}

	/** What fits the tile, or null while it has no size (offscreen tiles skip rendering). */
	function proposedSize() {
		const dims = fit.proposeDimensions();
		return dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows) && dims.cols > 0 && dims.rows > 0 ? { cols: dims.cols, rows: dims.rows } : null;
	}

	function fitNow() {
		const size = proposedSize();
		if (!size || (size.cols === term.cols && size.rows === term.rows)) return;
		fit.fit();
		send({ type: "resize", cols: term.cols, rows: term.rows });
	}

	let fitFrame = 0;
	const resizeObserver = new ResizeObserver(() => {
		if (fitFrame) return;
		fitFrame = view.requestAnimationFrame(() => {
			fitFrame = 0;
			if (!disposed) fitNow();
		});
	});
	resizeObserver.observe(container);

	const { mapInput, onArm, onClipboard } = options;
	const copyBar = onClipboard ? null : createCopyBar(doc, container, () => term.focus(), options);

	/** Input on its way to the shell, before the shell answers. @param {string} data */
	function sendInput(data) {
		intent = afterInput(intent, data, cursorLine());
		send({ type: "input", data });
	}

	term.onData((data) => sendInput(mapInput ? mapInput(data) : data));
	term.onBinary((data) => send({ type: "binary", data }));
	term.onTitleChange((title) => options.onTitle(title));
	// a return goes down before xterm sends it, so this sees the line the return runs
	term.attachCustomKeyEventHandler((event) => {
		if (isReturnKey(event)) {
			const next = afterReturn(intent, cursorLine(), Date.now());
			intent = next.intent;
			if (next.armed) onArm?.();
		}
		return true;
	});
	// a second tab on the same shell: the one you type in decides its size
	term.textarea?.addEventListener("focus", () => send({ type: "resize", cols: term.cols, rows: term.rows }));
	term.parser.registerOscHandler(52, (data) => {
		const text = osc52Text(data);
		if (text === null || detached) return true;
		const taken = takeCopy(intent, Date.now());
		intent = taken.intent;
		if (onClipboard) onClipboard(text, taken.allowed);
		else if (!taken.allowed) copyBar?.offer(text);
		else {
			navigator.clipboard.writeText(text).then(
				() => {
					copyBar?.copied(text);
					options.onCopied(text);
				},
				() => copyBar?.offer(text),
			);
		}
		return true;
	});

	/** @param {any} message */
	function onControl(message) {
		if (message?.type === "snapshot" && typeof message.data === "string") {
			term.reset();
			if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && (message.cols !== term.cols || message.rows !== term.rows)) {
				term.resize(message.cols, message.rows);
			}
			term.write(message.data);
			fitNow();
			options.onLive();
		} else if (message?.type === "expires") {
			options.onExpires(typeof message.at === "number" ? message.at : null);
		} else if (message?.type === "exit") {
			ended = true;
			options.onExit(String(message.reason ?? "exited"), typeof message.code === "number" ? message.code : null);
		}
	}

	/** (Re)attaches to the shell: the host sends its screen, then live output. */
	function connect() {
		if (disposed) return;
		closeSocket();
		ended = false;
		detached = false;
		const next = new WebSocket(options.socketUrl(proposedSize()));
		next.binaryType = "arraybuffer";
		socket = next;
		next.addEventListener("message", (event) => {
			if (socket !== next) return;
			if (typeof event.data !== "string") {
				term.write(new Uint8Array(event.data));
				return;
			}
			try {
				onControl(JSON.parse(event.data));
			} catch {
				// not ours
			}
		});
		next.addEventListener("close", () => {
			if (socket !== next) return;
			socket = null;
			if (!ended && !disposed) options.onLost();
		});
	}

	function closeSocket() {
		const current = socket;
		socket = null;
		current?.close();
	}

	/** The rows of the screen xterm shows now (scrollback included on the shell's own screen), trailing blanks dropped. */
	function screenLines() {
		const buffer = term.buffer.active;
		/** @type {string[]} */
		const lines = [];
		for (let index = 0; index < buffer.length; index += 1) {
			const line = buffer.getLine(index);
			if (!line) continue;
			const text = line.translateToString(true);
			if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
			else lines.push(text);
		}
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
		return lines;
	}

	/** The line the cursor is on, with the rows it wrapped from. */
	function cursorLine() {
		const buffer = term.buffer.active;
		let row = buffer.baseY + buffer.cursorY;
		let text = buffer.getLine(row)?.translateToString(true) ?? "";
		while (row > 0 && buffer.getLine(row)?.isWrapped) {
			row -= 1;
			text = (buffer.getLine(row)?.translateToString(true) ?? "") + text;
		}
		return text;
	}

	return {
		connect,
		/** Lets go of the shell and forgets its screen and scrollback; the host sends them again on the next connect. */
		disconnect() {
			closeSocket();
			detached = true;
			intent = NO_INTENT;
			copyBar?.hide();
			term.blur();
			term.reset();
			// output that arrived before the socket closed may still be on its way through the parser
			term.write("", () => {
				if (!disposed) term.reset();
			});
		},
		size: proposedSize,
		focus: () => term.focus(),
		isConnected: () => socket?.readyState === WebSocket.OPEN,
		/** Keys from outside the keyboard (the phone's key bar) go to the shell as typed, past `mapInput`. @param {string} data */
		input(data) {
			term.scrollToBottom();
			sendInput(data);
		},
		/** @param {string} text */
		paste: (text) => term.paste(text),
		screenText: () => screenLines().join("\n"),
		/** vim and friends want arrows as ESC O A rather than ESC [ A. */
		appCursorKeys: () => term.modes.applicationCursorKeysMode,
		dispose() {
			disposed = true;
			view.cancelAnimationFrame(fitFrame);
			resizeObserver.disconnect();
			closeSocket();
			copyBar?.remove();
			if (root) screens.delete(root);
			term.dispose();
		},
	};
}
