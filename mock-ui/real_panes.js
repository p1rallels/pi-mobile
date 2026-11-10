// Real session panes (public/app/session/pane.js) on the canvas mock, fed by a fake pi-web api: each
// tile's EventSource plays a scripted agent run (prompts, thinking and text deltas, tool calls with
// streaming output, message_end frames with entry ids) so the perf harness measures the pane that
// ships, windowing and all. One tick sends one frame, sometimes a few at a turn's seams.
import { createSessionPane } from "/public/app/session/pane.js";
import { buildPaneDom } from "/public/app/session/pane_dom.js";
import { MODELS, REPOS, TITLES, USER_ASKS } from "./fake_text.js";

const CLIENT_ID = "mock-client";
const OLDER_DEPTH = 400;
const TOOL_CALLS = [
	["bash", { command: "bun test tests/canvas_camera.test.js" }],
	["read", { path: "public/app/canvas/viewport.js" }],
	["edit", { path: "public/canvas.css", oldText: ".cv-glow { opacity: 0.6 }", newText: ".cv-glow { opacity: 0.4 }" }],
	["bash", { command: "rg -n isEvictable src/" }],
	["grep", { pattern: "contain: strict", path: "public" }],
];
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

let openStreams = 0;
export const openFakeStreams = () => openStreams;

/** @typedef {ReturnType<import("./fake_text.js").createTextSource>} TextSource */
/**
 * @typedef {{ kind: "user", text: string } | { kind: "think", chars: number } | { kind: "text", chars: number }
 *   | { kind: "call" } | { kind: "run", ticks: number } | { kind: "final" } | { kind: "idle", ticks: number }} Step
 */

/** @param {string} text */
const textContent = (text) => [{ type: "text", text }];

/**
 * A pi session as the browser sees it: history pages, an init frame, and a scripted run of agent events.
 * @param {{ index: number, text: TextSource, title: string, cwd: string }} options
 */
function createSimulatedSession({ index, text, title, cwd }) {
	const sessionId = `mock-session-${index}`;
	let seq = 0;
	let olderServed = 0;
	const entryId = () => `e${index}x${(seq += 1).toString(36)}`;
	/** @type {Step[]} */
	let script = [];
	let running = false;
	/** @type {{ thinking: string, text: string, call: { id: string, name: string, arguments: unknown } | null }} */
	let assistant = { thinking: "", text: "", call: null };
	let output = "";
	/** @type {((event: unknown, entryId?: string) => void) | null} */
	let send = null;
	let lastEntryId = "";

	/** @param {unknown} event @param {string} [id] */
	function emit(event, id) {
		if (id) lastEntryId = id;
		send?.(event, id);
	}

	function toolCall() {
		const [name, args] = text.pick(TOOL_CALLS);
		return { type: "toolCall", id: `call_${index}_${(seq += 1).toString(36)}`, name, arguments: args };
	}

	/** @param {string} prefix */
	function historyTurn(prefix) {
		const id = () => `${prefix}${index}x${(seq += 1).toString(36)}`;
		const call = toolCall();
		return [
			{ role: "user", content: textContent(text.pick(USER_ASKS)), timestamp: seq, entryId: id() },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: text.sentence(160) }, { type: "text", text: text.sentence(200) }, call],
				stopReason: "toolUse",
				timestamp: seq,
				entryId: id(),
			},
			{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: textContent(text.toolLines().join("\n")), isError: false, timestamp: seq, entryId: id() },
			{ role: "assistant", content: [{ type: "text", text: text.sentence(300 + text.rand() * 600) }], stopReason: "stop", timestamp: seq, entryId: id() },
		];
	}

	/** @param {string} prefix @param {number} count */
	function historyMessages(prefix, count) {
		const messages = [];
		while (messages.length < count) messages.push(...historyTurn(prefix));
		return messages.slice(messages.length - count);
	}

	function state() {
		return {
			sessionId,
			cwd,
			sessionFile: null,
			sessionName: title,
			isStreaming: running,
			isCompacting: false,
			retryAttempt: 0,
			model: { provider: "anthropic", id: text.pick(MODELS).split(" · ")[0].replace(" ", "-") },
			thinkingLevel: "high",
			steeringMode: "all",
			followUpMode: "all",
			stats: { tokens: { input: 12_000 + index * 991, output: 3_400 + index * 97 }, cost: 0.42 },
			contextUsage: { contextWindow: 1_000_000, percent: 14 },
			queuedMessages: { steering: [], followUp: [] },
		};
	}

	/** @param {number} limit @param {string | null} since */
	function init(limit, since) {
		const transcript = since ? { mode: "append", since, messages: [] } : { mode: "replace", messages: historyMessages("h", limit), hasOlder: true };
		if (!since && transcript.messages.length > 0) lastEntryId = transcript.messages.at(-1).entryId;
		return {
			type: "init",
			state: state(),
			transcript,
			live: null,
			ui: { dialogs: [], statuses: {}, widgets: {}, title: null },
			cursor: lastEntryId,
			yourClientId: CLIENT_ID,
			controllerClientId: CLIENT_ID,
			role: "controller",
		};
	}

	/** @param {number} limit */
	function olderPage(limit) {
		const count = Math.max(0, Math.min(limit, OLDER_DEPTH - olderServed));
		olderServed += count;
		return { messages: historyMessages("o", count), hasOlder: olderServed < OLDER_DEPTH };
	}

	/** @param {string} prompt */
	function planTurn(prompt) {
		script.push({ kind: "user", text: prompt }, { kind: "think", chars: 80 + text.rand() * 200 });
		const rounds = 1 + Math.floor(text.rand() * 3);
		for (let i = 0; i < rounds; i += 1) script.push({ kind: "text", chars: 60 + text.rand() * 200 }, { kind: "call" }, { kind: "run", ticks: 4 + text.rand() * 20 });
		script.push({ kind: "text", chars: 150 + text.rand() * 600 }, { kind: "final" }, { kind: "idle", ticks: 20 + text.rand() * 60 });
	}

	/** @param {string} type @param {Record<string, unknown>} fields */
	const update = (type, fields) => ({ type: "message_update", usage: USAGE, assistantMessageEvent: { type, contentIndex: 0, ...fields } });

	function assistantMessage(stopReason) {
		const content = [];
		if (assistant.thinking) content.push({ type: "thinking", thinking: assistant.thinking });
		if (assistant.text) content.push({ type: "text", text: assistant.text });
		if (assistant.call) content.push({ type: "toolCall", ...assistant.call });
		return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "mock", usage: USAGE, stopReason, timestamp: Date.now() };
	}

	function startAssistant() {
		assistant = { thinking: "", text: "", call: null };
		emit({ type: "turn_start" });
		emit({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } });
	}

	/** @param {Step} step @returns {boolean} whether the step is finished */
	function advance(step) {
		switch (step.kind) {
			case "user": {
				const message = { role: "user", content: textContent(step.text), timestamp: Date.now() };
				running = true;
				emit({ type: "agent_start" });
				emit({ type: "message_start", message });
				emit({ type: "message_end", message }, entryId());
				startAssistant();
				return true;
			}
			case "think":
			case "text": {
				const delta = text.token();
				if (step.kind === "think") assistant.thinking += delta;
				else assistant.text += delta;
				emit(update(step.kind === "think" ? "thinking_delta" : "text_delta", { delta }));
				step.chars -= delta.length;
				return step.chars <= 0;
			}
			case "call": {
				const call = toolCall();
				assistant.call = { id: call.id, name: call.name, arguments: call.arguments };
				emit(update("toolcall_start", { id: call.id, toolName: call.name }));
				emit(update("toolcall_end", { toolCall: call }));
				emit({ type: "message_end", message: assistantMessage("toolUse") }, entryId());
				emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
				output = "";
				return true;
			}
			case "run": {
				const call = assistant.call;
				if (!call) return true;
				output += `${output ? "\n" : ""}${text.rand() < 0.5 ? text.codeLine() : text.sentence(50)}`;
				step.ticks -= 1;
				if (step.ticks > 0) {
					emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, args: call.arguments, partialResult: { content: textContent(output) } });
					return false;
				}
				const result = { content: textContent(output) };
				emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError: false, durationMs: 400 + Math.round(text.rand() * 3000) });
				emit({ type: "message_end", message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: false, timestamp: Date.now() } }, entryId());
				emit({ type: "turn_end" });
				startAssistant();
				return true;
			}
			case "final":
				emit({ type: "message_end", message: assistantMessage("stop") }, entryId());
				emit({ type: "turn_end" });
				emit({ type: "agent_end", messages: [] });
				running = false;
				emit({ type: "agent_settled" });
				return true;
			case "idle":
				step.ticks -= 1;
				return step.ticks <= 0;
		}
	}

	return {
		sessionId,
		init,
		olderPage,
		/** @param {((event: unknown, entryId?: string) => void) | null} next */
		attach(next) {
			send = next;
		},
		/** @param {boolean} autoplay keep planning turns (a working session) */
		tick(autoplay) {
			if (script.length === 0) {
				if (!autoplay) return;
				planTurn(text.pick(USER_ASKS));
			}
			const step = script[0];
			if (advance(step)) script.shift();
		},
		/** @param {string} prompt */
		prompt(prompt) {
			if (running) return;
			script = [];
			planTurn(prompt);
			script.pop();
		},
		abort() {
			if (!running) return;
			script = [];
			emit({ type: "message_end", message: assistantMessage("aborted") }, entryId());
			emit({ type: "agent_end", messages: [] });
			running = false;
			emit({ type: "agent_settled" });
		},
		hasWork: () => running || script.length > 0,
	};
}

/**
 * The pi-web api a pane talks to, answered by the simulated session.
 * @param {ReturnType<typeof createSimulatedSession>} session
 */
function createFakeApi(session) {
	/** @param {string} path */
	const urlOf = (path) => new URL(path, window.location.origin);
	return {
		headers: () => ({ "content-type": "application/json" }),
		getBaseUrl: () => window.location.origin,
		setBaseUrl() {},
		/** @param {string} path */
		resolveUrl: (path) => urlOf(path).toString(),
		/** @param {string} path */
		async getJson(path) {
			const url = urlOf(path);
			if (url.pathname.endsWith("/transcript")) return session.olderPage(Number.parseInt(url.searchParams.get("limit") ?? "200", 10));
			if (url.pathname.endsWith("/tripwire-alerts")) return { unreadAlerts: [] };
			if (url.pathname === "/api/models") return { models: [] };
			return {};
		},
		/** @param {string} path @param {any} body */
		async postJson(path, body) {
			if (path.endsWith("/command") && body?.type === "prompt") session.prompt(String(body.text ?? ""));
			if (path.endsWith("/command") && body?.type === "abort") session.abort();
			return { disposition: "started" };
		},
		async putJson() {
			return {};
		},
		/** @param {string} path */
		eventSource(path) {
			const url = urlOf(path);
			const limit = Number.parseInt(url.searchParams.get("limit") ?? "150", 10);
			const since = url.searchParams.get("since");
			/** @type {Map<string, Set<(event: unknown) => void>>} */
			const listeners = new Map();
			let closed = false;
			openStreams += 1;
			const source = {
				readyState: 0,
				/** @type {null | (() => void)} */ onopen: null,
				/** @type {null | ((message: { data: string, lastEventId: string }) => void)} */ onmessage: null,
				/** @type {null | (() => void)} */ onerror: null,
				/** @param {string} type @param {(event: unknown) => void} fn */
				addEventListener(type, fn) {
					if (!listeners.has(type)) listeners.set(type, new Set());
					listeners.get(type)?.add(fn);
				},
				/** @param {string} type @param {(event: unknown) => void} fn */
				removeEventListener(type, fn) {
					listeners.get(type)?.delete(fn);
				},
				close() {
					if (closed) return;
					closed = true;
					openStreams -= 1;
					source.readyState = 2;
					session.attach(null);
				},
			};
			/** @param {unknown} event @param {string} [id] */
			const deliver = (event, id) => source.onmessage?.({ data: JSON.stringify(event), lastEventId: id ?? "" });
			queueMicrotask(() => {
				if (closed) return;
				source.readyState = 1;
				source.onopen?.();
				const init = session.init(limit, since);
				deliver(init, init.cursor);
				session.attach((event, id) => deliver({ type: "agent_event", event, ...(id ? { entryId: id } : {}) }, id));
			});
			return source;
		},
	};
}

/**
 * A canvas tile running the real session pane; same surface as the mock's fake panes.
 * @param {NonNullable<ReturnType<ReturnType<typeof import("/public/app/canvas/canvas.js").createCanvas>["tiles"]["get"]>>} tile
 * @param {{ index: number, streaming: boolean, text: TextSource, streamOffscreen: boolean, transcriptWindow: { unfocused: number, focused: number, pageSize: number } | null }} options
 */
export function createRealPane(tile, { index, streaming, text, streamOffscreen, transcriptWindow }) {
	const repo = REPOS[index % REPOS.length];
	const title = `${repo} · ${text.pick(TITLES)}`;
	const session = createSimulatedSession({ index, text, title, cwd: `/Users/mock/code/${repo}` });
	tile.titleEl.textContent = title;
	const pill = document.createElement("span");
	pill.className = "cv-pill";
	tile.statusEl.append(pill);
	const btnModel = document.createElement("button");
	btnModel.type = "button";
	btnModel.className = "cv-ctl cv-ctl-model";
	const lblModel = document.createElement("span");
	lblModel.className = "sel";
	btnModel.append(lblModel);
	tile.controlsEl.append(btnModel);

	const { el, refs } = buildPaneDom(document);
	tile.body.replaceChildren(el);
	let shownPill = "";
	/** @type {ReturnType<typeof createSessionPane> | null} */
	let pane = null;
	pane = createSessionPane({
		refs: { ...refs, btnModel, lblModel },
		api: createFakeApi(session),
		getClientId: () => CLIENT_ID,
		menuDom: { menuOverlay: null, menuScrim: null, menuPanel: null },
		getHost: () => ({ hostLabel: "mock", baseUrl: window.location.origin }),
		onStateChange: () => {
			const working = Boolean(pane && pane.getRunStatus().kind !== "idle");
			const key = working ? "working" : "idle";
			if (key === shownPill) return;
			shownPill = key;
			pill.textContent = key;
			pill.className = `cv-pill is-${key}`;
			tile.el.classList.toggle("cv-working", working);
		},
		transcriptWindow,
	});
	let visible = tile.visible;
	const live = pane;
	live.openSessionId(session.sessionId);

	return {
		tick: () => session.tick(streaming),
		applyOps() {},
		followBottom() {},
		get streaming() {
			return (streaming || session.hasWork()) && (visible || streamOffscreen);
		},
		/** @param {boolean} next */
		setVisible(next) {
			visible = next;
		},
		/** @param {boolean} focused */
		setFocused: (focused) => live.setFocused(focused),
		focusComposer: () => live.focusComposer(),
		abort: () => live.abort(),
		shownEntries: () => live.getShownEntryCount(),
		destroy() {
			live.destroy();
			session.attach(null);
		},
	};
}
