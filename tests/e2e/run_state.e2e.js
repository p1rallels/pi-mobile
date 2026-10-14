import { expect, test } from "@playwright/test";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const agentEvent = (event) => ({ type: "agent_event", event });

function retryFixture() {
	const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded", usage, timestamp: 2 };
	const recovered = { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop", usage, timestamp: 3 };
	return [
		{
			type: "init",
			yourClientId: "fixture",
			controllerClientId: "fixture",
			role: "controller",
			state: {
				sessionId: "sess_retry",
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
				messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
			},
		},
		agentEvent({ type: "agent_start" }),
		agentEvent({ type: "turn_start" }),
		agentEvent({ type: "message_start", message: { ...failed, stopReason: "pending" } }),
		agentEvent({ type: "message_end", message: failed }),
		agentEvent({ type: "agent_end", messages: [], willRetry: true }),
		agentEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" }),
		{ type: "replay_pause" },
		agentEvent({ type: "agent_start" }),
		agentEvent({ type: "turn_start" }),
		agentEvent({ type: "message_start", message: { ...recovered, content: [], stopReason: "pending" } }),
		agentEvent({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" } }),
		agentEvent({ type: "message_end", message: recovered }),
		agentEvent({ type: "auto_retry_end", success: true, attempt: 1 }),
		agentEvent({ type: "agent_end", messages: [], willRetry: false }),
		{ type: "replay_pause" },
		agentEvent({ type: "agent_settled", aborted: false }),
	];
}

async function waitForPause(page) {
	await page.waitForFunction(() => document.documentElement.dataset.replayPaused === "1");
}

async function resume(page) {
	await page.evaluate(() => window.dispatchEvent(new Event("pi-replay-continue")));
}

async function expectBusy(page, isPhone, busy) {
	if (isPhone) {
		if (busy) await expect(page.locator("#working")).toBeVisible();
		else await expect(page.locator("#working")).toBeHidden();
		return;
	}
	if (busy) await expect(page.locator("#inp")).toHaveAttribute("placeholder", /^Streaming/);
	else await expect(page.locator("#inp")).toHaveAttribute("placeholder", /^Type a prompt/);
}

test("stays busy through retries until agent_settled", async ({ page }, testInfo) => {
	const isPhone = testInfo.project.name.includes("iphone");
	await page.route("**/fixtures/retry_run.json", (route) => route.fulfill({ json: retryFixture() }));
	await page.goto("/?replay=retry_run");

	await waitForPause(page);
	await expect(page.locator(".notice-text").filter({ hasText: "Retrying in 2s (attempt 1/3): 529 overloaded" })).toHaveCount(1);
	await expect(page.locator("#working .work-text")).toHaveText("Retrying (1/3)...");
	await expectBusy(page, isPhone, true);

	await resume(page);
	await waitForPause(page);
	await expect(page.locator(".assistant-block .md").last()).toHaveText("recovered");
	await expect(page.locator("#working .work-text")).toHaveText("Working...");
	await expectBusy(page, isPhone, true);

	await resume(page);
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");
	await expectBusy(page, isPhone, false);
});
