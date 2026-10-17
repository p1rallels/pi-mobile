// A terminal tile's screen: xterm (served from the host's node_modules) on a websocket to a shell on the host. The host
// sends the screen first (a snapshot of its mirror), then the shell's raw output as binary frames; keys, pastes and size
// changes go back as JSON. pbcopy in the shell reaches the browser's clipboard as OSC 52, write only: nothing that runs in
// the shell can read the clipboard back.
import { FitAddon } from "/vendor/xterm/addon-fit.mjs";
import { Terminal } from "/vendor/xterm/xterm.mjs";

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

/** @param {string} payload base64 @returns {string} */
function decodeBase64Utf8(payload) {
	const binary = atob(payload);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return new TextDecoder().decode(bytes);
}

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
 * }} options
 */
export function createTerminalView(options) {
	const { container } = options;
	const doc = container.ownerDocument;
	const view = /** @type {Window} */ (doc.defaultView);
	installMouseFix(view);

	const term = new Terminal({
		fontFamily: FONT_FAMILY,
		fontSize: 13,
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

	term.onData((data) => send({ type: "input", data }));
	term.onBinary((data) => send({ type: "binary", data }));
	term.onTitleChange((title) => options.onTitle(title));
	// a second tab on the same shell: the one you type in decides its size
	term.textarea?.addEventListener("focus", () => send({ type: "resize", cols: term.cols, rows: term.rows }));
	term.parser.registerOscHandler(52, (data) => {
		const payload = data.slice(data.indexOf(";") + 1);
		if (!payload || payload === "?") return true;
		let text;
		try {
			text = decodeBase64Utf8(payload);
		} catch {
			return true;
		}
		navigator.clipboard.writeText(text).then(
			() => options.onCopied(text),
			(error) => options.onCopyFailed(error),
		);
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

	return {
		connect,
		size: proposedSize,
		focus: () => term.focus(),
		isConnected: () => socket?.readyState === WebSocket.OPEN,
		dispose() {
			disposed = true;
			view.cancelAnimationFrame(fitFrame);
			resizeObserver.disconnect();
			closeSocket();
			if (root) screens.delete(root);
			term.dispose();
		},
	};
}
