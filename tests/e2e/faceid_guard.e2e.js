// The Face ID / Touch ID guard, wired to a real page with a fake host api, a fake authenticator and a
// fake clock. Real servers on 127.0.0.1 never install the guard (loopback needs no check), so this
// drives the module directly. `touch` picks phone behavior (cover when away, prompt by itself) over laptop.
import { expect, test } from "@playwright/test";

const MINUTE = 60_000;
const WINDOWS = { freshForSeconds: 900, commandFreshForSeconds: 3600, sessionForSeconds: 14_400 };

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the guard's logic is browser independent; phone behavior is driven by `touch`");
});

/** @param {import("@playwright/test").Page} page */
async function installGuard(page, { verifiedSecondsAgo, touch = false, focused = true, failFirst = false }) {
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
			const guard = installFaceIdGuard({ api, webauthn, now: () => t.clock, hasFocus: () => t.focused, touch: options.touch });
			Object.assign(window, { __faceid: t });
			void guard.start().then(() => {
				t.started = true;
			});
		},
		{ verifiedSecondsAgo, touch, focused, failFirst, windows: WINDOWS },
	);
}

/** @param {import("@playwright/test").Page} page */
const state = (page) =>
	page.evaluate(() => {
		const overlay = document.querySelector(".faceid-overlay");
		const button = /** @type {HTMLButtonElement | null} */ (overlay?.querySelector(".faceid-button") ?? null);
		const t = /** @type {any} */ (window).__faceid;
		return {
			open: overlay?.classList.contains("open") ?? false,
			subtitle: overlay?.querySelector(".faceid-subtitle")?.textContent ?? "",
			button: button && !button.hidden ? button.textContent : null,
			buttonHasKeyboard: button !== null && document.activeElement === button,
			prompts: t.prompts,
			started: t.started,
		};
	});

/** @param {import("@playwright/test").Page} page */
const advance = (page, ms) => page.evaluate((delta) => void (/** @type {any} */ (window).__faceid.clock += delta), ms);

/** @param {import("@playwright/test").Page} page @param {"blur" | "focus"} type */
const fire = (page, type) => page.evaluate((name) => window.dispatchEvent(new Event(name)), type);

/** @param {import("@playwright/test").Page} page */
const hostRefuses = (page) =>
	page.evaluate(() =>
		window.dispatchEvent(new CustomEvent("pi-web-faceid-required", { detail: { message: "Fresh Face ID verification required." } })),
	);

test("a check the host has on file from inside the window unlocks without asking", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: 120 });
	await expect.poll(() => state(page)).toMatchObject({ started: true, open: false, prompts: 0 });
});

test("laptop: never prompts by itself; unlock prompts; switching away and back inside the window does nothing", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null });
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Unlock", buttonHasKeyboard: true, prompts: 0, started: false });
	await page.locator(".faceid-button").click();
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1, started: true });

	await fire(page, "blur");
	expect((await state(page)).open).toBe(false);
	await advance(page, 14 * MINUTE);
	await fire(page, "focus");
	expect(await state(page)).toMatchObject({ open: false, prompts: 1 });

	await advance(page, 2 * MINUTE);
	await fire(page, "blur");
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Unlock", buttonHasKeyboard: true, prompts: 1 });
	await page.keyboard.press("Enter");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 2 });
});

test("a passed check tells the page (pi-web-faceid-unlocked), so streams the host closed for want of one reconnect", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null });
	await page.evaluate(() => {
		const t = /** @type {any} */ (window).__faceid;
		t.unlocked = 0;
		window.addEventListener("pi-web-faceid-unlocked", () => void (t.unlocked += 1));
	});
	const unlocked = () => page.evaluate(() => /** @type {any} */ (window).__faceid.unlocked);
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Unlock" });
	expect(await unlocked()).toBe(0);
	await page.locator(".faceid-button").click();
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1 });
	expect(await unlocked()).toBe(1);

	// a request refused for want of a check while the page looked unlocked: passing it tells the page again
	await hostRefuses(page);
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Unlock" });
	await page.locator(".faceid-button").click();
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 2 });
	expect(await unlocked()).toBe(2);
});

test("laptop: a locked page swallows keys and gives the keyboard back after unlock", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: 0 });
	await expect.poll(() => state(page)).toMatchObject({ started: true, open: false });
	await page.evaluate(() => {
		const composer = document.createElement("textarea");
		composer.id = "composer";
		document.body.prepend(composer);
		Object.assign(window, { __keys: 0 });
		document.addEventListener("keydown", () => void (/** @type {any} */ (window).__keys += 1));
		composer.focus();
	});
	const composer = page.locator("#composer");
	const keys = () => page.evaluate(() => /** @type {any} */ (window).__keys);
	await page.keyboard.type("a");
	expect(await keys()).toBe(1);

	await advance(page, 16 * MINUTE);
	await fire(page, "blur");
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Unlock", buttonHasKeyboard: true });
	await page.keyboard.press("Escape");
	await page.keyboard.type("b");
	await composer.evaluate((el) => /** @type {HTMLTextAreaElement} */ (el).focus());
	await page.keyboard.type("c");
	expect(await composer.inputValue()).toBe("a");
	expect(await keys()).toBe(1);

	await page.locator(".faceid-button").focus();
	await page.keyboard.press("Enter");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1 });
	await expect(composer).toBeFocused();
	await page.keyboard.type("d");
	expect(await composer.inputValue()).toBe("ad");
	expect(await keys()).toBe(2);
});

test("coming back after the window doesn't lock when another tab passed a check meanwhile", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: 0 });
	await expect.poll(() => state(page)).toMatchObject({ started: true, prompts: 0 });
	await advance(page, 20 * MINUTE);
	await page.evaluate(() => {
		const t = /** @type {any} */ (window).__faceid;
		t.hostVerifiedAt = t.clock - 30_000;
	});
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 0 });
});

test("phone: prompts by itself; going away covers the page and back inside the window lifts it without asking", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null, touch: true });
	await expect.poll(() => state(page)).toMatchObject({ started: true, open: false, prompts: 1 });

	await fire(page, "blur");
	expect(await state(page)).toMatchObject({ open: true, subtitle: "Session hidden." });
	await fire(page, "focus");
	expect(await state(page)).toMatchObject({ open: false, prompts: 1 });

	await advance(page, 15 * MINUTE);
	await fire(page, "blur");
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 2 });
});

test("a request the host refused for want of a check: the laptop offers unlock even inside the window", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: 10 });
	await expect.poll(() => state(page)).toMatchObject({ started: true, prompts: 0 });
	await hostRefuses(page);
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Unlock", subtitle: "Fresh Face ID verification required.", prompts: 0 });
	await fire(page, "focus");
	expect((await state(page)).prompts).toBe(0);
	await page.locator(".faceid-button").click();
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1 });
});

test("a request the host refused for want of a check: a phone asks right away", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: 10, touch: true });
	await expect.poll(() => state(page)).toMatchObject({ started: true, prompts: 0 });
	await hostRefuses(page);
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1 });
});

test("a cancelled prompt waits for try again instead of asking on every return", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null, failFirst: true });
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Unlock", prompts: 0 });
	await page.locator(".faceid-button").click();
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Try again", prompts: 1, started: false });

	await fire(page, "focus");
	await fire(page, "focus");
	expect(await state(page)).toMatchObject({ open: true, prompts: 1 });

	await page.locator(".faceid-button").click();
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 2, started: true });
});

test("a phone without focus stays locked and asks once it gets focus", async ({ page }) => {
	await installGuard(page, { verifiedSecondsAgo: null, touch: true, focused: false });
	await expect.poll(() => state(page)).toMatchObject({ open: true, button: "Unlock", prompts: 0, started: false });

	await page.evaluate(() => void (/** @type {any} */ (window).__faceid.focused = true));
	await fire(page, "focus");
	await expect.poll(() => state(page)).toMatchObject({ open: false, prompts: 1, started: true });
});
