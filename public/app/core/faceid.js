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

function prefersCoverWhenAway() {
	return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Locks the page behind a Face ID / Touch ID check.
 * - A passed check stays good for the host's fresh window: coming back to the page or reloading it inside the
 *   window doesn't ask; coming back after it does. A request the host refused for want of a check always asks.
 * - It only prompts while the page has focus (browsers refuse WebAuthn otherwise); a locked page without focus
 *   prompts once it gets focus, or when the button is clicked.
 * - After a failed or cancelled prompt it waits for "Try again" instead of prompting on every return.
 * - Touch devices cover the page while they're away, so the app switcher shows the card, not the session.
 */
export function installFaceIdGuard({
	api,
	webauthn = loadSimpleWebAuthn,
	now = () => Date.now(),
	hasFocus = () => document.hasFocus(),
	coverWhenAway = prefersCoverWhenAway(),
}) {
	const ui = createOverlay();
	let locked = false;
	let inFlight = false;
	let watching = false;
	let failed = false;
	let hostDemandsCheck = false;
	let verifiedAt = null;
	let freshMs = 0;
	let initialUnlockResolve = null;

	function resolveInitialUnlock() {
		const resolve = initialUnlockResolve;
		initialUnlockResolve = null;
		if (typeof resolve === "function") resolve();
	}

	function setLocked(value) {
		locked = value;
		document.body.classList.toggle("faceid-locked", value);
		ui.overlay.classList.toggle("open", value);
	}

	function setStatus(text, { showRetry = false } = {}) {
		if (ui.subtitle) ui.subtitle.textContent = text;
		if (ui.button) ui.button.hidden = !showRetry;
	}

	function unlock() {
		setLocked(false);
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

	async function runCheck() {
		if (inFlight) return;
		inFlight = true;
		failed = false;
		setStatus("Prompting Face ID…");
		try {
			if (!window.isSecureContext) {
				throw new Error("Face ID requires a secure origin (HTTPS or localhost).");
			}
			if (!window.PublicKeyCredential || !navigator.credentials) {
				throw new Error("WebAuthn is not supported in this browser.");
			}
			const status = await readStatus();
			if (!hostDemandsCheck && status.enrolled && checkIsFresh()) {
				unlock();
				return;
			}
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
			verifiedAt = now();
			hostDemandsCheck = false;
			unlock();
		} catch (error) {
			failed = true;
			setLocked(true);
			setStatus(normalizeErrorMessage(error), { showRetry: true });
		} finally {
			inFlight = false;
		}
	}

	function requireCheck(message) {
		setLocked(true);
		if (hasFocus()) {
			setStatus(message);
			void runCheck();
			return;
		}
		setStatus(message, { showRetry: true });
	}

	function onAway() {
		if (!watching || inFlight || locked || !coverWhenAway) return;
		setLocked(true);
		setStatus("Session hidden.");
	}

	function onReturn() {
		if (!watching || inFlight || failed) return;
		if (hostDemandsCheck || !checkIsFresh()) {
			requireCheck("Face ID is required to continue.");
			return;
		}
		if (locked) unlock();
	}

	function bindVisibilityHooks() {
		window.addEventListener("blur", onAway);
		window.addEventListener("focus", onReturn);
		window.addEventListener("pageshow", onReturn);
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") onAway();
			else onReturn();
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
				failed = false;
				setLocked(true);
				void runCheck();
			});
		}
	}

	return {
		async start() {
			bindVisibilityHooks();
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
			requireCheck("Prompting Face ID…");
			await unlocked;
		},
	};
}
