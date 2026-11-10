// The terminals' own lock (TerminalLock in faceid.js) around a Face ID / Touch ID prompt, wired to a real page with a
// fake host api, a fake authenticator whose steps can be held open, a fake page visibility and a watcher standing in
// for a terminal tile. Going out of sight while a prompt is up locks the terminals like any other away, and that
// prompt's check can't unlock them; the sheet's own blur doesn't count.
import { expect, test } from "@playwright/test";

const WENT_AWAY = "The page went away before the check finished. Unlock again.";
const CANCELLED = "The operation either timed out or was not allowed.";

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the guard's logic is browser independent; phone behavior is driven by `touch`");
});

/** @param {import("@playwright/test").Page} page */
async function installGuard(page, { touch = false } = {}) {
	await page.goto("/health");
	await page.evaluate(
		async (options) => {
			const { installFaceIdGuard } = await import("/app/core/faceid.js");
			const t = {
				clock: 1_000_000_000,
				visibility: "visible",
				focused: true,
				hostVerifiedAt: 1_000_000_000,
				prompts: 0,
				locksSent: 0,
				drops: 0,
				unlocks: 0,
				/** which step of the next prompt waits for `release`: "authenticate" (the sheet is up) or "verify" (it passed, the host hasn't answered) */
				hold: /** @type {"authenticate" | "verify" | null} */ (null),
				/** @type {((ok: boolean) => void) | null} */
				release: null,
				/** the last terminal unlock: undefined while it's pending, else what it said */
				result: /** @type {string | null | undefined} */ (undefined),
				started: false,
			};
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => t.visibility });
			/** @param {"authenticate" | "verify"} step */
			const gate = (step) => {
				if (t.hold !== step) return Promise.resolve();
				t.hold = null;
				return new Promise((resolve, reject) => {
					t.release = (ok) => {
						t.release = null;
						if (ok) resolve(undefined);
						else reject(new Error(options.cancelled));
					};
				});
			};
			const api = {
				getJson: async () => ({
					enrolled: true,
					canRegister: false,
					freshForSeconds: 900,
					commandFreshForSeconds: 3600,
					sessionForSeconds: 14_400,
					verifiedSecondsAgo: Math.floor((t.clock - t.hostVerifiedAt) / 1000),
				}),
				postJson: async (path) => {
					if (path.endsWith("/challenge")) return { challengeId: "c1", options: {} };
					await gate("verify");
					t.hostVerifiedAt = t.clock;
					return { ok: true };
				},
			};
			const webauthn = async () => ({
				startAuthentication: async () => {
					t.prompts += 1;
					await gate("authenticate");
					return { id: "credential" };
				},
				startRegistration: async () => ({ id: "credential" }),
			});
			const guard = installFaceIdGuard({
				api,
				webauthn,
				now: () => t.clock,
				hasFocus: () => t.focused,
				touch: options.touch,
				sendTerminalLock: async () => {
					t.locksSent += 1;
				},
			});
			// a terminal tile: a lock drops its screen and socket, an unlock picks the shell back up
			guard.terminals.watch({
				onLock: () => void (t.drops += 1),
				onUnlock: () => void (t.unlocks += 1),
				wantsUnlock: () => false,
			});
			Object.assign(window, {
				__faceid: t,
				__unlockTerminals: () => {
					t.result = undefined;
					void guard.terminals.unlock().then((result) => {
						t.result = result;
					});
				},
				__terminalsLocked: () => guard.terminals.isLocked(),
			});
			void guard.start().then(() => {
				t.started = true;
			});
		},
		{ touch, cancelled: CANCELLED },
	);
	await expect.poll(() => state(page)).toMatchObject({ started: true, locked: true, locksSent: 1 });
}

/** @param {import("@playwright/test").Page} page */
const state = (page) =>
	page.evaluate(() => {
		const t = /** @type {any} */ (window).__faceid;
		return {
			locked: /** @type {any} */ (window).__terminalsLocked(),
			prompts: t.prompts,
			locksSent: t.locksSent,
			drops: t.drops,
			unlocks: t.unlocks,
			result: t.result,
			pending: t.release !== null,
			started: t.started,
		};
	});

/**
 * Asks for a check on the terminals (a locked tile's unlock, or keep open on a live one).
 * @param {import("@playwright/test").Page} page @param {"authenticate" | "verify" | null} hold
 */
async function unlockTerminals(page, hold = null) {
	await page.evaluate((step) => {
		/** @type {any} */ (window).__faceid.hold = step;
		/** @type {any} */ (window).__unlockTerminals();
	}, hold);
	if (hold !== null) await expect.poll(() => state(page)).toMatchObject({ pending: true, result: undefined });
}

/** @param {import("@playwright/test").Page} page */
async function unlockedTerminal(page) {
	await unlockTerminals(page);
	await expect.poll(() => state(page)).toMatchObject({ locked: false, result: null, unlocks: 1 });
}

/** @param {import("@playwright/test").Page} page @param {boolean} ok */
const release = (page, ok) => page.evaluate((passed) => /** @type {any} */ (window).__faceid.release(passed), ok);

/** @param {import("@playwright/test").Page} page @param {"blur" | "hidden" | "pagehide"} how */
const goAway = (page, how) =>
	page.evaluate((kind) => {
		const t = /** @type {any} */ (window).__faceid;
		if (kind === "blur") {
			t.focused = false;
			window.dispatchEvent(new Event("blur"));
		} else if (kind === "hidden") {
			t.focused = false;
			t.visibility = "hidden";
			window.dispatchEvent(new Event("blur"));
			document.dispatchEvent(new Event("visibilitychange"));
		} else {
			window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		}
	}, how);

/** @param {import("@playwright/test").Page} page */
const comeBack = (page) =>
	page.evaluate(() => {
		const t = /** @type {any} */ (window).__faceid;
		t.visibility = "visible";
		t.focused = true;
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("focus"));
	});

for (const [touch, how] of /** @type {const} */ ([
	[false, "hidden"],
	[false, "pagehide"],
	[true, "hidden"],
	[true, "pagehide"],
])) {
	test(`${touch ? "phone" : "laptop"}: ${how} during a keep open prompt locks the terminals right away, and after a cancel they stay locked`, async ({
		page,
	}) => {
		await installGuard(page, { touch });
		await unlockedTerminal(page);
		await unlockTerminals(page, "authenticate");
		await goAway(page, "blur");
		expect(await state(page)).toMatchObject({ locked: false, locksSent: 1, drops: 0 });

		await goAway(page, how);
		expect(await state(page)).toMatchObject({ locked: true, locksSent: 2, drops: 1 });

		await release(page, false);
		await expect.poll(() => state(page)).toMatchObject({ locked: true, result: CANCELLED, drops: 1, unlocks: 1 });
		// back inside the fresh window: the shell still wants a new check
		await comeBack(page);
		expect(await state(page)).toMatchObject({ locked: true, prompts: 2, unlocks: 1 });
	});
}

test("a keep open check that lands while the page is hidden doesn't count: the terminals stay locked", async ({ page }) => {
	await installGuard(page);
	await unlockedTerminal(page);
	await unlockTerminals(page, "verify");
	await goAway(page, "hidden");
	expect(await state(page)).toMatchObject({ locked: true, locksSent: 2, drops: 1 });

	await release(page, true);
	await expect.poll(() => state(page)).toMatchObject({ locked: true, result: WENT_AWAY, unlocks: 1 });
	// the host recorded that check after the away's lock, so it's told again
	expect((await state(page)).locksSent).toBe(3);
	await comeBack(page);
	expect(await state(page)).toMatchObject({ locked: true, prompts: 2, unlocks: 1 });
});

test("unlocking a locked terminal: a check that lands after the page went away and came back doesn't count", async ({ page }) => {
	await installGuard(page);
	await unlockTerminals(page, "authenticate");
	await goAway(page, "hidden");
	await comeBack(page);
	expect(await state(page)).toMatchObject({ locked: true, drops: 0 });

	await release(page, true);
	await expect.poll(() => state(page)).toMatchObject({ locked: true, result: WENT_AWAY, unlocks: 0 });

	await unlockTerminals(page);
	await expect.poll(() => state(page)).toMatchObject({ locked: false, result: null, unlocks: 1, prompts: 2 });
});

for (const touch of [false, true]) {
	test(`${touch ? "phone" : "laptop"}: the sheet's blur during a prompt doesn't lock, and its check unlocks`, async ({ page }) => {
		await installGuard(page, { touch });
		await unlockTerminals(page, "authenticate");
		await goAway(page, "blur");
		await release(page, true);
		await comeBack(page);
		await expect.poll(() => state(page)).toMatchObject({ locked: false, result: null, unlocks: 1, drops: 0, locksSent: 1 });

		// keep open on the live terminal: the same
		await unlockTerminals(page, "authenticate");
		await goAway(page, "blur");
		await release(page, true);
		await comeBack(page);
		await expect.poll(() => state(page)).toMatchObject({ locked: false, result: null, unlocks: 2, drops: 0, locksSent: 1 });
	});
}

test("control: going out of sight with no prompt up locks the terminals", async ({ page }) => {
	await installGuard(page);
	await unlockedTerminal(page);
	await goAway(page, "hidden");
	expect(await state(page)).toMatchObject({ locked: true, locksSent: 2, drops: 1 });
	await comeBack(page);
	expect(await state(page)).toMatchObject({ locked: true, prompts: 1 });
});
