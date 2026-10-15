import { expect, test } from "@playwright/test";

const SESSION_ID = "sess_ext_ui";

function fixture() {
	return [
		{
			type: "init",
			yourClientId: "fixture",
			controllerClientId: "fixture",
			role: "controller",
			cursor: null,
			transcript: { mode: "replace", messages: [], hasOlder: false },
			live: { streamingMessage: null, tools: [], retry: null, compaction: null },
			ui: { statuses: { op: "1P: ready" }, widgets: { todo: { lines: ["- [ ] ship it"], placement: "aboveEditor" } }, title: "pi - repo", dialogs: [] },
			state: {
				sessionId: SESSION_ID,
				cwd: "/REPO_ROOT",
				sessionFile: null,
				isStreaming: false,
				isCompacting: false,
				retryAttempt: 0,
				model: { provider: "anthropic", id: "claude" },
				thinkingLevel: "high",
				steeringMode: "all",
				followUpMode: "all",
				queuedMessages: { steering: [], followUp: [] },
				stats: null,
				contextUsage: null,
			},
		},
		{ type: "extension_ui_request", request: { id: "d-confirm", method: "confirm", title: "Allow rm -rf build?", message: "The tool wants to delete build/", timeout: 60_000, expiresAt: Date.now() + 60_000 } },
		{ type: "replay_pause" },
		{ type: "extension_ui_request", request: { id: "d-select", method: "select", title: "Pick a model", options: ["fast", "smart"] } },
		{ type: "replay_pause" },
		{ type: "extension_ui_closed", id: "d-select" },
		{ type: "extension_ui_chrome", chrome: { statuses: { op: "1P: 2 secret(s) inherited" }, widgets: {}, title: null } },
		{ type: "extension_ui_notify", message: "build cleaned", notifyType: "warning" },
		{ type: "extension_ui_editor_text", text: "follow-up draft" },
	];
}

async function waitForPause(page) {
	await expect.poll(() => page.evaluate(() => document.documentElement.dataset.replayPaused ?? "")).toBe("1");
}

async function resume(page) {
	await page.evaluate(() => window.dispatchEvent(new Event("pi-replay-continue")));
}

test("extension dialogs, statuses and widgets reach the page", async ({ page }) => {
	const answers = [];
	await page.route("**/fixtures/extension_ui.json", (route) => route.fulfill({ json: fixture() }));
	await page.route(`**/api/sessions/${SESSION_ID}/ui-response`, (route) => {
		answers.push(route.request().postDataJSON());
		route.fulfill({ json: { ok: true } });
	});
	await page.goto("/?replay=extension_ui");
	await waitForPause(page);

	await expect(page.locator("#footer-ext-status")).toHaveText("1P: ready");
	await expect(page.locator("#ext-widgets-above")).toHaveText("- [ ] ship it");
	await expect(page).toHaveTitle("pi - repo");

	const dialog = page.locator(".ext-dialog-card");
	await expect(dialog.locator(".ext-dialog-title")).toHaveText("Allow rm -rf build?");
	await expect(dialog.locator(".ext-dialog-message")).toHaveText("The tool wants to delete build/");
	await expect(dialog.locator(".ext-dialog-meta")).toContainText("closes in");
	await dialog.getByRole("button", { name: "Yes" }).click();
	await expect(dialog).toHaveCount(0);
	expect(answers).toEqual([{ id: "d-confirm", confirmed: true }]);

	await resume(page);
	await waitForPause(page);
	await expect(dialog.locator(".ext-dialog-option")).toHaveText(["fast", "smart"]);

	await resume(page);
	await expect.poll(() => page.evaluate(() => document.documentElement.dataset.replayDone ?? "")).toBe("1");
	await expect(dialog).toHaveCount(0);
	expect(answers).toHaveLength(1);
	await expect(page.locator("#footer-ext-status")).toHaveText("1P: 2 secret(s) inherited");
	await expect(page.locator("#ext-widgets-above")).toBeHidden();
	await expect(page).toHaveTitle("pi");
	await expect(page.locator(".notice-text").filter({ hasText: "build cleaned" })).toHaveCount(1);
	await expect(page.locator("#inp")).toHaveValue("follow-up draft");
});

test("escape cancels an open dialog instead of aborting the run", async ({ page }) => {
	const answers = [];
	const events = fixture().slice(0, 3);
	await page.route("**/fixtures/extension_ui_cancel.json", (route) => route.fulfill({ json: events }));
	await page.route(`**/api/sessions/${SESSION_ID}/**`, (route) => {
		if (route.request().method() === "POST") answers.push([new URL(route.request().url()).pathname.split("/").at(-1), route.request().postDataJSON()]);
		route.fulfill({ json: { ok: true } });
	});
	await page.goto("/?replay=extension_ui_cancel");
	await waitForPause(page);

	await expect(page.locator(".ext-dialog-card")).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(page.locator(".ext-dialog-card")).toHaveCount(0);
	expect(answers).toEqual([["ui-response", { id: "d-confirm", cancelled: true }]]);
});
