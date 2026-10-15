// Perf and leak harness for the canvas view (INFINITE_PLAN.md budgets), headless Chromium + CDP.
// Numbers are regression signals: each test attaches a JSON report and prints one line to stdout.
// Override the budgets with PI_WEB_PERF_P95_MS / PI_WEB_PERF_HEAP_MB on a loaded machine.
import { expect, test } from "@playwright/test";

const MOCK = process.env.MOCK_UI_URL ?? "http://127.0.0.1:4321";
const P95_BUDGET_MS = Number(process.env.PI_WEB_PERF_P95_MS || 20);
const LONG_TASK_MS = 50;
const HEAP_SLACK_MB = Number(process.env.PI_WEB_PERF_HEAP_MB || 2);
// e.g. PI_WEB_PERF_QUERY="tiles=60&streaming=30&rate=60&offscreen=stream" for a stress run
const PERF_QUERY = process.env.PI_WEB_PERF_QUERY || "tiles=30&streaming=10&rate=30";
// the same with the shipped session pane on a fake api (mock-ui/real_panes.js); window=0 turns windowing off
const REAL_PERF_QUERY = process.env.PI_WEB_PERF_REAL_QUERY || "panes=real&tiles=30&streaming=10&rate=30";

test.describe.configure({ mode: "serial" });

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the canvas is laptop chrome only");
});

/** Counts open EventSources so the real shell's offscreen disconnects can be checked the same way. */
function trackEventSources() {
	const Native = window.EventSource;
	if (!Native) return;
	let open = 0;
	class Tracked extends Native {
		/** @param {string | URL} url @param {EventSourceInit} [init] */
		constructor(url, init) {
			super(url, init);
			open += 1;
			let closed = false;
			const markClosed = () => {
				if (closed) return;
				closed = true;
				open -= 1;
			};
			const close = this.close.bind(this);
			this.close = () => {
				markClosed();
				close();
			};
			this.addEventListener("error", () => {
				if (this.readyState === Native.CLOSED) markClosed();
			});
		}
	}
	window.EventSource = Tracked;
	Object.defineProperty(window, "__openEventSources", { get: () => open });
}

/** @param {import("@playwright/test").Page} page @param {string} query */
async function openMock(page, query) {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(trackEventSources);
	await page.goto(`${MOCK}/canvas.html?reset=1&fps=0&${query}`);
	await page.waitForFunction(() => Boolean(window.__canvasMock));
}

/** @param {import("@playwright/test").Page} page */
function startSampling(page) {
	return page.evaluate(() => {
		const state = { frames: /** @type {number[]} */ ([]), longTasks: /** @type {number[]} */ ([]), on: true };
		let last = 0;
		/** @param {number} now */
		const loop = (now) => {
			if (last) state.frames.push(now - last);
			last = now;
			if (state.on) requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
		});
		observer.observe({ type: "longtask" });
		Object.assign(window, { __perf: { state, observer } });
	});
}

/** @param {import("@playwright/test").Page} page */
function stopSampling(page) {
	return page.evaluate(() => {
		const { state, observer } = window.__perf;
		state.on = false;
		observer.disconnect();
		const sorted = [...state.frames].sort((a, b) => a - b);
		const at = (/** @type {number} */ q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
		return { frames: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0, longTasks: state.longTasks };
	});
}

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A scripted gesture at ~60 events/s: wheel pan, pinch out and in, then a drag pan.
 * @param {import("@playwright/test").Page} page @param {{ x: number, y: number }} empty
 */
async function scriptedGesture(page, empty) {
	await page.mouse.move(empty.x, empty.y);
	for (let i = 0; i < 90; i += 1) {
		await page.mouse.wheel(i < 45 ? 9 : -9, i < 45 ? 5 : -5);
		await pause(16);
	}
	await page.keyboard.down("Control");
	for (let i = 0; i < 80; i += 1) {
		await page.mouse.wheel(0, i < 40 ? 4 : -4);
		await pause(16);
	}
	await page.keyboard.up("Control");
	await page.mouse.down();
	for (let i = 1; i <= 60; i += 1) {
		await page.mouse.move(empty.x - i * 6, empty.y - i * 3);
		await pause(16);
	}
	await page.mouse.up();
}

/** @param {import("@playwright/test").CDPSession} cdp */
async function metrics(cdp) {
	await cdp.send("HeapProfiler.collectGarbage");
	await cdp.send("HeapProfiler.collectGarbage");
	const { metrics: list } = await cdp.send("Performance.getMetrics");
	const byName = Object.fromEntries(list.map((m) => [m.name, m.value]));
	return { heapMB: byName.JSHeapUsedSize / 2 ** 20, nodes: byName.Nodes, listeners: byName.JSEventListeners };
}

/** @param {import("@playwright/test").Page} page @param {import("@playwright/test").TestInfo} testInfo @param {string} query @param {string} label */
async function measurePanZoom(page, testInfo, query, label) {
	await openMock(page, query);
	await page.evaluate(() => window.__canvasMock.canvas.viewport.setCamera({ x: 40, y: 40, scale: 0.35 }));
	await page.waitForTimeout(1500);
	const visible = await page.locator(".cv-tile:not(.cv-offscreen)").count();
	await startSampling(page);
	await scriptedGesture(page, { x: 1200, y: 450 });
	const report = { query, visibleAtStart: visible, ...(await stopSampling(page)) };
	const longest = Math.max(0, ...report.longTasks);
	console.log(`[${label}] frames ${report.frames} p50 ${report.p50.toFixed(1)}ms p95 ${report.p95.toFixed(1)}ms p99 ${report.p99.toFixed(1)}ms max ${report.max.toFixed(1)}ms long tasks ${report.longTasks.length} (longest ${longest.toFixed(0)}ms)`);
	await testInfo.attach(`${label.replaceAll(" ", "-")}.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
	expect(report.frames).toBeGreaterThan(60);
	expect(report.p95).toBeLessThan(P95_BUDGET_MS);
	expect(report.longTasks.filter((d) => d > LONG_TASK_MS)).toEqual([]);
}

test("30 tiles with 10 streaming: pan and zoom stay under the frame budget", async ({ page }, testInfo) => {
	await measurePanZoom(page, testInfo, PERF_QUERY, "canvas perf");
});

test("30 real session panes with 10 streaming: pan and zoom stay under the frame budget, transcripts stay windowed", async ({ page }, testInfo) => {
	await measurePanZoom(page, testInfo, REAL_PERF_QUERY, "canvas perf, real panes");
	const shown = await page.evaluate(() => {
		const mock = window.__canvasMock;
		return mock.tileIds().map((id) => mock.shownEntries(id));
	});
	const window = await page.evaluate(() => window.__canvasMock.knobs.window);
	console.log(`[canvas perf, real panes] entries shown per tile: max ${Math.max(...shown)} (window ${window?.unfocused ?? "off"})`);
	if (window) expect(Math.max(...shown)).toBeLessThanOrEqual(window.unfocused);
});

test("pan and zoom write one world transform per frame and never touch tile dom", async ({ page }) => {
	await openMock(page, "tiles=6&streaming=0");
	await page.waitForTimeout(300);
	await page.evaluate(() => {
		const world = document.querySelector(".cv-world");
		const counts = { world: 0, tiles: 0, frames: 0 };
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.target === world) counts.world += 1;
				else counts.tiles += 1;
			}
		});
		observer.observe(/** @type {Node} */ (world), { attributes: true, subtree: true, childList: true, characterData: true });
		let on = true;
		const loop = () => {
			counts.frames += 1;
			if (on) requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
		Object.assign(window, { __mutations: { counts, stop: () => ((on = false), observer.disconnect()) } });
	});
	await page.mouse.move(700, 800);
	for (let i = 0; i < 30; i += 1) {
		await page.mouse.wheel(3, 2);
		await page.mouse.wheel(-3, -2);
	}
	await page.keyboard.down("Control");
	for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, i < 10 ? -2 : 2);
	await page.keyboard.up("Control");
	await page.waitForFunction(() => !window.__canvasMock.canvas.viewport.isGesturing());
	const counts = await page.evaluate(() => {
		window.__mutations.stop();
		return window.__mutations.counts;
	});
	console.log(`[canvas writes] ${counts.world} world style writes over ${counts.frames} frames, ${counts.tiles} tile mutations`);
	expect(counts.tiles).toBe(0);
	// will-change on/off at the gesture's ends adds two writes
	expect(counts.world).toBeLessThanOrEqual(counts.frames + 4);
});

for (const [label, query] of [
	["fake panes", "tiles=0&streaming=0&rate=60"],
	["real panes", "panes=real&tiles=0&streaming=0&rate=60"],
]) {
	test(`opening and closing 100 streaming tiles (${label}) returns heap, dom, listeners and streams to baseline`, async ({ page }, testInfo) => {
		await openMock(page, query);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Performance.enable");
		await page.waitForTimeout(500);
		const baseline = await metrics(cdp);
		const sourcesBefore = await page.evaluate(() => (window.__openEventSources ?? 0) + window.__canvasMock.openFakeStreams());
		for (let round = 0; round < 10; round += 1) {
			await page.evaluate(async () => {
				const mock = window.__canvasMock;
				const ids = Array.from({ length: 10 }, () => mock.addTile());
				await new Promise((resolve) => setTimeout(resolve, 120));
				for (const id of ids) mock.removeTile(id);
			});
		}
		await page.waitForTimeout(300);
		const after = await metrics(cdp);
		const sourcesAfter = await page.evaluate(() => (window.__openEventSources ?? 0) + window.__canvasMock.openFakeStreams());
		const report = { baseline, after, sourcesBefore, sourcesAfter, panes: await page.evaluate(() => window.__canvasMock.paneCount()) };
		console.log(
			`[canvas leaks, ${label}] heap ${baseline.heapMB.toFixed(2)} -> ${after.heapMB.toFixed(2)} MB, nodes ${baseline.nodes} -> ${after.nodes}, listeners ${baseline.listeners} -> ${after.listeners}, streams ${sourcesBefore} -> ${sourcesAfter}`,
		);
		await testInfo.attach(`canvas-leaks-${label.replace(" ", "-")}.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
		expect(report.panes).toBe(0);
		expect(after.nodes).toBeLessThanOrEqual(baseline.nodes + 50);
		expect(after.listeners).toBeLessThanOrEqual(baseline.listeners + 10);
		expect(after.heapMB).toBeLessThan(baseline.heapMB + HEAP_SLACK_MB);
		expect(sourcesAfter).toBe(sourcesBefore);
	});
}
