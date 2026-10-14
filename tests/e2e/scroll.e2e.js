import { expect, test } from "@playwright/test";

function historyMessages(count) {
	return Array.from({ length: count }, (_, i) =>
		i % 2 === 0
			? { role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp: i + 1 }
			: { role: "assistant", content: [{ type: "text", text: `answer ${i}\n`.repeat(6) }], stopReason: "stop", timestamp: i + 1 },
	);
}

function initEvent(messages) {
	return {
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
	};
}

function streamingFixture() {
	const delta = (text) => ({
		type: "agent_event",
		event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } },
	});
	const lines = Array.from({ length: 40 }, (_, i) => `streamed line ${i}\n`);
	return [
		initEvent(historyMessages(120)),
		{ type: "agent_event", event: { type: "agent_start" } },
		{ type: "agent_event", event: { type: "turn_start" } },
		{ type: "agent_event", event: { type: "message_start", message: { role: "assistant", content: [], timestamp: 500 } } },
		delta("first chunk\n"),
		{ type: "replay_pause" },
		...lines.map(delta),
	];
}

async function serveFixture(page, name, events) {
	await page.route(`**/fixtures/${name}.json`, (route) => route.fulfill({ json: events }));
	await page.goto(`/?replay=${name}`);
}

async function scrollGap(msgs) {
	return msgs.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test("long history stays reachable by scrolling up", async ({ page }) => {
	await serveFixture(page, "long_history", [initEvent(historyMessages(120))]);
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");

	const msgs = page.locator("#msgs");
	const overflow = await msgs.evaluate((el) => el.scrollHeight - el.clientHeight);
	expect(overflow).toBeGreaterThan(1000);
	expect(await scrollGap(msgs)).toBeLessThanOrEqual(2);

	await msgs.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(page.locator(".user-msg").first()).toHaveText("question 0");
	await expect(page.locator(".user-msg").first()).toBeInViewport();
});

test("streaming does not yank a reader back to the bottom", async ({ page }) => {
	await serveFixture(page, "streaming_reader", streamingFixture());
	await page.waitForFunction(() => document.documentElement.dataset.replayPaused === "1");

	const msgs = page.locator("#msgs");
	const pill = page.locator("#jump-latest");
	expect(await scrollGap(msgs)).toBeLessThanOrEqual(2);
	await expect(pill).toBeHidden();

	await msgs.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(pill).toBeVisible();

	await page.evaluate(() => window.dispatchEvent(new Event("pi-replay-continue")));
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

	expect(await msgs.evaluate((el) => el.scrollTop)).toBe(0);
	await expect(page.locator(".assistant-block .md").last()).toContainText("streamed line 39");
	await expect(pill).toBeVisible();

	await pill.click();
	await expect(pill).toBeHidden();
	expect(await scrollGap(msgs)).toBeLessThanOrEqual(2);
});
