// msg and relay traffic in the stream: messages from other sessions (normal, finished, died, sent by you), relay's
// notices and context resets, msg's and relay's tool calls, and the entries pi appends at turn boundaries
// (entry_appended) drawn live and only once. One test drives the page with a fake event stream, the other reads a
// real session file through an isolated server, on the phone and on the canvas; a sender's name opens its session.
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "../support/sandbox_env.js";

const LEAD = "01a152a0-0000-7000-8000-00000000000a";
const WORKER = "01a152d4-0000-7000-8000-00000000000b";
const FLAKY = "01a152d4-0000-7000-8000-00000000000c";
const SENT_ID = "0mgqk3x2p-aaaaaa";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const BASE_MS = Date.parse("2026-10-19T06:00:00.000Z");
const text = (value) => [{ type: "text", text: value }];
const worker = { id: WORKER, name: "worker", cwd: "/repo/.forks/2" };

/** A msg message as msg's extension writes it: content framed for the model, details = the Message. */
function msgDetails(fields) {
	return { v: 1, id: `0mgqk3x3${Math.random().toString(36).slice(2, 3)}-bbbbbb`, ts: BASE_MS, to: LEAD, delivery: "steer", ...fields };
}
const framed = (details) => `<msg id="${details.id}" from="${details.from.name ?? details.from.id.slice(0, 8)}" session="${details.from.id}">\n${details.text}\n</msg>\nMessage from another agent session (not your user).`;

const RESET_NOTE = "docs merged; next: changelog";

/** The lead session's history as session entries (pi's file format), oldest first. */
function leadEntries() {
	const message = (role, fields) => ({ type: "message", message: { role, ...fields } });
	const custom = (customType, content, details) => ({ type: "custom_message", customType, content, display: true, details });
	const sent = { id: SENT_ID, from: { id: LEAD, name: "lead" }, to: WORKER, text: "rebase on main, then run the docs build", delivery: "steer", ts: BASE_MS };
	const rows = [
		message("user", { content: text("fan out the docs work") }),
		message("assistant", {
			content: [
				{ type: "toolCall", id: "call_send", name: "msg_send", arguments: { to: "worker", message: "rebase on main, then run the docs build", wait_seconds: 120 } },
				{ type: "toolCall", id: "call_list", name: "msg_list", arguments: {} },
			],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage,
			stopReason: "toolUse",
		}),
		message("toolResult", {
			toolCallId: "call_send",
			toolName: "msg_send",
			content: text(`Sent ${SENT_ID} to worker (${WORKER}): busy; it sees the message at its next step.\nworker replied (0mgqk3x3z-cccccc):\nrebased, docs build green`),
			details: { message: sent, to: WORKER, live: true, reply: { id: "0mgqk3x3z-cccccc", from: worker, text: "rebased, docs build green" }, outcome: "message" },
			isError: false,
		}),
		message("toolResult", {
			toolCallId: "call_list",
			toolName: "msg_list",
			content: text(`you: lead · ${LEAD} · web · busy\nworker · ${WORKER} · print · busy · /repo/.forks/2`),
			details: { live: 1, offline: 0 },
			isError: false,
		}),
	];
	const peers = [
		msgDetails({ from: worker, text: "also: the changelog needs a line", replyTo: SENT_ID }),
		msgDetails({ from: worker, text: "done: docs rebuilt, merged to terminal", kind: "ended" }),
		msgDetails({ from: { id: FLAKY, name: "flaky" }, text: "flaky's process vanished without ending", kind: "died" }),
		msgDetails({ from: worker, text: "check the deploy log too", byUser: true }),
	];
	rows.push(...peers.map((details) => custom("msg", framed(details), details)));
	rows.push(
		message("assistant", {
			content: [
				{ type: "toolCall", id: "call_wait", name: "msg_wait", arguments: { from: "children", timeout_seconds: 600 } },
				{ type: "toolCall", id: "call_relay", name: "relay", arguments: { note: RESET_NOTE } },
			],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage,
			stopReason: "toolUse",
		}),
		message("toolResult", {
			toolCallId: "call_wait",
			toolName: "msg_wait",
			content: text("<msg …>all green</msg>"),
			details: { from: WORKER, message: { from: worker, text: "all green", kind: "ended" }, outcome: "message" },
			isError: false,
		}),
		message("toolResult", { toolCallId: "call_relay", toolName: "relay", content: text("Relaying at the end of this turn."), details: {}, isError: false }),
		custom("relay", "41%: finish the step, commit, then call relay with a note for whoever picks this up", { kind: "nudge", percent: 41 }),
		{ type: "compaction", summary: `relay #1 at 45%\n\nnote: ${RESET_NOTE}\n\nlookup catchup …`, tokensBefore: 90_000, details: { relay: { n: 1, percent: 45, note: RESET_NOTE } }, fromHook: true },
		custom("relay", `context reset by relay #1 at 45%\nnote: ${RESET_NOTE}\n\nrecent conversation:\n…`, { kind: "reset", n: 1, percent: 45, note: RESET_NOTE }),
		custom("pi-op", "unlocked 1 item", undefined),
		message("user", { content: text("carry on") }),
		message("assistant", { content: text("on it"), api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "stop" }),
	);
	return rows.map((row, index) => {
		const id = `e${String(index + 1).padStart(7, "0")}`;
		const at = BASE_MS + index * 1000;
		const timestamp = new Date(at).toISOString();
		const parentId = index === 0 ? null : `e${String(index).padStart(7, "0")}`;
		if (row.type === "message") return { ...row, id, parentId, timestamp, message: { ...row.message, timestamp: at } };
		if (row.type === "compaction") return { ...row, id, parentId, timestamp, firstKeptEntryId: id };
		return { ...row, id, parentId, timestamp };
	});
}

/** What the host sends for those entries (src/transcript.ts): messages with their entry ids. */
function transcriptOf(entries) {
	return entries.flatMap((entry) => {
		const timestamp = Date.parse(entry.timestamp);
		if (entry.type === "message") return [{ ...entry.message, entryId: entry.id }];
		if (entry.type === "custom_message") {
			if (!entry.display) return [];
			return [{ role: "custom", customType: entry.customType, content: entry.content, display: true, details: entry.details, timestamp, entryId: entry.id }];
		}
		if (entry.type === "compaction") {
			const relay = entry.details?.relay;
			return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp, ...(relay ? { details: { relay } } : {}), entryId: entry.id }];
		}
		return [];
	});
}

/** Everything the lead's history shows about its peers and relay, in a pane (the phone) or a tile. */
async function expectPeerTraffic(scope) {
	const cards = scope.locator(".msg-card");
	await expect(cards).toHaveCount(4);
	await expect(cards.nth(0).locator(".msg-from")).toHaveText("worker");
	await expect(cards.nth(0).locator(".msg-re")).toHaveText(`re ${SENT_ID}`);
	await expect(cards.nth(0).locator(".msg-tag")).toHaveCount(0);
	await expect(cards.nth(0).locator(".msg-body")).toHaveText("also: the changelog needs a line");
	await expect(cards.nth(1)).toHaveClass(/\bended\b/);
	await expect(cards.nth(1).locator(".msg-tag")).toHaveText("finished");
	await expect(cards.nth(1).locator(".msg-body")).toHaveText("done: docs rebuilt, merged to terminal");
	await expect(cards.nth(2)).toHaveClass(/\bdied\b/);
	await expect(cards.nth(2).locator(".msg-head")).toContainText("flaky");
	await expect(cards.nth(2).locator(".msg-tag")).toHaveText("died");
	await expect(cards.nth(3)).toHaveClass(/\bby-user\b/);
	await expect(cards.nth(3).locator(".msg-head")).toHaveText("✉ you, via worker");
	await expect(cards.nth(3).locator(".msg-body")).toHaveText("check the deploy log too");
	await expect(scope.locator(".msg-body", { hasText: "<msg" })).toHaveCount(0);

	const notes = scope.locator(".relay-note");
	await expect(notes).toHaveCount(2);
	await expect(notes.nth(0).locator(".relay-line")).toHaveText("relay · 41% · 41%: finish the step, commit, then call relay with a note for whoever picks this up");
	await expect(notes.nth(1).locator(".relay-line")).toHaveText(`relay #1 · reset at 45% · ${RESET_NOTE}`);
	await expect(notes.nth(1).locator(".relay-full")).toBeHidden();
	await notes.nth(1).click();
	await expect(notes.nth(1).locator(".relay-full")).toContainText("recent conversation:");

	const reset = scope.locator(".compact-card.relay");
	await expect(reset).toHaveCount(1);
	await expect(reset.locator(".compact-label")).toHaveText("relay #1 · context reset at 45%");
	await expect(reset.locator(".compact-summary")).toHaveText(`${RESET_NOTE} (tap to expand)`);
	await expect(scope.locator(".notice-text.custom")).toHaveText(["[pi-op] unlocked 1 item"]);

	const box = (callText) => scope.locator(".tool-box", { has: scope.page().locator(".tool-call", { hasText: callText }) });
	await expect(box("→ worker").locator(".tool-call")).toHaveText("→ worker: rebase on main, then run the docs build");
	await expect(box("→ worker").locator(".tool-out")).toHaveText("↩ worker: rebased, docs build green");
	await expect(box("msg_list").locator(".tool-out")).toContainText("worker ·");
	await expect(box("msg_wait").locator(".tool-call")).toHaveText("msg_wait ← children · up to 10m");
	await expect(box("msg_wait").locator(".tool-out")).toHaveText("worker (finished): all green");
	await expect(box("relay:").locator(".tool-call")).toHaveText(`relay: ${RESET_NOTE}`);
}

async function shoot(page, testInfo, name) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: false });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("with a fake event stream", () => {
	const agentEvent = (event, entryId) => ({ type: "agent_event", event, ...(entryId ? { entryId } : {}) });
	const appendedFrame = (entry) => agentEvent({ type: "entry_appended", entry }, entry.id);

	function init(transcript, { cursor } = {}) {
		return {
			type: "init",
			yourClientId: "fixture",
			controllerClientId: "fixture",
			role: "controller",
			cursor,
			transcript,
			live: { streamingMessage: null, tools: [], retry: null, compaction: null },
			state: {
				sessionId: LEAD,
				cwd: "/repo",
				sessionFile: "/sessions/lead.jsonl",
				isStreaming: false,
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

	async function sse(page, index, action, ...args) {
		await expect.poll(() => page.evaluate(() => window.__sse.length)).toBeGreaterThan(index);
		await page.evaluate(([i, name, rest]) => window.__sse[i][name](...rest), [index, action, args]);
	}

	const at = (seconds) => new Date(BASE_MS + seconds * 1000).toISOString();
	const LIVE = [
		{ type: "custom_message", id: "live0001", parentId: "e0000017", timestamp: at(30), customType: "msg", content: "<msg>…</msg>", display: true, details: msgDetails({ from: worker, text: "one more thing: bump the version" }) },
		{ type: "custom_message", id: "live0002", parentId: "live0001", timestamp: at(31), customType: "msg", content: "<msg>…</msg>", display: true, details: msgDetails({ from: worker, text: "version bumped, merged", kind: "ended" }) },
		{ type: "custom_message", id: "live0003", parentId: "live0002", timestamp: at(32), customType: "msg", content: "<msg>…</msg>", display: true, details: msgDetails({ from: { id: FLAKY, name: "flaky" }, text: "gone again", kind: "died" }) },
		{ type: "custom_message", id: "live0004", parentId: "live0003", timestamp: at(33), customType: "msg", content: "<msg>…</msg>", display: true, details: msgDetails({ from: worker, text: "ship it after this", byUser: true }) },
		{ type: "custom_message", id: "live0005", parentId: "live0004", timestamp: at(34), customType: "relay", content: "47%: wrap up this step and relay", display: true, details: { kind: "nudge", percent: 47 } },
		{ type: "custom_message", id: "live0006", parentId: "live0005", timestamp: at(35), customType: "relay", content: "keep going", display: true, details: { kind: "loop", goal: "ship relay" } },
		{ type: "compaction", id: "live0007", parentId: "live0006", timestamp: at(36), summary: "relay #2 at 50%", firstKeptEntryId: "live0007", tokensBefore: 99_000, fromHook: true, details: { relay: { n: 2, percent: 50, note: "cut mid-step: run git status first" } } },
		{ type: "custom_message", id: "live0008", parentId: "live0007", timestamp: at(37), customType: "relay", content: "context reset by relay #2 at 50%\n\nrecent conversation:\n…", display: true, details: { kind: "reset", n: 2, percent: 50, note: "cut mid-step: run git status first" } },
		{ type: "custom", id: "live0009", parentId: "live0008", timestamp: at(38), customType: "relay-state", data: { n: 2 } },
		{ type: "custom_message", id: "live0010", parentId: "live0009", timestamp: at(39), customType: "relay", content: "hidden", display: false, details: { kind: "nudge" } },
	];

	test("draws msg and relay traffic, appended entries live and once, and a sender opens its session", async ({ page }, testInfo) => {
		await page.addInitScript(installFakeEventSource);
		await page.route("**/api/client", (route) => route.fulfill({ json: { clientId: "fixture" } }));
		const summary = (id, cwd, firstMessage) => ({ id, path: `/sessions/${id}.jsonl`, cwd, firstMessage, created: at(0), modified: at(0), messageCount: 2, isRunning: true });
		await page.route("**/api/active-sessions", (route) => route.fulfill({ json: { sessions: [summary(LEAD, "/repo", "fan out the docs work")] } }));
		await page.route("**/api/sessions/*/state*", (route) => route.fulfill({ json: {} }));
		await page.route("**/api/sessions/*/tripwire-alerts", (route) => route.fulfill({ json: { alerts: [], unreadAlerts: [], unreadCount: 0 } }));
		const lookups = [];
		await page.route((url) => url.pathname === "/api/sessions" && url.searchParams.has("id"), (route) => {
			const id = new URL(route.request().url()).searchParams.get("id");
			lookups.push(id);
			route.fulfill({ json: { sessions: id === WORKER ? [summary(WORKER, "/repo/.forks/2", "rebase on main")] : [], hasMore: false } });
		});
		await page.goto("/");
		if (testInfo.project.name.includes("iphone")) await page.locator("#kb-menu").click();
		await page.locator(`.si[data-session-id="${LEAD}"]`).click();

		const history = transcriptOf(leadEntries());
		const last = history.at(-1).entryId;
		await sse(page, 0, "open");
		await sse(page, 0, "frame", init({ mode: "replace", messages: history, hasOlder: false }, { cursor: last }), last);
		const msgs = page.locator("#msgs");
		await expectPeerTraffic(msgs);
		await shoot(page, testInfo, "peer-traffic-history");

		// pi's turn boundaries: entries with no message events, drawn as they land; state and hidden ones draw nothing
		await sse(page, 0, "frame", agentEvent({ type: "agent_start" }));
		for (const entry of LIVE) await sse(page, 0, "frame", appendedFrame(entry), entry.id);
		const cards = msgs.locator(".msg-card");
		await expect(cards).toHaveCount(8);
		await expect(cards.nth(4).locator(".msg-body")).toHaveText("one more thing: bump the version");
		await expect(cards.nth(5).locator(".msg-tag")).toHaveText("finished");
		await expect(cards.nth(6).locator(".msg-tag")).toHaveText("died");
		await expect(cards.nth(7).locator(".msg-head")).toHaveText("✉ you, via worker");
		const notes = msgs.locator(".relay-note .relay-line");
		await expect(notes).toHaveText([
			"relay · 41% · 41%: finish the step, commit, then call relay with a note for whoever picks this up",
			`relay #1 · reset at 45% · ${RESET_NOTE}`,
			"relay · 47% · 47%: wrap up this step and relay",
			"relay · loop · keep going",
			"relay #2 · reset at 50% · cut mid-step: run git status first",
		]);
		const resets = msgs.locator(".compact-card.relay");
		await expect(resets).toHaveCount(2);
		await expect(resets.last().locator(".compact-label")).toHaveText("relay #2 · context reset at 50%");
		await expect(resets.last().locator(".compact-summary")).toHaveText("cut mid-step: run git status first (tap to expand)");
		await expect(msgs.locator("text=hidden")).toHaveCount(0);
		await expect(msgs.locator(":scope > *").last()).toHaveClass(/relay-note/);
		await shoot(page, testInfo, "peer-traffic-live");

		// a resync that brings the same entries again (an older cursor) draws only what's new
		await sse(page, 0, "fail");
		await expect.poll(() => page.evaluate(() => new URL(window.__sse[1]?.url ?? "http://x/").searchParams.get("since"))).toBe("live0010");
		const again = transcriptOf(LIVE);
		const later = { role: "user", content: text("after the reset"), timestamp: BASE_MS + 40_000, entryId: "live0011" };
		await sse(page, 1, "open");
		await sse(page, 1, "frame", init({ mode: "append", since: last, messages: [...again, later] }, { cursor: "live0011" }), "live0011");
		await expect(msgs.locator(".user-msg").last()).toHaveText("after the reset");
		await expect(msgs.locator(".msg-card")).toHaveCount(8);
		await expect(msgs.locator(".relay-note")).toHaveCount(5);
		await expect(msgs.locator(".compact-card.relay")).toHaveCount(2);

		// and a full redraw shows each once too
		await sse(page, 1, "fail");
		await sse(page, 2, "open");
		await sse(page, 2, "frame", init({ mode: "replace", messages: [...history, ...again, later], hasOlder: false }, { cursor: "live0011" }), "live0011");
		await expect(msgs.locator(".user-msg").last()).toHaveText("after the reset");
		await expect(msgs.locator(".msg-card")).toHaveCount(8);
		await expect(msgs.locator(".relay-note")).toHaveCount(5);
		await expect(msgs.locator(".compact-card.relay")).toHaveCount(2);

		// a sender this host doesn't know says so; a known one opens like a sidebar pick (here: running, so it attaches)
		await msgs.locator(".msg-card.died .msg-from").first().click();
		await expect(msgs.locator(".notice-text.error").last()).toHaveText(`flaky (${FLAKY}) isn't a session on this host.`);
		await msgs.locator(".msg-card").last().locator(".msg-from").click();
		await expect.poll(() => page.evaluate(() => window.__sse.at(-1)?.url ?? "")).toContain(`/api/sessions/${WORKER}/events`);
		expect(lookups).toEqual([FLAKY, WORKER]);
	});

	test("a message that wakes the session sits above the answer it gets", async ({ page }, testInfo) => {
		await page.addInitScript(installFakeEventSource);
		await page.route("**/api/client", (route) => route.fulfill({ json: { clientId: "fixture" } }));
		const running = { id: LEAD, path: "/sessions/lead.jsonl", cwd: "/repo", firstMessage: "lead", created: at(0), modified: at(0), messageCount: 0, isRunning: true };
		await page.route("**/api/active-sessions", (route) => route.fulfill({ json: { sessions: [running] } }));
		await page.route("**/api/sessions/*/tripwire-alerts", (route) => route.fulfill({ json: { alerts: [], unreadAlerts: [], unreadCount: 0 } }));
		await page.goto("/");
		if (testInfo.project.name.includes("iphone")) await page.locator("#kb-menu").click();
		await page.locator(`.si[data-session-id="${LEAD}"]`).click();
		await sse(page, 0, "open");
		await sse(page, 0, "frame", init({ mode: "replace", messages: [], hasOlder: false }));

		// pi starts the turn first, then brings the message in (msg's triggerTurn, or a steer between turns)
		const details = msgDetails({ from: worker, text: "are you there?" });
		const woke = { role: "custom", customType: "msg", content: framed(details), display: true, details, timestamp: BASE_MS };
		const answer = (value) => ({ role: "assistant", content: text(value), stopReason: "stop", usage, timestamp: BASE_MS + 1 });
		await sse(page, 0, "frame", agentEvent({ type: "agent_start" }));
		await sse(page, 0, "frame", agentEvent({ type: "turn_start" }));
		await sse(page, 0, "frame", agentEvent({ type: "message_start", message: woke }));
		await sse(page, 0, "frame", agentEvent({ type: "message_end", message: woke }, "m1"), "m1");
		await sse(page, 0, "frame", agentEvent({ type: "message_start", message: { ...answer(""), content: [] } }));
		await sse(page, 0, "frame", agentEvent({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "yes, " } }));
		await sse(page, 0, "frame", agentEvent({ type: "message_end", message: answer("yes, here") }, "a1"), "a1");

		const order = () => page.locator("#msgs > *").evaluateAll((nodes) => nodes.map((node) => (node.classList.contains("msg-card") ? "msg" : node.textContent?.trim())));
		await expect.poll(order).toEqual(["msg", "yes, here"]);
		await expect(page.locator(".msg-card .msg-body")).toHaveText("are you there?");
	});
});

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function startServer(root, port) {
	const proc = spawn(process.env.BUN_BINARY || "bun", ["src/server.ts"], { stdio: "ignore", env: sandboxServerEnv(root, { PI_WEB_PORT: String(port) }) });
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	proc.kill();
	throw new Error("server did not become healthy");
}

async function stopServer(proc) {
	if (proc.exitCode !== null) return;
	const exited = new Promise((resolve) => proc.once("exit", resolve));
	proc.kill("SIGTERM");
	await exited;
}

async function writeSession(root, cwd, id, entries) {
	const dir = join(root, "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-19T06-00-00-000Z_${id}.jsonl`);
	const lines = [{ type: "session", version: 3, id, timestamp: new Date(BASE_MS).toISOString(), cwd }, ...entries];
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

/** An isolated host with the lead's session file and the worker's, in another folder. */
async function setup() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-peer-e2e-"));
	const repo = join(root, "repo");
	const fork = join(root, "repo", ".forks", "2");
	await mkdir(fork, { recursive: true });
	const leadPath = await writeSession(root, repo, LEAD, leadEntries());
	const at = (seconds) => new Date(BASE_MS + seconds * 1000).toISOString();
	await writeSession(root, fork, WORKER, [
		{ type: "message", id: "w0000001", parentId: null, timestamp: at(1), message: { role: "user", content: text("rebase on main, then run the docs build"), timestamp: BASE_MS + 1000 } },
		{ type: "message", id: "w0000002", parentId: "w0000001", timestamp: at(2), message: { role: "assistant", content: text("rebased, docs build green"), api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "stop", timestamp: BASE_MS + 2000 } },
	]);
	const port = await freePort();
	return { root, leadPath, port, base: `http://127.0.0.1:${port}` };
}

/** Resumes the lead on the host, the way a sidebar or launcher pick would. */
async function resumeLead(page, leadPath) {
	await page.evaluate(async (resumeSessionPath) => {
		const client = await (await fetch("/api/client", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
		const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, resumeSessionPath }) });
		if (!res.ok) throw new Error(`resume failed: ${res.status}`);
	}, leadPath);
}

/**
 * A relay-like extension for a real session: a faux model answers, and pi's turn_end boundary appends a nudge after
 * the first turn and, after the second, a reset (a retain-none compaction) and a child's last word. No message
 * events come with any of them, only entry_appended.
 */
const BOUNDARY_EXTENSION = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default function (pi) {
	const faux = fauxProvider({ provider: "e2e-faux", models: [{ id: "faux-1", name: "faux one" }] });
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("got it")));
	pi.registerProvider(faux.provider);
	pi.on("session_start", async (_event, ctx) => {
		const model = ctx.modelRegistry.find("e2e-faux", "faux-1");
		if (model) await pi.setModel(model);
	});
	let turns = 0;
	pi.on("turn_end", () => {
		turns += 1;
		if (turns === 1) return { entries: [{ type: "custom_message", customType: "relay", content: "41%: finish the step", display: true, details: { kind: "nudge", percent: 41 } }] };
		if (turns !== 2) return undefined;
		const last = { v: 1, id: "0mgqk3x9z-dddddd", ts: 1, from: { id: "${WORKER}", name: "worker" }, to: "lead", text: "done here", kind: "ended", delivery: "steer" };
		return {
			entries: [
				{ type: "compaction", summary: "fresh start", firstKeptEntryId: null, details: { relay: { n: 1, percent: 45, note: "carry on from the notes" } } },
				{ type: "custom_message", customType: "msg", content: "<msg>done here</msg>", display: true, details: last },
			],
		};
	});
}
`;

test.describe("a real session", () => {
	test("draws what its turn boundaries append as it happens, and the same after a reload", async ({ page }, testInfo) => {
		const phone = testInfo.project.name.includes("iphone");
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-peer-live-e2e-"));
		const cwd = join(root, "repo");
		await mkdir(cwd);
		await mkdir(join(root, "agent", "extensions"), { recursive: true });
		await writeFile(join(root, "agent", "extensions", "boundary.ts"), BOUNDARY_EXTENSION);
		await writeFile(join(root, "agent", "auth.json"), JSON.stringify({ "e2e-faux": { type: "api_key", key: "not-a-real-key" } }));
		const port = await freePort();
		const base = `http://127.0.0.1:${port}`;
		const server = await startServer(root, port);
		const streams = [];
		page.on("request", (request) => {
			if (/\/api\/sessions\/[^/]+\/events/.test(request.url())) streams.push(request.url());
		});
		const send = async (value) => {
			await page.locator("#inp").fill(value);
			if (phone) await page.locator("#kb-enter").click();
			else await page.locator("#inp").press("Enter");
		};
		try {
			await page.goto(`${base}/?ui=phone`);
			const created = await page.evaluate(async (repo) => {
				const client = await (await fetch("/api/client", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
				const added = await fetch("/api/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo }) });
				if (!added.ok) throw new Error(`repo not added: ${added.status}`);
				const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, cwd: repo }) });
				return res.json();
			}, cwd);
			await page.reload();
			if (phone) await page.locator("#kb-menu").click();
			await page.locator(`.si[data-session-id="${created.sessionId}"]`).click();
			await expect(page.locator("#role-pill")).toHaveText("controller");
			const msgs = page.locator("#msgs");

			await send("first");
			await expect(msgs.locator(".relay-note .relay-line")).toHaveText(["relay · 41% · 41%: finish the step"]);
			await send("second");
			await expect(msgs.locator(".compact-card.relay .compact-label")).toHaveText(["relay #1 · context reset at 45%"]);
			await expect(msgs.locator(".msg-card .msg-body")).toHaveText(["done here"]);
			await expect(msgs.locator(".msg-card .msg-tag")).toHaveText(["finished"]);
			const order = () => msgs.locator(":scope > *").evaluateAll((nodes) => nodes.map((node) => node.className.split(" ")[0]));
			expect(await order()).toEqual(["user-msg", "assistant-block", "relay-note", "user-msg", "assistant-block", "compact-card", "msg-card"]);
			expect(streams).toHaveLength(1);

			await page.reload();
			if (phone) await page.locator("#kb-menu").click();
			await page.locator(`.si[data-session-id="${created.sessionId}"]`).click();
			await expect(msgs.locator(".msg-card")).toHaveCount(1);
			expect(await order()).toEqual(["user-msg", "assistant-block", "relay-note", "user-msg", "assistant-block", "compact-card", "msg-card"]);
		} finally {
			await stopServer(server).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});
});

test.describe("from a session file", () => {
	test("the phone shows the lead's peers and relay, and the worker's name opens the worker", async ({ page }, testInfo) => {
		const { root, leadPath, port, base } = await setup();
		const server = await startServer(root, port);
		try {
			await page.goto(`${base}/?ui=phone`);
			await resumeLead(page, leadPath);
			await page.reload();
			if (testInfo.project.name.includes("iphone")) await page.locator("#kb-menu").click();
			await page.locator(`.si[data-session-id="${LEAD}"]`).click();
			const msgs = page.locator("#msgs");
			await expectPeerTraffic(msgs);
			await msgs.locator(".msg-card").first().scrollIntoViewIfNeeded();
			await shoot(page, testInfo, "peer-traffic-phone");

			await msgs.locator(".msg-card").first().locator(".msg-from").click();
			await expect(msgs.locator(".user-msg")).toHaveText(["rebase on main, then run the docs build"]);
			await expect(msgs.locator(".assistant-block .md")).toHaveText(["rebased, docs build green"]);
			await expect.poll(() => page.evaluate(async (id) => (await (await fetch("/api/active-sessions")).json()).sessions.some((s) => s.id === id), WORKER)).toBe(true);
		} finally {
			await stopServer(server).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a canvas tile shows them too, and the worker's name opens it in a tile of its own", async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "chromium", "the canvas is laptop chrome only");
		const { root, leadPath, port, base } = await setup();
		const server = await startServer(root, port);
		const tile = (id) => page.locator(`.cv-tile[data-tile-id="${id}"]`);
		try {
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`${base}/?ui=phone`);
			await resumeLead(page, leadPath);
			await page.goto(`${base}/?ui=canvas`);
			await expect(page.locator(".cv-tile")).toHaveCount(1);
			await expectPeerTraffic(tile(LEAD));
			await shoot(page, testInfo, "peer-traffic-canvas");

			await tile(LEAD).locator(".msg-card").first().locator(".msg-from").click();
			await expect(page.locator(".cv-tile")).toHaveCount(2);
			await expect(tile(WORKER).locator(".user-msg")).toHaveText("rebase on main, then run the docs build");
			await expect(tile(WORKER).locator(".assistant-block .md")).toHaveText("rebased, docs build green");

			// one tile per session: the name of a session already on the canvas brings its tile into view (the camera
			// flew to the worker, so the lead's link is offscreen: click it in place)
			await tile(LEAD).locator(".msg-card").nth(1).locator(".msg-from").evaluate((el) => el instanceof HTMLElement && el.click());
			await expect(page.locator(".cv-tile")).toHaveCount(2);
			await expect(tile(WORKER)).toHaveClass(/cv-focused/);
		} finally {
			await stopServer(server).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});
});
