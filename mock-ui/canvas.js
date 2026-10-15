// Canvas prototype: the real canvas engine (public/app/canvas) with fake panes that stream like
// working sessions. Knobs: ?tiles=N&streaming=K&rate=R (deltas/s per streaming tile)
// &offscreen=stream (keep streaming offscreen tiles)&fps=0 (hide the meter)&seed=S&reset=1
// &panes=real (the shipped session pane on a fake api, see real_panes.js)&window=W (entries an
// unfocused real pane keeps, 0 = all). Fake panes batch deltas per animation frame across all panes
// and keep a window of messages.
import { createCanvas } from "/public/app/canvas/canvas.js";
import { createFpsMeter } from "/public/app/canvas/fps_meter.js";
import { gridSlot, nextFreeSlot, rectCenteredAt } from "/public/app/canvas/layout.js";
import { nextPinnedState } from "/public/app/session/scroll_follow.js";
import { MODELS, REPOS, TITLES, USER_ASKS, createTextSource, mulberry32 } from "./fake_text.js";
import { createRealPane, openFakeStreams } from "./real_panes.js";

const params = new URLSearchParams(location.search);
/** @param {string} name @param {number} fallback @param {number} min @param {number} max */
function intParam(name, fallback, min, max) {
	const raw = Number.parseInt(params.get(name) ?? "", 10);
	return Number.isFinite(raw) ? Math.min(Math.max(raw, min), max) : fallback;
}
const TILES = intParam("tiles", 12, 0, 300);
const STREAMING = intParam("streaming", Math.ceil(TILES / 3), 0, TILES);
const RATE = intParam("rate", 30, 1, 240);
const STREAM_OFFSCREEN = params.get("offscreen") === "stream";
const SHOW_FPS = params.get("fps") !== "0";
const SEED = intParam("seed", 1, 0, 2 ** 30);
const WINDOW_UNFOCUSED = 20;
const WINDOW_FOCUSED = 50;
const REAL_PANES = params.get("panes") === "real";
const REAL_WINDOW = intParam("window", WINDOW_UNFOCUSED, 0, 10_000);
const TRANSCRIPT_WINDOW = REAL_WINDOW > 0 ? { unfocused: REAL_WINDOW, focused: Math.max(REAL_WINDOW, WINDOW_FOCUSED), pageSize: 50 } : null;
const CAMERA_KEY = "pi-web.mock.canvas.camera";

const TOOLS = [
	["read", "public/app/canvas/viewport.js"],
	["$", "bun test tests/canvas_camera.test.js"],
	["edit", "public/canvas.css"],
	["$", "rg isEvictable src/"],
	["write", "mock-ui/canvas.js"],
];

/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** @typedef {{ kind: "block", node: HTMLElement } | { kind: "text", node: Text, text: string } | { kind: "done", box: HTMLElement, lines: string[] }} Op */
/** @typedef {{ kind: "user" } | { kind: "think", chars: number, node?: Text } | { kind: "tool", wait: number, box?: HTMLElement } | { kind: "text", chars: number, node?: Text } | { kind: "idle", wait: number }} Step */

/** @type {Set<ReturnType<typeof createFakePane>>} */
const dirtyPanes = new Set();
let flushFrame = 0;

function flushPanes() {
	flushFrame = 0;
	const panes = [...dirtyPanes];
	dirtyPanes.clear();
	for (const pane of panes) pane.applyOps();
	for (const pane of panes) pane.followBottom();
}

/** @param {ReturnType<typeof createFakePane>} pane */
function requestFlush(pane) {
	dirtyPanes.add(pane);
	if (!flushFrame) flushFrame = requestAnimationFrame(flushPanes);
}

/**
 * @param {NonNullable<ReturnType<ReturnType<typeof createCanvas>["tiles"]["get"]>>} tile
 * @param {number} index
 * @param {boolean} streaming
 */
function createFakePane(tile, index, streaming) {
	const { rand, pick, token, sentence, toolLines } = createTextSource(mulberry32(SEED * 7919 + index * 104729));
	const repo = REPOS[index % REPOS.length];
	const model = pick(MODELS);
	tile.titleEl.textContent = `${repo} · ${pick(TITLES)}`;
	const pill = el("span", "cv-pill");
	tile.statusEl.append(pill);
	const modelBtn = el("button", "cv-ctl", model);
	modelBtn.type = "button";
	modelBtn.title = "Model · thinking";
	const moreBtn = el("button", "cv-ctl", "⋯");
	moreBtn.type = "button";
	moreBtn.title = "Take over / release";
	tile.controlsEl.append(modelBtn, moreBtn);

	const msgs = el("div", "msgs");
	const input = el("textarea", "editor-input");
	input.rows = 1;
	const inner = el("div", "editor-inner");
	inner.append(input);
	const editor = el("div", "editor-wrap");
	editor.append(el("div", "editor-border", "─".repeat(200)), inner, el("div", "editor-border", "─".repeat(200)));
	const footer = el("div", "footer");
	footer.append(el("div", "footer-line", `~/Desktop/cc/${repo} · ${model} · ↑12k ↓3.4k · 14.2%/1.0M`));
	tile.body.append(msgs, editor, footer);

	/** @type {HTMLElement[]} */
	const blocks = [];
	/** @type {Op[]} */
	let ops = [];
	/** @type {Step[]} */
	let script = [];
	let limit = WINDOW_UNFOCUSED;
	let running = streaming;
	let visible = true;
	let pinned = true;
	let lastTop = 0;

	function setRunning(/** @type {boolean} */ next) {
		running = next;
		pill.textContent = next ? "working" : "idle";
		pill.className = `cv-pill ${next ? "is-working" : "is-idle"}`;
		tile.el.classList.toggle("cv-working", next);
	}

	/** @param {HTMLElement} node */
	function pushBlock(node) {
		ops.push({ kind: "block", node });
	}

	/** @param {Text} node @param {string} text */
	function pushText(node, text) {
		const last = ops.at(-1);
		if (last?.kind === "text" && last.node === node) last.text += text;
		else ops.push({ kind: "text", node, text });
	}

	const userBlock = (/** @type {string} */ text) => el("div", "user-msg", text);
	function streamBlock(/** @type {"think" | "text"} */ kind, /** @type {string} */ initial) {
		const block = el("div", "assistant-block");
		const holder = el("div", kind === "think" ? "thinking-text shown" : "md");
		const text = document.createTextNode(initial);
		holder.append(text);
		block.append(holder);
		return { block, text };
	}
	function toolBox(/** @type {boolean} */ done) {
		const [name, arg] = pick(TOOLS);
		const box = el("div", `tool-box ${done ? "success" : "pending"}`);
		box.append(el("div", "tool-title", `${name} ${arg}`));
		if (done) box.append(el("div", "tool-out", toolLines().join("\n")));
		return box;
	}

	function planTurn() {
		script.push({ kind: "user" }, { kind: "think", chars: 80 + rand() * 200 });
		const rounds = 1 + Math.floor(rand() * 3);
		for (let i = 0; i < rounds; i += 1) script.push({ kind: "tool", wait: 8 + rand() * 30 }, { kind: "text", chars: 150 + rand() * 600 });
		script.push({ kind: "idle", wait: 20 + rand() * 60 });
	}

	function tick() {
		if (!running) return;
		if (script.length === 0) planTurn();
		const step = script[0];
		switch (step.kind) {
			case "user":
				pushBlock(userBlock(pick(USER_ASKS)));
				script.shift();
				break;
			case "think":
			case "text": {
				if (!step.node) {
					const made = streamBlock(step.kind, "");
					step.node = made.text;
					pushBlock(made.block);
				}
				const chunk = token();
				pushText(step.node, chunk);
				step.chars -= chunk.length;
				if (step.chars <= 0) script.shift();
				break;
			}
			case "tool":
				if (!step.box) {
					step.box = toolBox(false);
					pushBlock(step.box);
				}
				step.wait -= 1;
				if (step.wait <= 0) {
					ops.push({ kind: "done", box: step.box, lines: toolLines() });
					script.shift();
				}
				break;
			case "idle":
				step.wait -= 1;
				if (step.wait <= 0) script.shift();
				break;
		}
		if (ops.length > 0) requestFlush(api);
	}

	function trim() {
		while (blocks.length > limit) blocks.shift()?.remove();
	}

	function applyOps() {
		const batch = ops;
		ops = [];
		for (const op of batch) {
			switch (op.kind) {
				case "block":
					msgs.append(op.node);
					blocks.push(op.node);
					break;
				case "text":
					op.node.appendData(op.text);
					break;
				case "done":
					op.box.className = "tool-box success";
					op.box.append(el("div", "tool-out", op.lines.join("\n")));
					break;
			}
		}
		trim();
	}

	function followBottom() {
		if (pinned) msgs.scrollTop = msgs.scrollHeight;
	}

	msgs.addEventListener(
		"scroll",
		() => {
			const top = msgs.scrollTop;
			pinned = nextPinnedState({ pinned, previousTop: lastTop, top, remaining: msgs.scrollHeight - top - msgs.clientHeight });
			lastTop = top;
		},
		{ passive: true },
	);

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		const text = input.value.trim();
		if (!text) return;
		input.value = "";
		pushBlock(userBlock(text));
		script = [{ kind: "think", chars: 120 }, { kind: "text", chars: 400 }, { kind: "idle", wait: 1 }];
		pinned = true;
		setRunning(true);
		requestFlush(api);
	});

	const api = {
		tick,
		applyOps,
		followBottom,
		get streaming() {
			return running && (visible || STREAM_OFFSCREEN);
		},
		/** @param {boolean} next */
		setVisible(next) {
			visible = next;
		},
		/** @param {boolean} focused */
		setFocused(focused) {
			limit = focused ? WINDOW_FOCUSED : WINDOW_UNFOCUSED;
			trim();
		},
		focusComposer: () => input.focus({ preventScroll: true }),
		abort() {
			if (!running) return;
			script = [];
			setRunning(false);
			pushBlock(el("div", "assistant-block notice-text error", "Operation aborted"));
			requestFlush(api);
		},
		destroy() {
			ops = [];
			script = [];
			running = false;
			dirtyPanes.delete(api);
		},
	};

	for (let turn = 0; turn < 7; turn += 1) {
		pushBlock(userBlock(pick(USER_ASKS)));
		pushBlock(streamBlock("think", sentence(120)).block);
		pushBlock(toolBox(true));
		pushBlock(streamBlock("text", sentence(300 + rand() * 500)).block);
	}
	setRunning(running);
	requestFlush(api);
	return api;
}

const root = /** @type {HTMLElement} */ (document.getElementById("canvas"));
if (params.get("reset") === "1") localStorage.removeItem(CAMERA_KEY);
/** @type {unknown} */
let storedCamera = null;
try {
	storedCamera = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? "null");
} catch {
	storedCamera = null;
}

/** @type {Map<string, ReturnType<typeof createFakePane>>} */
const panes = new Map();
let created = 0;

const canvas = createCanvas({
	root,
	camera: storedCamera ?? { x: 40, y: 64, scale: 0.6 },
	onNewTile: () => {
		const id = addFakeTile(nextFreeSlot(canvas.tiles.rects()), false);
		canvas.tiles.focusTile(id);
		canvas.revealTile(id);
		panes.get(id)?.focusComposer();
	},
	onEmptyDoubleClick: (point) => {
		const id = addFakeTile(rectCenteredAt(point), false);
		canvas.tiles.focusTile(id);
		panes.get(id)?.focusComposer();
	},
	onFocusChange: (() => {
		/** @type {string | null} */
		let previous = null;
		return (/** @type {string | null} */ id) => {
			if (previous) panes.get(previous)?.setFocused(false);
			if (id) panes.get(id)?.setFocused(true);
			previous = id;
		};
	})(),
	focusComposer: (id) => panes.get(id)?.focusComposer(),
	onCloseRequest: (id) => closeTile(id),
	onVisibilityChange: (id, visible) => panes.get(id)?.setVisible(visible),
	onCameraSettle: (camera) => localStorage.setItem(CAMERA_KEY, JSON.stringify(camera)),
	onEscape: (id) => panes.get(id)?.abort(),
});

/** @param {import("/public/app/canvas/camera.js").Rect} rect @param {boolean} streaming */
function addFakeTile(rect, streaming) {
	const index = created;
	created += 1;
	const id = `mock-${index}`;
	const tile = canvas.tiles.addTile({ id, rect });
	const text = createTextSource(mulberry32(SEED * 7919 + index * 104729));
	panes.set(
		id,
		REAL_PANES
			? createRealPane(tile, { index, streaming, text, streamOffscreen: STREAM_OFFSCREEN, transcriptWindow: TRANSCRIPT_WINDOW })
			: createFakePane(tile, index, streaming),
	);
	return id;
}

/** @param {string} id */
function closeTile(id) {
	panes.get(id)?.destroy();
	panes.delete(id);
	canvas.tiles.removeTile(id);
}

for (let i = 0; i < TILES; i += 1) addFakeTile(gridSlot(i), i < STREAMING);

const tickTimer = setInterval(() => {
	for (const pane of panes.values()) if (pane.streaming) pane.tick();
}, 1000 / RATE);

const meter = SHOW_FPS ? createFpsMeter(root) : null;

Object.assign(window, {
	__canvasMock: {
		canvas,
		meter,
		knobs: { tiles: TILES, streaming: STREAMING, rate: RATE, streamOffscreen: STREAM_OFFSCREEN, realPanes: REAL_PANES, window: TRANSCRIPT_WINDOW },
		addTile: () => addFakeTile(nextFreeSlot(canvas.tiles.rects()), true),
		removeTile: closeTile,
		tileIds: () => canvas.tiles.ids(),
		paneCount: () => panes.size,
		/** Stops every fake stream (e.g. before counting what the panes show). */
		stopStreaming: () => clearInterval(tickTimer),
		openFakeStreams,
		/** @param {string} id */
		shownEntries: (id) => {
			const pane = panes.get(id);
			return pane && "shownEntries" in pane ? pane.shownEntries() : null;
		},
	},
});
