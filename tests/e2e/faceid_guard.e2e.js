// The Face ID / Touch ID guard, wired to a real page with a fake host api, a fake authenticator and a
// fake clock. Real servers on 127.0.0.1 never install the guard (loopback needs no check), so this
// drives the module directly.
import { expect, test } from "@playwright/test";

const MINUTE = 60_000;
const WINDOWS = { freshForSeconds: 900, commandFreshForSeconds: 3600, sessionForSeconds: 14_400 };

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the guard's logic is browser independent; phone behavior is driven by coverWhenAway");
});

/** @param {import("@playwright/test").Page} page */
async function installGuard(page, { verifiedSecondsAgo, coverWhenAway = false, focused = true, failFirst = false }) {
	await page.goto("/health");
	await page.evaluate(
		async (options) => {
			const { installFaceIdGuard } = await import("/app/core/faceid.js");
			const clock = 1_000_000_000;
			const t = {
				clock,
				focused: options.focused,
				// when the fake host last issued this browser a check, on the same clock
				hostVerifiedAt: options.verifiedSecondsAgo === null ? null : clock - options.verifiedSecondsAgo * 1000,
				prompts: 0,
				failNext: options.failFirst,
				started: false,
			};
			const api = {
				getJson: async () => ({
					enrolled: true,
					canRegister: false,
					...options.windows,
					verifiedSecondsAgo: t.hostVerifiedAt === null ? null : Math.floor((t.clock - t.hostVerifiedAt) / 1000),
				}),
				postJson: async (path) => {
					if (path.endsWith("/challenge")) return { challengeId: "c1", options: {} };
					t.hostVerifiedAt = t.clock;
					return { ok: true };
				},
			};
			const webauthn = async () => ({
				startAuthentication: async () => {
					t.prompts += 1;
					if (t.failNext) {
						t.failNext = false;
						throw new Error("The operation either timed out or was not allowed.");
					}
					return { id: "credential" };
				},
				startRegistration: async () => ({ id: "credential" }),
			});
			const guard = installFaceIdGuard({ api, webauthn, now: () => t.clock, hasFocus: () => t.focused, coverWhenAway: options.coverWhenAway });
			Object.assign(window, { __faceid: t });
			void guard.start().then(() => {
				t.started = true;
			});
		},
		{ verifiedSecondsAgo, coverWhenAway, focused, failFirst, windows: WINDOWS },
	);
}

/** @param {import("@playwright/test").Page} page */
const state = (page) =>
	page.evaluate(() => {
		const overlay = document.querySelector(".faceid-overlay");
		const t = /** @type {any} */ (window).__faceid;
		return {
			open: overlay?.classList.contains("open") ?? false,
			subtitle: overlay?.querySelector(".faceid-subtitle")?.textContent ?? "",
			retry: overlay ? !(/** @type {HTMLButtonElement} */ (overlay.querySelector(".faceid-button")).hidden) : false,
			prompts: t.prompts,
			started: t.started,
		};
	});

/** @param {import("@playwright/test").Page} page */
const advance = (page, ms) => page.evaluate((delta) => void (/** @type {any} */ (window).__faceid.clock += delta), ms);

/** @param {import("@playwright/test").Page} page @param {"blur" | "focus"} type */
const fire = (page, type) => page.evaluate((name) => window.dispatchEvent(new Event(name)), type);

test("a check the host has on file from inside the window unlocks without asking", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: 120 });
	await expect.poll(() => state(page)).toMatchObject({ started: true, open: false, prompts: 0 });
});

test("laptop: switching away and back inside the window neither covers nor asks; after it, coming back asks once", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null });
	await expect.poll(() => state(page)).toMatchObject({ started: true, open: false, prompts: 1 });

	await fire(page, "blur");
	expect((await state(page)).open).toBe(false);
	await advance(page, 14 * MINUTE);
	await fire(page, "focus");
	expect(await state(page)).toMatchObject({ open: false, prompts: 1 });

	await advance(page, 2 * MINUTE);
	await fire(page, "blur");
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 2 });
	await fire(page, "focus");
	expect((await state(page)).prompts).toBe(2);
});

test("coming back after the window doesn't ask when another tab passed a check meanwhile", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null });
	await expect.poll(() => state(page)).toMatchObject({ started: true, prompts: 1 });
	await advance(page, 20 * MINUTE);
	await page.evaluate(() => {
		const t = /** @type {any} */ (window).__faceid;
		t.hostVerifiedAt = t.clock - 30_000;
	});
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1 });
});

test("phone: going away covers the page; back inside the window lifts it without asking", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: 60, coverWhenAway: true });
	await expect.poll(() => state(page)).toMatchObject({ started: true, open: false, prompts: 0 });

	await fire(page, "blur");
	expect(await state(page)).toMatchObject({ open: true, subtitle: "Session hidden." });
	await fire(page, "focus");
	expect(await state(page)).toMatchObject({ open: false, prompts: 0 });

	await advance(page, 15 * MINUTE);
	await fire(page, "blur");
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1 });
});

test("a request the host refused for want of a check asks even inside the window", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: 10 });
	await expect.poll(() => state(page)).toMatchObject({ started: true, prompts: 0 });
	await page.evaluate(() =>
		window.dispatchEvent(new CustomEvent("pi-web-faceid-required", { detail: { message: "Fresh Face ID verification required." } })),
	);
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1 });
});

test("a cancelled prompt waits for try again instead of asking on every return", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null, failFirst: true });
	await expect.poll(() => state(page)).toMatchObject({ open: true, retry: true, prompts: 1, started: false });

	await fire(page, "focus");
	await fire(page, "focus");
	expect(await state(page)).toMatchObject({ open: true, prompts: 1 });

	await page.locator(".faceid-button").click();
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 2, started: true });
});

test("a page without focus stays locked and asks once it gets focus", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null, focused: false });
	await expect.poll(() => state(page)).toMatchObject({ open: true, retry: true, prompts: 0, started: false });

	await page.evaluate(() => void (/** @type {any} */ (window).__faceid.focused = true));
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1, started: true });
});
