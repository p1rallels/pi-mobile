import { expect, test } from "@playwright/test";

const SESSION_ID = "sess_live";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (entryId, text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp, entryId });
const assistant = (entryId, text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage, timestamp, entryId });
const agentEvent = (event, entryId) => (entryId ? { type: "agent_event", event, entryId } : { type: "agent_event", event });
const delta = (text) => agentEvent({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });

function init(transcript, { cursor, live = null, isStreaming = false } = {}) {
	return {
		type: "init",
		yourClientId: "fixture",
		controllerClientId: "fixture",
		role: "controller",
		cursor,
		transcript,
		live: { streamingMessage: live, tools: [], retry: null, compaction: null },
		state: {
			sessionId: SESSION_ID,
			cwd: "/REPO_ROOT",
			sessionFile: "/sessions/live.jsonl",
			isStreaming,
			isCompacting: false,
			retryAttempt: 0,
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "high",
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: true,
			queuedMessages: { steering: [], followUp: [] },
			stats: null,
			contextUsage: null,
		},
	};
}

/** Stands in for EventSource so the test decides when frames arrive and when the stream dies. */
function installFakeEventSource() {
	class FakeEventSource extends EventTarget {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSED = 2;

		constructor(url) {
			super();
			this.url = url;
			this.readyState = FakeEventSource.CONNECTING;
			this.lastEventId = "";
			this.onopen = null;
			this.onmessage = null;
			this.onerror = null;
			window.__sse.push(this);
		}

		close() {
			this.readyState = FakeEventSource.CLOSED;
		}

		open() {
			this.readyState = FakeEventSource.OPEN;
			this.onopen?.(new Event("open"));
		}

		frame(data, id) {
			if (id !== undefined) this.lastEventId = id;
			this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data), lastEventId: this.lastEventId }));
		}

		fail() {
			this.readyState = FakeEventSource.CLOSED;
			this.onerror?.(new Event("error"));
		}
	}
	window.__sse = [];
	window.EventSource = FakeEventSource;
}

async function waitForStream(page, index) {
	await expect.poll(() => page.evaluate(() => window.__sse.length)).toBeGreaterThan(index);
}

async function sse(page, index, action, ...args) {
	await waitForStream(page, index);
	await page.evaluate(([i, name, rest]) => window.__sse[i][name](...rest), [index, action, args]);
}

async function streamUrl(page, index) {
	await waitForStream(page, index);
	return new URL(await page.evaluate((i) => window.__sse[i].url, index));
}

async function dropStream(page, index) {
	await sse(page, index, "fail");
	await expect(page.locator("#role-pill")).toHaveText("reconnecting");
}

test("a dropped stream resumes from its cursor without losing or repeating text", async ({ page }, testInfo) => {
	await page.addInitScript(installFakeEventSource);
	await page.route("**/api/client", (route) => route.fulfill({ json: { clientId: "fixture" } }));
	const running = { id: SESSION_ID, path: "/sessions/live.jsonl", cwd: "/REPO_ROOT", firstMessage: "first question", created: "2026-10-15T00:00:00.000Z", modified: "2026-10-15T00:00:00.000Z", messageCount: 2, isRunning: true };
	await page.route("**/api/active-sessions", (route) => route.fulfill({ json: { sessions: [running] } }));
	await page.route(`**/api/sessions/${SESSION_ID}/state*`, (route) => route.fulfill({ json: {} }));
	await page.route(`**/api/sessions/${SESSION_ID}/tripwire-alerts`, (route) => route.fulfill({ json: { alerts: [], unreadAlerts: [], unreadCount: 0 } }));
	await page.goto("/");

	if (testInfo.project.name.includes("iphone")) await page.locator("#kb-menu").click();
	await page.locator(`.si[data-session-id="${SESSION_ID}"]`).click();

	expect((await streamUrl(page, 0)).searchParams.get("since")).toBeNull();
	await sse(page, 0, "open");
	await sse(page, 0, "frame", init({ mode: "replace", messages: [user("u1", "first question", 1), assistant("a1", "first answer", 2)], hasOlder: false }, { cursor: "a1" }), "a1");
	await sse(page, 0, "frame", agentEvent({ type: "agent_start" }));
	await sse(page, 0, "frame", agentEvent({ type: "turn_start" }));
	await sse(page, 0, "frame", agentEvent({ type: "message_start", message: user(undefined, "second question", 3) }));
	await sse(page, 0, "frame", agentEvent({ type: "message_end", message: user(undefined, "second question", 3) }, "u2"), "u2");
	await sse(page, 0, "frame", agentEvent({ type: "message_start", message: { ...assistant(undefined, "", 4), content: [], stopReason: "pending" } }));
	await sse(page, 0, "frame", delta("Hello wor"));
	await expect(page.locator(".assistant-block .md").last()).toHaveText("Hello wor");

	await dropStream(page, 0);
	expect((await streamUrl(page, 1)).searchParams.get("since")).toBe("u2");
	await sse(page, 1, "open");
	await sse(page, 1, "frame", init({ mode: "append", since: "u2", messages: [] }, { cursor: "u2", isStreaming: true, live: { ...assistant(undefined, "Hello world, again", 4), stopReason: "pending" } }), "u2");
	await expect(page.locator("#role-pill")).toHaveText("controller");
	await expect(page.locator(".assistant-block .md")).toHaveText(["first answer", "Hello world, again"]);
	await sse(page, 1, "frame", delta(" and more"));
	await sse(page, 1, "frame", agentEvent({ type: "message_end", message: assistant(undefined, "Hello world, again and more", 4) }, "a2"), "a2");
	await sse(page, 1, "frame", agentEvent({ type: "agent_settled", aborted: false }));

	await expect(page.locator(".user-msg")).toHaveText(["first question", "second question"]);
	await expect(page.locator(".assistant-block .md")).toHaveText(["first answer", "Hello world, again and more"]);

	await dropStream(page, 1);
	expect((await streamUrl(page, 2)).searchParams.get("since")).toBe("a2");
	await sse(page, 2, "open");
	await sse(page, 2, "frame", init({ mode: "append", since: "a2", messages: [user("u3", "asked elsewhere", 5), assistant("a3", "answered while away", 6)] }, { cursor: "a3" }), "a3");

	await expect(page.locator(".user-msg")).toHaveText(["first question", "second question", "asked elsewhere"]);
	await expect(page.locator(".assistant-block .md")).toHaveText(["first answer", "Hello world, again and more", "answered while away"]);
	await expect(page.locator("#msgs [data-provisional]")).toHaveCount(0);
});
