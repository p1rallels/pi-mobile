import { expect, test } from "@playwright/test";

async function waitForReplay(page) {
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");
}

test.describe("replay fixtures", () => {
	test("basic", async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 800 });
		await page.goto("/?replay=basic");
		await waitForReplay(page);
		await expect(page).toHaveScreenshot("basic.png");
	});

	test("tools", async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto("/?replay=tools");
		await waitForReplay(page);
		await expect(page).toHaveScreenshot("tools.png");
	});

	test("tool before message_start ordering", async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto("/?replay=tool_before_message");
		await waitForReplay(page);
		await expect(page).toHaveScreenshot("tool-before-message.png");
	});

	test("mobile working", async ({ page }) => {
		// Let the device/project decide sizing; just load and snapshot.
		await page.goto("/?replay=mobile_working");
		await waitForReplay(page);
		await expect(page).toHaveScreenshot("mobile-working.png");
	});
});

