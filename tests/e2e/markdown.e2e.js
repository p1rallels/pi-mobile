import { expect, test } from "@playwright/test";

const header = Array.from({ length: 10 }, (_, i) => `wide column number ${i}`);
const TEXT = [
	"Here's the table:",
	"",
	"| Option | Pros | Cons | Cost |",
	"|:--|---|---|--:|",
	"| `fast` | renders real tables with a sideways scroller, like code blocks | needs a min width on wrapped cells so phones never squeeze them | **$0** |",
	"| slow | short | one<br>two | $12 |",
	"",
	`| ${header.join(" | ")} |`,
	`|${header.map(() => "---").join("|")}|`,
	`| ${header.map((_, i) => i).join(" | ")} |`,
	"",
	"after",
].join("\n");

function fixture() {
	return [
		{
			type: "init",
			yourClientId: "fixture",
			controllerClientId: "fixture",
			role: "controller",
			state: {
				sessionId: "sess_markdown_tables",
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
					{ role: "user", content: [{ type: "text", text: "compare them in a table" }], timestamp: 1, entryId: "e1" },
					{ role: "assistant", content: [{ type: "text", text: TEXT }], stopReason: "stop", timestamp: 2, entryId: "e2" },
				],
			},
		},
	];
}

test("markdown tables render as tables that scroll sideways instead of squeezing", async ({ page }) => {
	await page.route("**/fixtures/md_tables.json", (route) => route.fulfill({ json: fixture() }));
	await page.goto("/?replay=md_tables");
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");

	const md = page.locator(".assistant-block .md");
	await expect(md.locator(".md-table table")).toHaveCount(2);
	await expect(md).toContainText("Here's the table:");
	await expect(md).toContainText("after");
	await expect(md).not.toContainText("|---");

	const first = md.locator(".md-table").first();
	await expect(first.locator("th")).toHaveText(["Option", "Pros", "Cons", "Cost"]);
	await expect(first.locator("td .ci")).toHaveText("fast");
	await expect(first.locator("td .bold")).toHaveText("$0");
	await expect(first.locator("td").nth(3)).toHaveCSS("text-align", "right");
	expect(await first.locator("td").nth(6).evaluate((cell) => cell.textContent)).toBe("one\ntwo");

	// a long cell wraps but keeps 20ch, so a phone scrolls the table rather than squeezing it to a word per line
	const wrapped = await first.locator("td.wrap").evaluateAll((cells) => {
		const probe = document.createElement("span");
		probe.textContent = "0".repeat(20);
		cells[0].closest(".md").appendChild(probe);
		const twentyCh = probe.getBoundingClientRect().width;
		probe.remove();
		return cells.map((cell) => {
			const style = getComputedStyle(cell);
			return cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - twentyCh;
		});
	});
	expect(wrapped).toHaveLength(2);
	for (const slack of wrapped) expect(slack).toBeGreaterThanOrEqual(-1);

	const wide = md.locator(".md-table").nth(1);
	const scroll = await wide.evaluate((scroller) => {
		const before = { client: scroller.clientWidth, scroll: scroller.scrollWidth };
		scroller.scrollLeft = scroller.scrollWidth;
		const last = scroller.querySelector("th:last-child").getBoundingClientRect();
		const box = scroller.getBoundingClientRect();
		return { ...before, left: scroller.scrollLeft, lastInView: last.right <= box.right + 1 && last.right > box.left };
	});
	expect(scroll.scroll).toBeGreaterThan(scroll.client);
	expect(scroll.left).toBeGreaterThan(0);
	expect(scroll.lastInView).toBe(true);

	const transcript = await md.evaluate((el) => {
		const msgs = /** @type {HTMLElement} */ (el.closest(".msgs"));
		return { client: msgs.clientWidth, scroll: msgs.scrollWidth };
	});
	expect(transcript.scroll).toBeLessThanOrEqual(transcript.client);
});
