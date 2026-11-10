// A terminal tile on the canvas. It opens a shell on the host (POST /api/terminals) or attaches to the one it had, and
// keeps attaching through dropped sockets and host restarts: a shell that's gone (the host restarted) comes back as a
// new one in the same folder, never re-running what the old one ran. The red dot asks first when vim, ssh or anything
// else runs in the foreground; exit in the shell closes the tile. Shells end when the Face ID check they run under
// runs out, so the tile counts down the last minutes and offers a check that keeps them open.
//
// Terminals lock whenever the page goes away (see TerminalLock in core/faceid.js). Locked, a tile lets go of its shell
// and forgets its screen until a check passes; clicking it asks for one. Opening a shell asks first, wherever the lock is.
import { noTerminalLock } from "../core/faceid.js";
import { attachRefusal, messageOf, needsFaceId, statusOf } from "./refusals.js";
import { createTerminalView, loadTerminalStyles } from "./terminal_view.js";

const EXPIRY_WARNING_MS = 5 * 60_000;
const RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000];
const FLASH_MS = 2_000;

/** @param {string | null | undefined} cwd */
const folderName = (cwd) => (cwd ? (cwd.split("/").filter(Boolean).at(-1) ?? cwd) : "terminal");

/** "4:05" @param {number} ms */
function clock(ms) {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** @param {string} text */
function lineCount(text) {
	const lines = text.replace(/\n$/, "").split("\n").length;
	return `${lines} line${lines === 1 ? "" : "s"}`;
}

/** @typedef {"waiting" | "locked" | "opening" | "attaching" | "live" | "reconnecting" | "ended" | "failed"} TerminalTileState */

/**
 * One run at a time: a call while one is in flight gets that one (a retry timer, a passed Face ID check and a click
 * can all ask at once, and two opens would start two shells).
 * @param {() => Promise<void>} run
 */
function exclusive(run) {
	/** @type {Promise<void> | null} */
	let running = null;
	return () => {
		running ??= run().finally(() => {
			running = null;
		});
		return running;
	};
}

/** @type {Record<TerminalTileState, { text: string, kind: string }>} */
const PILLS = {
	waiting: { text: "terminal", kind: "idle" },
	locked: { text: "locked", kind: "waiting" },
	opening: { text: "opening…", kind: "idle" },
	attaching: { text: "connecting…", kind: "idle" },
	live: { text: "terminal", kind: "idle" },
	reconnecting: { text: "reconnecting…", kind: "offline" },
	ended: { text: "closed", kind: "offline" },
	failed: { text: "error", kind: "error" },
};

/**
 * @param {{
 *   doc: Document,
 *   api: { getJson: (path: string) => Promise<any>, postJson: (path: string, body: unknown) => Promise<any>, resolveUrl: (path: string) => string },
 *   tile: { body: HTMLElement, titleEl: HTMLElement, statusEl: HTMLElement },
 *   terminalId: string | null,
 *   cwd: string | null,
 *   title: string | null,
 *   getScale: () => number,
 *   isFocused: () => boolean,
 *   refreshClient: () => Promise<unknown>,
 *   onIdChange: (id: string) => void,
 *   onChange: () => void,
 *   onRemove: () => void,
 *   view?: import("./terminal_view.js").TerminalViewExtras,
 *   lock?: import("../core/faceid.js").TerminalLock,
 *   askFirst?: boolean,
 * }} options `askFirst`: ask for a check before the first open or attach, even when the terminals are unlocked
 */
export function createTerminalTile(options) {
	const { doc, api, tile } = options;
	const view = /** @type {Window} */ (doc.defaultView);
	const lock = options.lock ?? noTerminalLock;
	let askFirst = options.askFirst === true;
	let id = options.terminalId;
	let cwd = options.cwd;
	let title = options.title;
	/** @type {TerminalTileState} */
	let state = "waiting";
	let note = "";
	/** @type {number | null} */
	let expiresAt = null;
	let visible = false;
	let destroyed = false;
	let retries = 0;
	let retryTimer = 0;
	let expiryTimer = 0;
	let flashTimer = 0;
	/** What a passed Face ID check should run again. @type {(() => Promise<void>) | null} */
	let afterCheck = null;
	/** @type {ReturnType<typeof createTerminalView> | null} */
	let screen = null;

	/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} className @param {string} [text] */
	function h(tag, className, text) {
		const el = doc.createElement(tag);
		el.className = className;
		if (text !== undefined) el.textContent = text;
		return el;
	}

	const pill = h("span", "cv-pill");
	tile.statusEl.append(pill);
	const screenEl = h("div", "cv-term-screen");
	const expiry = h("div", "cv-term-expiry");
	const expiryText = h("span", "cv-term-expiry-text");
	const keepOpen = h("button", "cv-term-btn", "keep open");
	keepOpen.type = "button";
	expiry.append(expiryText, keepOpen);
	const overlay = h("div", "cv-term-overlay");
	const overlayText = h("div", "cv-term-overlay-text");
	const overlayButton = h("button", "cv-term-btn");
	overlayButton.type = "button";
	overlay.append(overlayText, overlayButton);
	const wrap = h("div", "cv-term");
	wrap.append(screenEl, expiry, overlay);
	tile.body.replaceChildren(wrap);

	/** @param {TerminalTileState} next @param {string} [text] */
	function setState(next, text = "") {
		state = next;
		note = text;
		render();
	}

	function render() {
		const shown = title || folderName(cwd);
		tile.titleEl.textContent = shown;
		tile.titleEl.title = cwd ? `${shown} · ${cwd}` : shown;
		if (!flashTimer) {
			const { text, kind } = PILLS[state];
			pill.textContent = text;
			pill.className = `cv-pill is-${kind}`;
		}
		const locked = state === "locked";
		const action = locked ? (note ? "try again" : "unlock") : state === "ended" ? "new shell" : state === "failed" ? "retry" : null;
		overlay.hidden = action === null;
		overlay.classList.toggle("is-locked", locked);
		overlayText.textContent = locked && !note ? `${lock.name} to unlock this terminal.` : note;
		overlayButton.textContent = action ?? "";
		renderExpiry();
	}

	/** @param {string} text @param {string} [kind] */
	function flash(text, kind = "working") {
		view.clearTimeout(flashTimer);
		pill.textContent = text;
		pill.className = `cv-pill is-${kind}`;
		flashTimer = view.setTimeout(() => {
			flashTimer = 0;
			render();
		}, FLASH_MS);
	}

	function renderExpiry() {
		view.clearTimeout(expiryTimer);
		expiryTimer = 0;
		const left = expiresAt === null ? Number.POSITIVE_INFINITY : expiresAt - Date.now();
		const show = state === "live" && left <= EXPIRY_WARNING_MS;
		expiry.hidden = !show;
		if (show) {
			expiryText.textContent = `closes in ${clock(left)}, when its Face ID check runs out`;
			expiryTimer = view.setTimeout(renderExpiry, 1_000);
		} else if (Number.isFinite(left) && left > 0) {
			expiryTimer = view.setTimeout(renderExpiry, Math.min(left - EXPIRY_WARNING_MS + 50, 2 ** 31 - 1));
		}
	}

	/** Locked (the page went away) or gone: an open or attach under way stops where it is. */
	const halted = () => destroyed || lock.isLocked();

	async function ensureScreen() {
		if (screen) return screen;
		await loadTerminalStyles(doc);
		if (destroyed || screen) return screen;
		screen = createTerminalView({
			...options.view,
			container: screenEl,
			socketUrl: (size) => {
				const query = size ? `?${new URLSearchParams({ cols: String(size.cols), rows: String(size.rows) }).toString()}` : "";
				return api.resolveUrl(`/api/terminals/${encodeURIComponent(id ?? "")}/socket${query}`).replace(/^http/, "ws");
			},
			getScale: options.getScale,
			onTitle: (next) => {
				title = next.trim().slice(0, 200) || null;
				render();
				options.onChange();
			},
			onLive: () => {
				retries = 0;
				setState("live");
				// unlocked with nothing else holding the keyboard: typing goes straight to the shell
				const active = doc.activeElement;
				if (options.isFocused() && (!active || active === doc.body || active === overlayButton)) screen?.focus();
			},
			onExpires: (at) => {
				expiresAt = at;
				renderExpiry();
			},
			onExit: (reason) => onExit(reason),
			onLost: () => {
				if (!halted()) reconnectLater();
			},
			onCopied: (text) => flash(`copied ${lineCount(text)}`),
			onCopyFailed: () => flash("copy failed: click the page, then pbcopy again", "error"),
		});
		if (options.isFocused() && !halted()) screen.focus();
		return screen;
	}

	/**
	 * A refused request: a Face ID check (the tile locks until one passes, then runs `again`), a lost browser session
	 * (made anew, then `once` runs, when there is one), or a failure.
	 * @param {unknown} error @param {() => Promise<void>} again @param {(() => Promise<void>) | null} once @param {string} what
	 */
	async function onRefused(error, again, once, what) {
		if (needsFaceId(error)) {
			afterCheck = again;
			setState("locked");
			lock.refused();
			return;
		}
		if (statusOf(error) === 401 && once) {
			try {
				await options.refreshClient();
			} catch (refreshError) {
				setState("failed", `${what}: ${messageOf(refreshError)}`);
				return;
			}
			await once();
			return;
		}
		setState("failed", `${what}: ${messageOf(error)}`);
	}

	/** A new shell in the tile's folder; the tile takes its id. */
	const openShell = exclusive(() => openShellOnce(false));

	/** @param {boolean} retried */
	async function openShellOnce(retried) {
		const current = await ensureScreen();
		if (!current || halted()) return;
		setState("opening");
		try {
			const info = await api.postJson("/api/terminals", { cwd, ...(current.size() ?? {}) });
			if (destroyed) return;
			// the shell is open on the host: the tile keeps it even if the page locked meanwhile
			id = String(info.id);
			cwd = typeof info.cwd === "string" ? info.cwd : cwd;
			title = null;
			expiresAt = typeof info.expiresAt === "number" ? info.expiresAt : null;
			options.onIdChange(id);
			options.onChange();
			if (halted()) return;
			setState("attaching");
			current.connect();
		} catch (error) {
			if (halted()) return;
			await onRefused(error, openShell, retried ? null : () => openShellOnce(true), "Couldn't open a shell");
		}
	}

	/** Back onto the tile's shell: the host still has it, or it's gone (a restart) and a new one opens in its folder. */
	const attach = exclusive(() => attachOnce(false));

	/** @param {boolean} retried */
	async function attachOnce(retried) {
		if (!id) return openShell();
		const current = await ensureScreen();
		if (!current || halted()) return;
		if (state !== "reconnecting") setState("attaching");
		try {
			const info = await api.getJson(`/api/terminals/${encodeURIComponent(id)}`);
			if (halted()) return;
			expiresAt = typeof info?.expiresAt === "number" ? info.expiresAt : null;
			if (!title && typeof info?.title === "string") title = info.title;
			render();
			current.connect();
		} catch (error) {
			if (halted()) return;
			const refusal = attachRefusal(error);
			if (refusal.then === "exit") onExit(refusal.reason);
			else if (refusal.then === "open") await openShell();
			else if (refusal.then === "refused") await onRefused(error, attach, retried ? null : () => attachOnce(true), "Couldn't attach to the shell");
			else if (refusal.then === "end") end(refusal.note);
			else reconnectLater();
		}
	}

	function reconnectLater() {
		if (destroyed) return;
		setState("reconnecting");
		view.clearTimeout(retryTimer);
		retryTimer = view.setTimeout(
			() => {
				retryTimer = 0;
				void attach();
			},
			RETRY_MS[Math.min(retries, RETRY_MS.length - 1)],
		);
		retries += 1;
	}

	/** @param {string} reason */
	function onExit(reason) {
		// exit in the shell, or closed from another tab: the tile goes, like a terminal window
		if (reason === "exited" || reason === "closed") {
			options.onRemove();
			return;
		}
		// the host is restarting: attach again, which opens a new shell once it's back
		if (reason === "shutdown") {
			reconnectLater();
			return;
		}
		end(reason === "expired" ? "Closed when the Face ID check it ran under ran out." : "This shell ended.");
	}

	/** The tile is done with its shell and says why; "new shell" starts over. @param {string} why */
	function end(why) {
		expiresAt = null;
		setState("ended", why);
	}

	function start() {
		if (destroyed || state !== "waiting" || !visible) return;
		if (askFirst) {
			askFirst = false;
			void unlockHere();
		} else if (lock.isLocked()) {
			setState("locked");
		} else {
			setState(id ? "attaching" : "opening");
			void attach();
		}
	}

	/** Asks for a check; once it passes, the tile picks up where it was. A check that doesn't go through says why. */
	async function unlockHere() {
		setState("locked");
		const error = await lock.unlock();
		if (destroyed || state !== "locked") return;
		// a lock with no checks to pass (loopback) has nobody to tell the tile
		if (error === null) resume();
		else setState("locked", error);
	}

	/** A check passed: back onto the shell, or what was waiting on the check. A tile that never showed waits to be on screen. */
	function resume() {
		if (destroyed || state !== "locked") return;
		if (!screen && !visible) {
			setState("waiting");
			return;
		}
		const run = afterCheck ?? attach;
		afterCheck = null;
		setState(id ? "attaching" : "opening");
		void run();
	}

	/** The page went away: the shell keeps running on the host, the tile lets go of it and forgets its screen. */
	function lockScreen() {
		if (destroyed) return;
		view.clearTimeout(retryTimer);
		retryTimer = 0;
		const hadKeyboard = screenEl.contains(doc.activeElement);
		screen?.disconnect();
		if (state === "waiting" || state === "ended") return;
		setState("locked");
		if (hadKeyboard) overlayButton.focus({ preventScroll: true });
	}

	const unwatch = lock.watch({
		onLock: lockScreen,
		onUnlock: resume,
		wantsUnlock: () => visible && !destroyed && state === "locked",
	});

	overlayButton.addEventListener("click", () => {
		if (state === "locked") {
			void unlockHere();
		} else if (state === "ended") {
			// a new shell is a new terminal: it asks first
			afterCheck = openShell;
			void unlockHere();
		} else if (state === "failed") {
			void attach();
		}
	});
	// a click anywhere on a locked tile asks, not just on its button
	overlay.addEventListener("click", (event) => {
		if (state !== "locked" || overlayButton.contains(/** @type {Node | null} */ (event.target))) return;
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		void unlockHere();
	});
	keepOpen.addEventListener("click", () => {
		// any check on the host keeps its shells open for another Face ID session
		void lock.unlock().then((error) => {
			if (error !== null) flash(`not kept open: ${error}`, "error");
		});
	});

	render();

	return {
		getId: () => id,
		getCwd: () => cwd,
		getTitle: () => title,
		/** The screen once it opened (the phone's key bar types into it). */
		getView: () => screen,
		flash,
		focus() {
			if (state === "locked") overlayButton.focus({ preventScroll: true });
			else screen?.focus();
		},
		/** The view only opens once the tile is on screen (it needs a size to measure); after that it stays. @param {boolean} next */
		setVisible(next) {
			visible = next;
			start();
		},
		/** The red dot: closes the shell (asking first when something runs in its foreground), then the tile. */
		async requestClose() {
			if (!id || state === "ended" || state === "failed") {
				options.onRemove();
				return;
			}
			const path = `/api/terminals/${encodeURIComponent(id)}/close`;
			try {
				await api.postJson(path, {});
			} catch (error) {
				const busy = statusOf(error) === 409 ? /** @type {any} */ (error).body?.busy : null;
				if (typeof busy === "string") {
					// the dialog takes focus from the page, which isn't leaving it
					if (!lock.holdFocus(() => view.confirm(`${busy} is still running in this terminal. Close it anyway?`))) return;
					try {
						await api.postJson(path, { force: true });
					} catch (forced) {
						if (statusOf(forced) !== 404) {
							flash(`couldn't close: ${messageOf(forced)}`, "error");
							return;
						}
					}
				} else if (statusOf(error) !== 404) {
					flash(`couldn't close: ${messageOf(error)}`, "error");
					return;
				}
			}
			options.onRemove();
		},
		/** Leaves the shell running (another host's canvas took over the page). */
		destroy() {
			destroyed = true;
			view.clearTimeout(retryTimer);
			view.clearTimeout(expiryTimer);
			view.clearTimeout(flashTimer);
			unwatch();
			screen?.dispose();
			screen = null;
		},
	};
}
