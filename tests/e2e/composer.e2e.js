import { expect, test } from "@playwright/test";

test("a prompt the server rejects goes back into the composer", async ({ page }, testInfo) => {
	await page.goto("/?replay=basic");
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");

	const input = page.locator("#inp");
	await input.fill("please keep me");
	if (testInfo.project.name.includes("iphone")) {
		await page.locator("#kb-enter").click();
	} else {
		await input.press("Enter");
	}

	await expect(page.locator(".notice-text.error").filter({ hasText: "Not sent: Session not running" })).toHaveCount(1);
	await expect(input).toHaveValue("please keep me");
});
