import { expect, test } from "@playwright/test";

function page(from, to) {
	const messages = [];
	for (let i = from; i < to; i += 1) {
		messages.push({ role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp: i * 2 + 1, entryId: `u${i}` });
		messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}\n`.repeat(4) }], stopReason: "stop", timestamp: i * 2 + 2, entryId: `a${i}` });
	}
	return messages;
}

const init = {
	type: "init",
	yourClientId: "fixture",
	controllerClientId: "fixture",
	role: "controller",
	state: {
		sessionId: "sess_paged",
		cwd: "/REPO_ROOT",
		sessionFile: null,
		isStreaming: false,
		isCompacting: false,
		retryAttempt: 0,
		model: { provider: "anthropic", id: "claude" },
		thinkingLevel: "high",
		steeringMode: "all",
		followUpMode: "all",
		stats: null,
		contextUsage: null,
		messages: page(20, 40),
		hasOlderMessages: true,
	},
};

test("loads earlier history when scrolled to the top without moving the reader", async ({ page: browser }) => {
	const requests = [];
	await browser.route("**/fixtures/paged_history.json", (route) => route.fulfill({ json: [init] }));
	await browser.route("**/api/sessions/sess_paged/transcript*", (route) => {
		const before = new URL(route.request().url()).searchParams.get("before");
		requests.push(before);
		route.fulfill({ json: { messages: page(0, 20), hasOlder: false } });
	});
	await browser.goto("/?replay=paged_history");
	await browser.waitForFunction(() => document.documentElement.dataset.replayDone === "1");

	const msgs = browser.locator("#msgs");
	await expect(browser.locator(".load-older")).toHaveText("↑ earlier messages");
	expect(requests).toEqual([]);

	const anchor = browser.locator(".user-msg", { hasText: "question 20" });
	await msgs.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(browser.locator(".user-msg").first()).toHaveText("question 0");
	expect(requests).toEqual(["u20"]);
	await expect(browser.locator(".load-older")).toHaveCount(0);

	const anchorTop = await anchor.evaluate((el) => el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top);
	expect(Math.abs(anchorTop)).toBeLessThan(80);
	await expect(browser.locator(".user-msg")).toHaveCount(40);
});
