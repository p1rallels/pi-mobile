import { expect, test } from "@playwright/test";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const agentEvent = (event) => ({ type: "agent_event", event });

function fixture() {
	const skillPrompt = '<skill name="deploy" location="/skills/deploy/SKILL.md">\nReferences are relative to /skills/deploy.\n\nStep 1: build.\n</skill>\n\nship it';
	return [
		{
			type: "init",
			yourClientId: "fixture",
			controllerClientId: "fixture",
			role: "controller",
			state: {
				sessionId: "sess_tools_1x",
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
				hasOlderMessages: false,
				messages: [
					{ role: "user", content: [{ type: "text", text: skillPrompt }], timestamp: 1, entryId: "e1" },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "mcp_1", name: "mcp__docs__search", arguments: { query: "deploy" } }],
						stopReason: "toolUse",
						timestamp: 2,
						entryId: "e2",
					},
					{
						role: "toolResult",
						toolCallId: "mcp_1",
						toolName: "mcp__docs__search",
						content: [{ type: "text", text: "found a diagram" }, { type: "image", data: PIXEL, mimeType: "image/png" }],
						isError: false,
						timestamp: 3,
						entryId: "e3",
						nestedCalls: { complete: true, calls: [{ id: "mcp_1/1", name: "read", arguments: { path: "docs/deploy.md" }, status: "ok", durationMs: 40 }] },
					},
				],
			},
		},
		agentEvent({ type: "agent_start" }),
		agentEvent({ type: "tool_execution_start", toolCallId: "cm1", toolName: "codemode", args: { code: "const out = await tools.bash({ command: 'ls' });\nreturn out;" } }),
		agentEvent({ type: "tool_execution_start", toolCallId: "cm1/1", parentToolCallId: "cm1", toolName: "bash", args: { command: "ls" } }),
		agentEvent({ type: "tool_execution_end", toolCallId: "cm1/1", parentToolCallId: "cm1", toolName: "bash", result: { content: [] }, isError: false, durationMs: 120 }),
		agentEvent({
			type: "tool_execution_end",
			toolCallId: "cm1",
			toolName: "codemode",
			result: { content: [{ type: "text", text: "Script completed" }] },
			isError: false,
			durationMs: 1500,
		}),
	];
}

test("renders 1.x tool calls, nested calls, images and skill prompts", async ({ page }) => {
	await page.route("**/fixtures/tools_1x.json", (route) => route.fulfill({ json: fixture() }));
	await page.goto("/?replay=tools_1x");
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");

	const user = page.locator(".user-msg").first();
	await expect(user.locator(".skill-chip")).toHaveText("[skill: deploy]");
	await expect(user).toContainText("ship it");
	await expect(user.locator(".skill-body")).toBeHidden();
	await user.locator(".skill-chip").click();
	await expect(user.locator(".skill-body")).toContainText("Step 1: build.");

	const mcpBox = page.locator(".tool-box", { hasText: "docs › search" });
	await expect(mcpBox.locator(".tool-call")).toContainText('docs › search {"query":"deploy"}');
	await expect(mcpBox.locator(".tool-img")).toHaveCount(1);
	await expect(mcpBox.locator(".tool-nested-call")).toHaveText("↳ ✓ read docs/deploy.md · 40ms");

	const codemodeBox = page.locator(".tool-box", { hasText: "codemode:" });
	await expect(codemodeBox.locator(".tool-call")).toHaveText("codemode: const out = await tools.bash({ command: 'ls' }); · 1.5s");
	await expect(codemodeBox.locator(".tool-nested-call")).toHaveText("↳ ✓ $ ls · 120ms");
	await expect(page.locator(".tool-box")).toHaveCount(2);
});
