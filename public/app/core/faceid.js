let simpleWebAuthnPromise = null;

function loadSimpleWebAuthn() {
	if (!simpleWebAuthnPromise) {
		simpleWebAuthnPromise = import("/vendor/simplewebauthn/browser/esm/index.js");
	}
	return simpleWebAuthnPromise;
}

function createOverlay() {
	const overlay = document.createElement("div");
	overlay.className = "faceid-overlay";
	overlay.innerHTML = `
		<div class="faceid-card">
			<div class="faceid-title">Face ID Required</div>
			<div class="faceid-subtitle" id="faceid-subtitle">Verifying your presence…</div>
			<button class="faceid-button" id="faceid-button" type="button" hidden>Try again</button>
		</div>
	`;
	document.body.appendChild(overlay);
	return {
		overlay,
		subtitle: overlay.querySelector("#faceid-subtitle"),
		button: overlay.querySelector("#faceid-button"),
	};
}

function normalizeErrorMessage(error) {
	if (!error) return "Face ID verification failed.";
	if (typeof error.message === "string" && error.message.length > 0) return error.message;
	return String(error);
}

/**
 * How long a passed check stays good, per the host's status: the shortest window the host enforces, so a check
 * the page treats as fresh never gets refused. 0 (a host that doesn't say) asks again on every return.
 */
export function freshWindowMs(status) {
	const windows = [status?.freshForSeconds, status?.commandFreshForSeconds, status?.sessionForSeconds]
		.map(Number)
		.filter((seconds) => Number.isFinite(seconds) && seconds > 0);
	return windows.length > 0 ? Math.min(...windows) * 1000 : 0;
}

/** When this browser last passed a check, on this browser's clock, or null when the host has none on file. */
export function verifiedAtFromStatus(status, now) {
	const ago = status?.verifiedSecondsAgo;
	return typeof ago === "number" && Number.isFinite(ago) && ago >= 0 ? now - ago * 1000 : null;
}

export function isCheckFresh(verifiedAt, freshMs, now) {
	if (verifiedAt === null) return false;
	const age = now - verifiedAt;
	return age >= 0 && age < freshMs;
}

function prefersTouch() {
	return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

const UNLOCK_TEXT = "Unlock to continue.";
/** A dialog of ours (closing a shell that runs vim) takes focus from the page; its blur can land just after it closes. */
const HOLD_TAIL_MS = 500;
/** A prompt waits this long at most for the host to have the lock it was sent, so the check lands after it. */
const LOCK_WAIT_MS = 2_000;

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tells the host serving the page that this browser's terminals are locked; keepalive, since the page may be on its way out. */
function postTerminalLock() {
	return fetch(new URL("/api/terminals/lock", window.location.origin), { method: "POST", credentials: "include", keepalive: true }).then(
		() => undefined,
		() => undefined,
	);
}

/**
 * Terminals lock apart from the page, since a shell (ssh to prod in it, say) wants more than the page's window.
 * - They lock whenever the page goes away: out of sight (another tab, the app switcher, a locked screen) or out of
 *   focus (another app or window). Neither our own prompt, which takes focus while it's up, nor a dialog run through
 *   `holdFocus` counts. Locked, a terminal drops its screen and its socket, and the host refuses this browser its
 *   shells until the next check.
 * - Only a check passed in this page since unlocks them: one asked for with `unlock` (a click on a locked terminal,
 *   opening one), or the page's own when it asks. A check another tab passed doesn't count.
 * - Phones ask by themselves on the way back when a locked terminal is on screen (`wantsUnlock`); laptops wait for a
 *   click, since the passkey sheet blocks every Chrome tab. After a prompt that didn't go through, phones wait too.
 * @typedef {{ onLock: () => void, onUnlock: () => void, wantsUnlock: () => boolean }} TerminalLockWatcher
 * @typedef {{
 *   name: string,
 *   isLocked: () => boolean,
 *   watch: (watcher: TerminalLockWatcher) => () => void,
 *   unlock: () => Promise<string | null>,
 *   lock: () => void,
 *   refused: () => void,
 *   holdFocus: <T>(run: () => T) => T,
 * }} TerminalLock
 */

/** Terminals on a host that asks for no check (loopback) never lock. @type {TerminalLock} */
export const noTerminalLock = Object.freeze({
	name: "Face ID",
	isLocked: () => false,
	watch: () => () => {},
	unlock: async () => null,
	lock: () => {},
	refused: () => {},
	holdFocus: (run) => run(),
});

/**
 * Locks the page behind a Face ID / Touch ID check.
 * - A passed check stays good for the host's fresh window: coming back to the page or reloading it inside the
 *   window doesn't ask; coming back after it does. A request the host refused for want of a check always asks.
 * - Laptops never prompt by themselves: Chrome on macOS hangs the passkey sheet on the whole window, which
 *   blocks every tab. The page locks and waits for Unlock (click or Enter). Phones prompt by themselves (Face ID
 *   needs nothing from you), but only with focus, since browsers refuse WebAuthn otherwise.
 * - A locked page swallows keys, so nothing underneath (esc aborts a run) acts while it's locked.
 * - After a failed or cancelled prompt it waits for "Try again" instead of prompting on every return.
 * - Touch devices cover the page while they're away, so the app switcher shows the card, not the session.
 * - Terminals have a lock of their own (`terminals`, see TerminalLock). The page and its terminals share one prompt,
 *   and one check is good for both.
 */
export function installFaceIdGuard({
	api,
	webauthn = loadSimpleWebAuthn,
	now = () => Date.now(),
	hasFocus = () => document.hasFocus(),
	touch = prefersTouch(),
	coverWhenAway = touch,
	autoPrompt = touch,
	sendTerminalLock = postTerminalLock,
}) {
	const ui = createOverlay();
	let locked = false;
	let inFlight = false;
	let watching = false;
	let failed = false;
	let hostDemandsCheck = false;
	let lockMessage = UNLOCK_TEXT;
	let verifiedAt = null;
	let freshMs = 0;
	let initialUnlockResolve = null;
	let focusBeforeLock = null;
	/** The one Face ID / Touch ID prompt up at a time; the page and its terminals both join it. @type {Promise<void> | null} */
	let prompting = null;
	let terminalsLocked = true;
	/** A terminal prompt that didn't go through: phones stop asking on their own until one does. */
	let terminalPromptFailed = false;
	/** @type {Set<TerminalLockWatcher>} */
	const terminalWatchers = new Set();
	/** The last lock sent to the host. @type {Promise<void>} */
	let terminalLockSent = Promise.resolve();
	let holding = 0;
	let heldUntil = 0;

	function resolveInitialUnlock() {
		const resolve = initialUnlockResolve;
		initialUnlockResolve = null;
		if (typeof resolve === "function") resolve();
	}

	function setLocked(value) {
		if (value && !locked) rememberFocus();
		locked = value;
		document.body.classList.toggle("faceid-locked", value);
		ui.overlay.classList.toggle("open", value);
	}

	function rememberFocus() {
		const active = document.activeElement;
		focusBeforeLock = active && active !== document.body && !ui.overlay.contains(active) ? active : null;
	}

	/** Unlock moves the keyboard to its button; give it back to whatever had it, e.g. a tile's composer. */
	function restoreFocus() {
		const target = focusBeforeLock;
		focusBeforeLock = null;
		if (target && target.isConnected && typeof target.focus === "function") target.focus({ preventScroll: true });
	}

	/** The subtitle, and the button (with the keyboard, so Enter presses it) or none. */
	function setStatus(text, { button = null } = {}) {
		if (ui.subtitle) ui.subtitle.textContent = text;
		if (!ui.button) return;
		ui.button.hidden = button === null;
		if (button === null) return;
		ui.button.textContent = button;
		ui.button.focus({ preventScroll: true });
	}

	function unlock() {
		const wasLocked = locked;
		setLocked(false);
		if (wasLocked) restoreFocus();
		resolveInitialUnlock();
	}

	function checkIsFresh() {
		return isCheckFresh(verifiedAt, freshMs, now());
	}

	async function readStatus() {
		const status = await api.getJson("/api/faceid/status");
		freshMs = freshWindowMs(status);
		verifiedAt = verifiedAtFromStatus(status, now());
		return status;
	}

	async function createChallenge(kind) {
		return api.postJson("/api/faceid/challenge", { kind });
	}

	async function verifyChallenge(challengeId, credential) {
		return api.postJson("/api/faceid/verify", { challengeId, credential });
	}

	async function runRegistration() {
		const challenge = await createChallenge("register");
		const { startRegistration } = await webauthn();
		const credential = await startRegistration({ optionsJSON: challenge.options });
		await verifyChallenge(challenge.challengeId, credential);
	}

	async function runAuthentication() {
		const challenge = await createChallenge("authenticate");
		const { startAuthentication } = await webauthn();
		const assertion = await startAuthentication({ optionsJSON: challenge.options });
		await verifyChallenge(challenge.challengeId, assertion);
	}

	function assertWebAuthnUsable() {
		if (!window.isSecureContext) {
			throw new Error("Face ID requires a secure origin (HTTPS or localhost).");
		}
		if (!window.PublicKeyCredential || !navigator.credentials) {
			throw new Error("WebAuthn is not supported in this browser.");
		}
	}

	/** Asks for Face ID / Touch ID (enrolling this browser the first time). Asking while a prompt is up joins that one. */
	function prompt(knownStatus = null) {
		prompting ??= runPrompt(knownStatus).finally(() => {
			prompting = null;
		});
		return prompting;
	}

	async function runPrompt(knownStatus) {
		assertWebAuthnUsable();
		await Promise.race([terminalLockSent, delay(LOCK_WAIT_MS)]);
		const status = knownStatus ?? (await readStatus());
		if (!status.enrolled) {
			if (!status.canRegister) {
				throw new Error(
					"First-time remote Face ID enrollment requires secure mode with an enrolled mTLS device certificate, or enrollment from a trusted local browser.",
				);
			}
			setStatus("First-time setup: approve Face ID to enroll this browser.");
			await runRegistration();
		}
		setStatus("Confirm with Face ID to unlock.");
		await runAuthentication();
		passed();
	}

	/** A check went through: it's good for the page's window, and for the terminals unless the page went away meanwhile. */
	function passed() {
		verifiedAt = now();
		hostDemandsCheck = false;
		lockMessage = UNLOCK_TEXT;
		failed = false;
		if (locked) unlock();
		if (document.visibilityState === "hidden") return;
		terminalPromptFailed = false;
		terminalsLocked = false;
		for (const watcher of [...terminalWatchers]) watcher.onUnlock();
	}

	/**
	 * Unlocks when the host has a check on file that's still good (another tab may have passed one), otherwise
	 * prompts: on a gesture, or by itself where that's allowed; else it offers Unlock and waits.
	 */
	async function runCheck({ gesture }) {
		if (inFlight) return;
		inFlight = true;
		failed = false;
		try {
			assertWebAuthnUsable();
			const status = await readStatus();
			if (!hostDemandsCheck && status.enrolled && checkIsFresh()) {
				unlock();
				return;
			}
			if (!gesture && !autoPrompt) {
				setStatus(lockMessage, { button: "Unlock" });
				return;
			}
			setStatus("Prompting Face ID…");
			await prompt(status);
			unlock();
		} catch (error) {
			failed = true;
			setLocked(true);
			setStatus(normalizeErrorMessage(error), { button: "Try again" });
		} finally {
			inFlight = false;
		}
	}

	function requireCheck(message) {
		lockMessage = message;
		setLocked(true);
		if (autoPrompt && !hasFocus()) {
			setStatus(message, { button: "Unlock" });
			return;
		}
		setStatus(message);
		void runCheck({ gesture: false });
	}

	function lockTerminals() {
		if (terminalsLocked) return;
		terminalsLocked = true;
		terminalLockSent = sendTerminalLock();
		for (const watcher of [...terminalWatchers]) watcher.onLock();
	}

	/** @param {"blur" | "hidden"} how */
	function terminalsAway(how) {
		if (prompting) return;
		if (how === "blur" && (holding > 0 || performance.now() < heldUntil)) return;
		lockTerminals();
	}

	/** @returns {Promise<string | null>} null once the terminals are unlocked, else why they aren't */
	async function unlockTerminals() {
		try {
			await prompt();
		} catch (error) {
			terminalPromptFailed = true;
			return normalizeErrorMessage(error);
		}
		return terminalsLocked ? "The page went away before the check finished. Unlock again." : null;
	}

	function askForTerminals() {
		if (!terminalsLocked || !autoPrompt || terminalPromptFailed || prompting || !hasFocus()) return;
		if ([...terminalWatchers].some((watcher) => watcher.wantsUnlock())) void unlockTerminals();
	}

	/** @template T @param {() => T} run */
	function holdFocus(run) {
		holding += 1;
		try {
			return run();
		} finally {
			holding -= 1;
			heldUntil = performance.now() + HOLD_TAIL_MS;
		}
	}

	/** @type {TerminalLock} */
	const terminals = {
		name: touch ? "Face ID" : "Touch ID",
		isLocked: () => terminalsLocked,
		watch(watcher) {
			terminalWatchers.add(watcher);
			return () => {
				terminalWatchers.delete(watcher);
			};
		},
		unlock: unlockTerminals,
		lock: lockTerminals,
		/** The host refused a terminal (another tab locked them, or the check got too old): a phone asks right away. */
		refused() {
			if (autoPrompt && !terminalPromptFailed && !prompting && hasFocus()) void unlockTerminals();
		},
		holdFocus,
	};

	function onAway() {
		if (!watching || inFlight || prompting || locked || !coverWhenAway) return;
		setLocked(true);
		setStatus("Session hidden.");
	}

	function onReturn() {
		if (!watching || inFlight || prompting || failed) return;
		if (hostDemandsCheck || !checkIsFresh()) {
			// the check it asks for unlocks the terminals too
			requireCheck(hostDemandsCheck ? lockMessage : UNLOCK_TEXT);
			return;
		}
		if (locked) unlock();
		askForTerminals();
	}

	function swallowKeysWhileLocked(event) {
		if (!locked) return;
		event.stopImmediatePropagation();
		const shortcut = event.metaKey || event.ctrlKey || event.altKey;
		if (!shortcut && !ui.overlay.contains(event.target)) event.preventDefault();
	}

	function bindVisibilityHooks() {
		window.addEventListener("keydown", swallowKeysWhileLocked, true);
		window.addEventListener("keyup", swallowKeysWhileLocked, true);
		window.addEventListener("blur", () => {
			terminalsAway("blur");
			onAway();
		});
		window.addEventListener("focus", onReturn);
		window.addEventListener("pageshow", onReturn);
		window.addEventListener("pagehide", () => terminalsAway("hidden"));
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				terminalsAway("hidden");
				onAway();
			} else {
				onReturn();
			}
		});

		window.addEventListener("pi-web-faceid-required", (event) => {
			const message =
				event && event.detail && typeof event.detail.message === "string"
					? event.detail.message
					: "Fresh Face ID verification required.";
			verifiedAt = null;
			hostDemandsCheck = true;
			failed = false;
			requireCheck(message);
		});

		if (ui.button) {
			ui.button.addEventListener("click", () => {
				setLocked(true);
				void runCheck({ gesture: true });
			});
		}
	}

	return {
		async start() {
			bindVisibilityHooks();
			// a page that just loaded starts with its terminals locked, on the host too
			terminalLockSent = sendTerminalLock();
			const unlocked = new Promise((resolve) => {
				initialUnlockResolve = resolve;
			});
			try {
				await readStatus();
			} catch {
				verifiedAt = null;
			}
			watching = true;
			if (checkIsFresh()) {
				unlock();
				return;
			}
			requireCheck(UNLOCK_TEXT);
			await unlocked;
		},
		terminals,
	};
}
