import { expect, test } from "@playwright/test";

function longHistoryFixture(count) {
	const messages = Array.from({ length: count }, (_, i) =>
		i % 2 === 0
			? { role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp: i + 1 }
			: { role: "assistant", content: [{ type: "text", text: `answer ${i}\n`.repeat(6) }], stopReason: "stop", timestamp: i + 1 },
	);
	return [
		{
			type: "init",
			yourClientId: "fixture",
			controllerClientId: "fixture",
			role: "controller",
			state: {
				sessionId: "sess_long_history",
				cwd: "/REPO_ROOT",
				sessionFile: null,
				sessionName: "long",
				isStreaming: false,
				isCompacting: false,
				model: { provider: "openrouter", id: "z-ai/glm-4.7" },
				thinkingLevel: "high",
				steeringMode: "all",
				followUpMode: "all",
				stats: null,
				contextUsage: null,
				messages,
			},
		},
	];
}

test("long history stays reachable by scrolling up", async ({ page }) => {
	await page.route("**/fixtures/long_history.json", (route) => route.fulfill({ json: longHistoryFixture(120) }));
	await page.goto("/?replay=long_history");
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");

	const msgs = page.locator("#msgs");
	const overflow = await msgs.evaluate((el) => el.scrollHeight - el.clientHeight);
	expect(overflow).toBeGreaterThan(1000);

	await msgs.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(page.locator(".user-msg").first()).toHaveText("question 0");
	await expect(page.locator(".user-msg").first()).toBeInViewport();
});
