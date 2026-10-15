import { expect, test } from "@playwright/test";

const prompt = {
	cwd: "/REPO_ROOT/untrusted",
	options: [
		{ choice: "trust", label: "Trust", trusted: true },
		{ choice: "trust_parent", label: "Trust parent folder (/REPO_ROOT)", trusted: true },
		{ choice: "trust_session", label: "Trust (this session only)", trusted: true },
		{ choice: "distrust", label: "Do not trust", trusted: false },
		{ choice: "distrust_session", label: "Do not trust (this session only)", trusted: false },
	],
};

test("asks for project trust when the server needs a decision and retries with it", async ({ page }, testInfo) => {
	const saved = { id: "sess_trust", path: "/sessions/trust.jsonl", cwd: prompt.cwd, firstMessage: "hello", created: "2026-10-15T00:00:00.000Z", modified: "2026-10-15T00:00:00.000Z", messageCount: 2, isRunning: false };
	const posts = [];
	await page.route("**/api/active-sessions", (route) => route.fulfill({ json: { sessions: [saved] } }));
	await page.route("**/api/sessions", (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		const body = route.request().postDataJSON();
		posts.push(body);
		if (!body.projectTrust) return route.fulfill({ status: 409, json: { error: "Project trust required", projectTrust: prompt } });
		return route.fulfill({ json: { sessionId: "sess_trust" } });
	});
	await page.goto("/");

	if (testInfo.project.name.includes("iphone")) await page.locator("#kb-menu").click();
	await page.locator('.si[data-session-id="sess_trust"]').click();

	const dialog = page.locator(".ext-dialog-card");
	await expect(dialog.locator(".ext-dialog-title")).toHaveText(`Trust project folder?\n${prompt.cwd}`);
	await expect(dialog.locator(".ext-dialog-option")).toHaveText(prompt.options.map((option) => option.label));
	await dialog.getByRole("button", { name: "Trust (this session only)", exact: true }).click();

	await expect(dialog).toHaveCount(0);
	await expect.poll(() => posts.length).toBe(2);
	expect(posts.map((body) => body.projectTrust ?? null)).toEqual([null, "trust_session"]);
	expect(posts[1].resumeSessionPath).toBe(saved.path);
});
