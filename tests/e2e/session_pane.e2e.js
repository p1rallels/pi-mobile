// Session panes are instantiable: several on one page, each with its own transcript, composer,
// footer and controller, built from pane_dom.js and torn down with destroy().
import { expect, test } from "@playwright/test";

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "multi-pane pages are the laptop canvas");
});

test("two panes replay different sessions side by side and tear down cleanly", async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 900 });
	await page.goto("/?replay=basic");
	await page.waitForFunction(() => document.documentElement.dataset.replayDone === "1");
	const phoneUsers = await page.locator("#msgs .user-msg").count();
	const phoneTools = await page.locator("#msgs .tool-box").count();

	await page.evaluate(async () => {
		const { createApi } = await import("/app/core/api.js");
		const { buildPaneDom } = await import("/app/session/pane_dom.js");
		const { createSessionPane } = await import("/app/session/pane.js");
		const api = createApi({ baseUrl: location.origin });
		const host = document.createElement("div");
		host.id = "pane-host";
		host.style.cssText = "position:fixed;inset:0;z-index:200;display:flex;gap:8px;background:#18181e";
		document.body.append(host);
		const panes = ["basic", "tools"].map((name) => {
			const { el, refs } = buildPaneDom(document);
			el.dataset.replay = name;
			host.append(el);
			const pane = createSessionPane({
				refs,
				api,
				getClientId: () => "e2e-client",
				menuDom: { menuOverlay: null, menuScrim: null, menuPanel: null },
				getHost: () => ({ hostLabel: "e2e", baseUrl: location.origin }),
			});
			pane.render();
			return pane;
		});
		await Promise.all([panes[0].runReplay("basic"), panes[1].runReplay("tools")]);
		Object.assign(window, { __panes: panes });
	});

	const basic = page.locator('.pane[data-replay="basic"]');
	const tools = page.locator('.pane[data-replay="tools"]');
	await expect(basic.locator(".user-msg")).toHaveCount(phoneUsers);
	await expect(basic.locator(".tool-box")).toHaveCount(phoneTools);
	await expect(tools.locator(".tool-box").first()).toBeVisible();
	expect(await tools.locator(".tool-box").count()).toBeGreaterThan(phoneTools);
	await expect(basic.locator(".footer-line-1")).not.toHaveText("—");
	await expect(basic.locator("textarea")).toBeEnabled();

	await basic.locator("textarea").fill("draft for basic");
	await expect(tools.locator("textarea")).toHaveValue("");

	await page.evaluate(() => {
		for (const pane of window.__panes) pane.destroy();
		document.getElementById("pane-host")?.remove();
	});
	await expect(page.locator(".pane")).toHaveCount(0);
	await expect(page.locator("#msgs .user-msg")).toHaveCount(phoneUsers);
});
