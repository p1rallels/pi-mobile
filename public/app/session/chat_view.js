import { safeRandomUUID } from "../core/uuid.js";
import { safeStringify } from "../core/stringify.js";
import { peerToolOutcome, toolOutputText } from "../core/tool_format.js";
import { renderMarkdown } from "../render/markdown.js";
import { extractTextContent, parseAssistantContent } from "./content.js";
import { entryMessage, msgView, relayResetView, relayView } from "./custom_messages.js";
import { createScrollFollower } from "./scroll_follow.js";
import { createToolBoxManager } from "./tool_boxes.js";

function messageTimestamp(message) {
	return message && typeof message.timestamp === "number" ? message.timestamp : null;
}

/**
 * A compaction summary without an entry id comes from a model projection, which puts it first: it moves to where
 * its timestamp says. One with an entry id is already where its entry is (a relay reset and the note appended with
 * it share a millisecond, so timestamps can't place it).
 */
function isLooseCompaction(message) {
	return Boolean(message && typeof message === "object" && message.role === "compactionSummary" && typeof message.entryId !== "string");
}

export function orderMessagesForDisplay(messages) {
	if (!Array.isArray(messages)) return [];
	const indexed = messages.map((message, index) => ({ message, index }));
	const compactions = indexed.filter(({ message }) => isLooseCompaction(message));
	if (compactions.length === 0) return messages;

	const ordered = indexed.filter(({ message }) => !isLooseCompaction(message)).map(({ message }) => message);
	for (const { message } of compactions.sort((a, b) => a.index - b.index)) {
		const ts = messageTimestamp(message);
		const insertAt =
			ts === null
				? ordered.length
				: ordered.findIndex((candidate) => {
						const candidateTs = messageTimestamp(candidate);
						return candidateTs !== null && candidateTs > ts;
					});
		ordered.splice(insertAt === -1 ? ordered.length : insertAt, 0, message);
	}
	return ordered;
}

function imageBlocks(content) {
	return Array.isArray(content) ? content.filter((block) => block && block.type === "image") : [];
}

/** Mirrors pi's parseSkillBlock: an expanded `/skill:name args` prompt. */
export function parseSkillBlock(text) {
	const match = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(String(text));
	if (!match) return null;
	return { name: match[1], location: match[2], content: match[3], userMessage: match[4]?.trim() || undefined };
}

function renderUserText(el, text) {
	const skill = parseSkillBlock(text);
	if (!skill) {
		el.textContent = text;
		return;
	}
	el.textContent = "";
	const toggle = document.createElement("span");
	toggle.className = "skill-chip";
	toggle.textContent = `[skill: ${skill.name}]`;
	toggle.title = skill.location;
	const body = document.createElement("div");
	body.className = "skill-body";
	body.hidden = true;
	body.textContent = skill.content;
	toggle.addEventListener("click", () => {
		body.hidden = !body.hidden;
	});
	el.appendChild(toggle);
	if (skill.userMessage) el.appendChild(document.createTextNode(` ${skill.userMessage}`));
	el.appendChild(body);
}

function appendStreamedText(el, raw, shownLength) {
	const pending = raw.slice(shownLength);
	if (!pending) return shownLength;
	const last = el.lastChild;
	if (last && last.nodeType === Node.TEXT_NODE) {
		last.appendData(pending);
	} else {
		el.appendChild(document.createTextNode(pending));
	}
	return raw.length;
}

function markProvisional(el) {
	el.dataset.provisional = "1";
}

function confirmNode(el, entryId) {
	if (!el) return;
	delete el.dataset.provisional;
	if (entryId) el.dataset.entryId = entryId;
}

function toolEventsFromLive(tool) {
	const base = { toolCallId: tool.toolCallId, toolName: tool.toolName };
	const nested = typeof tool.parentToolCallId === "string" ? { parentToolCallId: tool.parentToolCallId } : {};
	const events = [{ type: "tool_execution_start", ...base, ...nested, args: tool.args }];
	if (tool.partialResult !== undefined) events.push({ type: "tool_execution_update", ...base, ...nested, args: tool.args, partialResult: tool.partialResult });
	if (tool.done) events.push({ type: "tool_execution_end", ...base, ...nested, result: tool.result, isError: Boolean(tool.isError), durationMs: tool.durationMs });
	return events;
}

const UNPINNED_WINDOW_MIN = 200;

/** Distinct entry ids of the top-level transcript nodes, oldest first (an assistant block and its tool boxes share one). */
export function entryIdsInOrder(nodes) {
	const ids = [];
	const seen = new Set();
	for (const node of nodes) {
		const id = node?.dataset?.entryId;
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

/** The entry the window starts at when it keeps the newest `max` entries, or null when everything fits. */
export function windowStart(ids, max) {
	if (!Number.isFinite(max) || ids.length <= max) return null;
	return ids[ids.length - Math.max(1, Math.floor(max))] ?? null;
}

/** @typedef {{ id: string, label: string, cwd: string }} SessionRef a session another one names (a msg sender) */

/** @param {string} className @param {string} text */
function span(className, text) {
	const el = document.createElement("span");
	el.className = className;
	el.textContent = text;
	return el;
}

const MSG_KIND_CLASSES = new Set(["ended", "died", "stalled"]);

/** The class a msg card and its tag take: its kind (ended, died, stalled), or stopped for an ended sub that was cut short. @param {import("./custom_messages.js").MsgView} view */
const msgKindClass = (view) => (view.stopped ? "stopped" : MSG_KIND_CLASSES.has(view.kind) ? view.kind : "");

/**
 * @param {{ msgsEl: HTMLElement, queuedEl: HTMLElement | null, pillEl?: HTMLElement | null, onTrim?: (oldestEntryId: string) => void, onOpenSession?: ((session: SessionRef) => void) | null }} options
 * `onTrim` hears about entries a windowed view dropped from its top, so "earlier messages" can fetch them again.
 * `onOpenSession` opens a session a message names (a msg sender); without it the name is plain text.
 */
export function createChatView({ msgsEl, queuedEl, pillEl = null, onTrim = () => {}, onOpenSession = null }) {
	let currentAssistant = null; // { block, text, thinking, rawText, rawThinking, shownText, shownThinking }
	let renderedEntryIds = new Set();
	let entryOrder = []; // rendered entry ids in display order, including ones that draw nothing of their own
	let appendedUserMessageKeys = new Set();
	let expandedCompactionIds = new Set();
	let appendedCompactionIds = new Set();
	const streamingBlocks = new Set();
	const pendingToolOutput = new Map(); // toolCallId -> { toolName, result }: partial results, drawn once per frame
	let frameRequested = false;
	let mountTarget = null;
	let mountEntryId = null;
	let olderControl = null;
	let windowMax = Infinity;
	let trimPending = false;

	const follower = createScrollFollower({ scrollEl: msgsEl, pillEl });

	function writeStreamingBlock(block) {
		if (block.rawThinking.length > block.shownThinking) {
			block.thinking.style.display = "";
			block.thinking.classList.add("shown");
			block.shownThinking = appendStreamedText(block.thinking, block.rawThinking, block.shownThinking);
		}
		if (block.rawText.length > block.shownText) {
			block.shownText = appendStreamedText(block.text, block.rawText, block.shownText);
		}
	}

	function writePendingToolOutput() {
		for (const [toolCallId, { toolName, result }] of pendingToolOutput) {
			if (tools.has(toolCallId)) tools.setText(toolCallId, toolName, toolOutputText(toolName, result, { partial: true }));
		}
		pendingToolOutput.clear();
	}

	function flush() {
		frameRequested = false;
		writePendingToolOutput();
		for (const block of streamingBlocks) writeStreamingBlock(block);
		streamingBlocks.clear();
		if (trimPending) {
			trimPending = false;
			trimWindow();
		}
		follower.sync();
	}

	function scheduleFrame() {
		if (frameRequested) return;
		frameRequested = true;
		requestAnimationFrame(flush);
	}

	function markStreaming(block) {
		streamingBlocks.add(block);
		scheduleFrame();
	}

	function finalizeStreaming(block) {
		streamingBlocks.delete(block);
		block.shownText = block.rawText.length;
		block.shownThinking = block.rawThinking.length;
	}

	function mount(el) {
		if (mountEntryId) el.dataset.entryId = mountEntryId;
		(mountTarget || msgsEl).appendChild(el);
	}

	/** A newly drawn entry at the bottom: the window may have to give up its oldest one. */
	function noteEntry(entryId) {
		if (!entryId) return;
		renderedEntryIds.add(entryId);
		entryOrder.push(entryId);
		if (Number.isFinite(windowMax)) {
			trimPending = true;
			scheduleFrame();
		}
	}

	/** Drops what a top-level node registered for dedupe, so the same entry can be drawn again later. */
	function forgetNode(node) {
		if (!(node instanceof HTMLElement)) return;
		if (node.dataset.compactionId) appendedCompactionIds.delete(node.dataset.compactionId);
		if (node.dataset.userKey) appendedUserMessageKeys.delete(node.dataset.userKey);
		if (currentAssistant && currentAssistant.block === node) currentAssistant = null;
		for (const block of streamingBlocks) {
			if (block.block === node) streamingBlocks.delete(block);
		}
	}

	/**
	 * Removes every top-level node above the first node of `keepFrom` (notices without an entry go with
	 * them) and forgets the dropped entries, so they can be fetched and drawn again.
	 */
	function dropAbove(keepFrom) {
		let node = msgsEl.firstChild;
		while (node && !(node instanceof HTMLElement && node.dataset.entryId === keepFrom)) {
			const next = node.nextSibling;
			if (node !== olderControl) {
				forgetNode(node);
				node.remove();
			}
			node = next;
		}
		const cut = entryOrder.indexOf(keepFrom);
		if (cut > 0) {
			for (const id of entryOrder.slice(0, cut)) renderedEntryIds.delete(id);
			entryOrder = entryOrder.slice(cut);
		}
		tools.prune();
	}

	/**
	 * Windowed views (canvas tiles) keep the newest `windowMax` entries while they follow the bottom. A
	 * reader scrolled up keeps far more, and their place, so new output never yanks what they read.
	 */
	function trimWindow() {
		if (!Number.isFinite(windowMax)) return;
		const pinned = follower.isPinned();
		const keepFrom = windowStart(entryIdsInOrder(msgsEl.children), pinned ? windowMax : Math.max(UNPINNED_WINDOW_MIN, windowMax * 4));
		if (!keepFrom) return;
		if (pinned) {
			dropAbove(keepFrom);
		} else {
			const top = msgsEl.scrollTop;
			const height = msgsEl.scrollHeight;
			dropAbove(keepFrom);
			follower.restore(Math.max(0, top - (height - msgsEl.scrollHeight)));
		}
		onTrim(keepFrom);
	}

	/** @param {number} max entries to keep (Infinity: no window, the phone) */
	function setWindow(max) {
		const next = Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity;
		if (next === windowMax) return;
		const shrinking = next < windowMax;
		windowMax = next;
		if (shrinking) {
			trimPending = true;
			scheduleFrame();
		}
	}

	function clear() {
		msgsEl.innerHTML = "";
		olderControl = null;
		currentAssistant = null;
		streamingBlocks.clear();
		pendingToolOutput.clear();
		tools.clear();
		renderedEntryIds = new Set();
		entryOrder = [];
		appendedUserMessageKeys = new Set();
		expandedCompactionIds = new Set();
		appendedCompactionIds = new Set();
		clearQueuedMessages();
	}

	function clearQueuedMessages() {
		if (!queuedEl) return;
		queuedEl.innerHTML = "";
		queuedEl.classList.remove("open");
	}

	function renderQueuedMessages(queuedMessages = {}) {
		if (!queuedEl) return;
		clearQueuedMessages();
		const steering = Array.isArray(queuedMessages.steering) ? queuedMessages.steering : [];
		const followUp = Array.isArray(queuedMessages.followUp) ? queuedMessages.followUp : [];
		if (steering.length === 0 && followUp.length === 0) return;

		const addLine = (kind, text) => {
			const line = document.createElement("div");
			line.className = "queued-line";
			const label = document.createElement("span");
			label.className = `queued-kind${kind === "Follow-up" ? " follow-up" : ""}`;
			label.textContent = `${kind}: `;
			line.appendChild(label);
			line.appendChild(document.createTextNode(text));
			queuedEl.appendChild(line);
		};

		for (const message of steering) addLine("Steering", message);
		for (const message of followUp) addLine("Follow-up", message);

		const hint = document.createElement("div");
		hint.className = "queued-line queued-hint";
		hint.textContent = "↳ queued messages show here until delivered";
		queuedEl.appendChild(hint);
		queuedEl.classList.add("open");
	}

	function appendAssistantBlock({ provisional = false } = {}) {
		const block = document.createElement("div");
		block.className = "assistant-block";
		if (provisional) markProvisional(block);

		const thinking = document.createElement("div");
		thinking.className = "thinking-text";
		thinking.style.display = "none";

		const text = document.createElement("div");
		text.className = "md";
		text.textContent = "";

		block.appendChild(thinking);
		block.appendChild(text);
		mount(block);

		currentAssistant = { block, text, thinking, rawText: "", rawThinking: "", shownText: 0, shownThinking: 0 };
		return currentAssistant;
	}

	function ensureLiveAssistantBlock() {
		return currentAssistant || appendAssistantBlock({ provisional: true });
	}

	function setLiveToolCall(id, name, args) {
		const isNew = !tools.has(id);
		tools.setCall(id, name, args);
		if (isNew) tools.setProvisional(id, true);
	}

	function appendUserMessage(text, opts = {}) {
		const el = document.createElement("div");
		el.className = "user-msg";
		renderUserText(el, text);

		const insertBeforeEl = opts.insertBefore instanceof HTMLElement ? opts.insertBefore : null;
		if (insertBeforeEl && insertBeforeEl.parentNode === msgsEl) {
			msgsEl.insertBefore(el, insertBeforeEl);
		} else {
			mount(el);
		}
		scheduleFrame();
		return el;
	}

	function userMessageKey(msg, text) {
		const ts = msg && typeof msg.timestamp === "number" ? msg.timestamp : null;
		if (ts !== null) return `u:${ts}:${text}`;
		return `u:${text}`;
	}

	/** Live user messages show on message_start and are confirmed by their message_end. */
	function maybeAppendUserMessage(msg) {
		if (!msg || typeof msg !== "object") return null;
		const text = extractTextContent(msg.content);
		if (!text) return null;

		const key = userMessageKey(msg, text);
		const existing = msgsEl.querySelector(`.user-msg[data-provisional][data-user-key="${CSS.escape(key)}"]`);
		if (existing || appendedUserMessageKeys.has(key)) return existing;
		appendedUserMessageKeys.add(key);
		if (appendedUserMessageKeys.size > 200) appendedUserMessageKeys.clear();

		const assistant = currentAssistant;
		const assistantIsEmpty = Boolean(assistant && assistant.rawText === "" && assistant.rawThinking === "");
		const insertBeforeEl = assistantIsEmpty && assistant.block ? assistant.block : null;
		const el = appendUserMessage(text, { insertBefore: insertBeforeEl });
		markProvisional(el);
		el.dataset.userKey = key;
		return el;
	}

	function appendNotice(text, kind = "info") {
		const block = document.createElement("div");
		block.className = "assistant-block";
		const el = document.createElement("div");
		el.className = `notice-text ${kind}`;
		el.textContent = text;
		block.appendChild(el);
		mount(block);
		scheduleFrame();
		return block;
	}

	function formatTokenCount(n) {
		const num = Number(n || 0);
		return Number.isFinite(num) && num > 0 ? Math.round(num).toLocaleString() : "0";
	}

	function appendCompactionSummary(message) {
		if (!message || typeof message !== "object") return null;
		const tokensBefore = typeof message.tokensBefore === "number" ? message.tokensBefore : 0;
		const relay = relayResetView(message);
		if (relay) {
			const line = relay.note || (relay.goal ? `goal: ${relay.goal}` : "no note");
			return appendSummaryCard(message, { kind: "relay", label: relay.title, line: `${line} `, key: tokensBefore });
		}
		return appendSummaryCard(message, {
			kind: "compaction",
			label: "[compaction]",
			line: `Compacted from ${formatTokenCount(tokensBefore)} tokens `,
			key: tokensBefore,
		});
	}

	function appendBranchSummary(message) {
		if (!message || typeof message !== "object") return;
		appendSummaryCard(message, { kind: "branch", label: "[branch summary]", line: "Summary of the abandoned branch ", key: message.fromId || "" });
	}

	function appendSummaryCard(message, { kind, label: labelText, line: lineText, key: cardKey }) {
		const summary = typeof message.summary === "string" ? message.summary : "";
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
		const id = `${kind}:${timestamp}:${cardKey}:${summary.length}`;
		if (appendedCompactionIds.has(id)) return null;
		appendedCompactionIds.add(id);
		const expanded = expandedCompactionIds.has(id);

		const card = document.createElement("div");
		card.className = `compact-card ${kind}${expanded ? " expanded" : ""}`;
		card.dataset.compactionId = id;
		card.compactionSummary = summary;

		const label = document.createElement("div");
		label.className = "compact-label";
		label.textContent = labelText;

		const line = document.createElement("div");
		line.className = "compact-summary";
		line.appendChild(document.createTextNode(lineText));
		const expand = document.createElement("span");
		expand.className = "exp-key";
		expand.textContent = expanded ? "(tap to collapse)" : "(tap to expand)";
		line.appendChild(expand);

		card.appendChild(label);
		card.appendChild(line);

		if (expanded) {
			const body = document.createElement("div");
			body.className = "compact-expanded";
			body.textContent = summary;
			card.appendChild(body);
		}

		card.addEventListener("click", () => {
			if (expandedCompactionIds.has(id)) {
				expandedCompactionIds.delete(id);
			} else {
				expandedCompactionIds.add(id);
			}
			renderAllCompactions();
			scheduleFrame();
		});

		mount(card);
		scheduleFrame();
		return card;
	}

	function renderAllCompactions() {
		const cards = [...msgsEl.querySelectorAll(".compact-card")];
		for (const card of cards) {
			const id = card.dataset.compactionId;
			const body = card.querySelector(".compact-expanded");
			const key = card.querySelector(".exp-key");
			const expanded = id && expandedCompactionIds.has(id);
			card.classList.toggle("expanded", Boolean(expanded));
			if (key) key.textContent = expanded ? "(tap to collapse)" : "(tap to expand)";
			if (expanded && !body) {
				const nextBody = document.createElement("div");
				nextBody.className = "compact-expanded";
				nextBody.textContent = card.compactionSummary || "";
				card.appendChild(nextBody);
			} else if (!expanded && body) {
				body.remove();
			}
		}
	}

	const tools = createToolBoxManager({ mount, onContentChange: scheduleFrame });

	/** Partial results still waiting for their frame must not paint over the abort. */
	function abortPendingTools(message) {
		pendingToolOutput.clear();
		tools.markPendingToolsAborted(message);
	}

	function stopReasonNotice(message) {
		if (message.stopReason === "aborted") return "Operation aborted";
		if (message.stopReason !== "error") return null;
		return typeof message.errorMessage === "string" && message.errorMessage.trim() ? `Error: ${message.errorMessage.trim()}` : "Error";
	}

	/**
	 * pi starts a turn before the messages it brings in (a steered msg, one that wakes the session), so a message
	 * that lands while the turn's assistant block is still empty goes above it, like a user message: the answer
	 * streams in below what it answers.
	 * @param {HTMLElement | null} el
	 */
	function aheadOfEmptyAssistant(el) {
		const assistant = currentAssistant;
		if (!el || !assistant || assistant.rawText !== "" || assistant.rawThinking !== "") return el;
		if (assistant.block.parentNode === msgsEl && el.parentNode === msgsEl) msgsEl.insertBefore(el, assistant.block);
		return el;
	}

	/** msg's and relay's own drawing, or null to fall back to the generic notice (whatever shape they arrive in). */
	function appendKnownCustomMessage(message) {
		try {
			if (message.customType === "msg") {
				const view = msgView(message);
				return view ? appendMsgMessage(view) : null;
			}
			if (message.customType === "relay") {
				const view = relayView(message);
				return view ? appendRelayNotice(view) : null;
			}
		} catch (error) {
			console.error(`Couldn't draw a ${String(message.customType)} message`, error);
		}
		return null;
	}

	/** Extension messages: msg's as messages from another session, relay's as one-line notices, others as a notice. */
	function appendCustomMessage(message) {
		const known = appendKnownCustomMessage(message);
		if (known) return known;
		const text = extractTextContent(message.content);
		if (!text) return null;
		const type = typeof message.customType === "string" && message.customType ? `[${message.customType}] ` : "";
		return appendNotice(`${type}${text}`, "custom");
	}

	/** @param {SessionRef} sender */
	function senderLink(sender) {
		const title = [sender.id, sender.cwd].filter(Boolean).join(" \u00b7 ");
		if (!onOpenSession || !sender.id) {
			const el = span("msg-from", sender.label);
			if (title) el.title = title;
			return el;
		}
		const button = document.createElement("button");
		button.type = "button";
		button.className = "msg-from";
		button.textContent = sender.label;
		button.title = `open ${title}`;
		button.addEventListener("click", () => onOpenSession({ ...sender }));
		return button;
	}

	/** @param {import("./custom_messages.js").MsgView} view */
	function appendMsgMessage(view) {
		const card = document.createElement("div");
		const kindClass = msgKindClass(view);
		card.className = "msg-card";
		if (kindClass) card.classList.add(kindClass);
		if (view.byUser) card.classList.add("by-user");

		const head = document.createElement("div");
		head.className = "msg-head";
		head.appendChild(span("msg-icon", "\u2709 "));
		if (view.byUser) head.appendChild(span("msg-you", "you, via "));
		head.appendChild(senderLink(view.sender));
		if (view.kindLabel) head.appendChild(span(`msg-tag${kindClass ? ` ${kindClass}` : ""}`, view.kindLabel));
		if (view.replyTo) head.appendChild(span("msg-re", `re ${view.replyTo}`));

		const body = document.createElement("div");
		body.className = "msg-body md";
		renderMarkdown(body, view.text);

		card.appendChild(head);
		card.appendChild(body);
		mount(card);
		scheduleFrame();
		return card;
	}

	/** @param {import("./custom_messages.js").RelayView} view */
	function appendRelayNotice(view) {
		const note = document.createElement("div");
		note.className = "relay-note";
		const line = document.createElement("div");
		line.className = "relay-line";
		line.appendChild(span("relay-label", view.label));
		for (const part of view.meta) line.appendChild(span("relay-meta", ` \u00b7 ${part}`));
		if (view.summary) line.appendChild(span("relay-summary", ` \u00b7 ${view.summary}`));
		note.appendChild(line);
		if (view.full) {
			const full = document.createElement("div");
			full.className = "relay-full";
			full.textContent = view.full;
			full.hidden = true;
			note.appendChild(full);
			note.classList.add("has-more");
			note.addEventListener("click", () => {
				full.hidden = !full.hidden;
				note.classList.toggle("open", !full.hidden);
				scheduleFrame();
			});
		}
		mount(note);
		scheduleFrame();
		return note;
	}

	function appendBashExecution(message, index) {
		const id = `bash:${typeof message.timestamp === "number" ? message.timestamp : index}`;
		const failed = message.cancelled || (typeof message.exitCode === "number" && message.exitCode !== 0);
		tools.setCall(id, "bash", { command: typeof message.command === "string" ? message.command : "" });
		tools.setStatus(id, failed ? "error" : "success");
		const output = typeof message.output === "string" ? message.output : "";
		tools.setText(id, "bash", message.cancelled ? `${output}\n(cancelled)`.trim() : output);
	}

	/**
	 * Draws persisted messages, skipping entries already on screen so resyncs can overlap safely. Every
	 * node gets its entry's id, so a windowed view can drop whole entries from the top.
	 * @returns {string[]} the entries drawn, in order
	 */
	function renderMessages(messages) {
		const seen = new Set(renderedEntryIds);
		const drawn = [];
		try {
			for (const [index, m] of orderMessagesForDisplay(messages).entries()) {
				if (!m || typeof m !== "object") continue;
				const entryId = typeof m.entryId === "string" ? m.entryId : null;
				if (entryId) {
					if (seen.has(entryId)) continue;
					seen.add(entryId);
					renderedEntryIds.add(entryId);
					if (!drawn.includes(entryId)) drawn.push(entryId);
				}
				mountEntryId = entryId;
				renderMessage(m, index);
			}
		} finally {
			mountEntryId = null;
		}
		return drawn;
	}

	function renderHistory(messages) {
		const drawn = renderMessages(messages);
		entryOrder.push(...drawn);
		if (drawn.length > 0 && Number.isFinite(windowMax)) {
			trimPending = true;
			scheduleFrame();
		}
	}

	function renderAssistantHistory(m) {
		const block = appendAssistantBlock();
		const parsed = parseAssistantContent(m.content);
		if (parsed.thinking) {
			block.thinking.style.display = "";
			block.thinking.classList.add("shown");
			block.thinking.textContent = parsed.thinking;
			block.rawThinking = parsed.thinking;
		}
		if (parsed.text) {
			block.rawText = parsed.text;
			renderMarkdown(block.text, parsed.text);
		}
		const notice = stopReasonNotice(m);
		if (notice) {
			const err = document.createElement("div");
			err.className = "notice-text error";
			err.textContent = notice;
			block.block.appendChild(err);
		}
		for (const call of parsed.toolCalls) {
			tools.setCall(call.id, call.name, call.arguments);
		}
		currentAssistant = null;
	}

	function renderToolResultHistory(m) {
		const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : safeRandomUUID();
		const toolName = typeof m.toolName === "string" ? m.toolName : "tool";
		const isError = Boolean(m.isError);
		const contentText = extractTextContent(m.content);
		if (!tools.has(toolCallId)) {
			tools.ensure(toolCallId, toolName, isError ? "error" : "success");
		}
		tools.setStatus(toolCallId, isError ? "error" : "success");
		const outcome = peerToolOutcome(toolName, { content: m.content, details: m.details }, { isError });
		tools.setText(toolCallId, toolName, outcome ?? (contentText || safeStringify(m.content)));
		tools.setImages(toolCallId, imageBlocks(m.content));
		for (const call of Array.isArray(m.nestedCalls?.calls) ? m.nestedCalls.calls : []) {
			tools.setNested(toolCallId, {
				id: call.id,
				name: call.name,
				args: call.arguments ?? {},
				status: call.status === "ok" ? "success" : call.status === "error" ? "error" : "pending",
				durationMs: call.durationMs,
				error: call.error,
			});
		}
	}

	function renderMessage(m, index) {
		switch (m.role) {
			case "user": {
				const text = extractTextContent(m.content);
				if (text) appendUserMessage(text);
				return;
			}
			case "assistant":
				renderAssistantHistory(m);
				return;
			case "compactionSummary":
				appendCompactionSummary(m);
				return;
			case "branchSummary":
				appendBranchSummary(m);
				return;
			case "custom":
				appendCustomMessage(m);
				return;
			case "bashExecution":
				appendBashExecution(m, index);
				return;
			case "toolResult":
				renderToolResultHistory(m);
				return;
		}
	}

	function prependHistory(messages, { hasOlder = false } = {}) {
		const fragment = document.createDocumentFragment();
		const liveAssistant = currentAssistant;
		mountTarget = fragment;
		try {
			entryOrder = [...renderMessages(messages), ...entryOrder];
		} finally {
			mountTarget = null;
			currentAssistant = liveAssistant;
		}
		const top = msgsEl.scrollTop;
		const height = msgsEl.scrollHeight;
		if (!hasOlder && olderControl) {
			olderControl.remove();
			olderControl = null;
		}
		const firstContent = olderControl && olderControl.parentNode === msgsEl ? olderControl.nextSibling : msgsEl.firstChild;
		msgsEl.insertBefore(fragment, firstContent);
		if (follower.isPinned()) {
			follower.sync();
		} else {
			follower.restore(top + (msgsEl.scrollHeight - height));
		}
	}

	function setOlderControl(state, onLoad) {
		if (state === "none") {
			if (olderControl) olderControl.remove();
			olderControl = null;
			return;
		}
		if (!olderControl || olderControl.parentNode !== msgsEl) {
			olderControl = document.createElement("button");
			olderControl.type = "button";
			olderControl.className = "load-older";
			olderControl.addEventListener("click", () => onLoad());
			msgsEl.insertBefore(olderControl, msgsEl.firstChild);
		}
		olderControl.disabled = state === "loading";
		olderControl.textContent =
			state === "loading" ? "loading earlier messages…" : state === "error" ? "couldn't load earlier messages, tap to retry" : "↑ earlier messages";
	}

	function isNearTop(thresholdPx = 400) {
		return msgsEl.scrollTop <= thresholdPx;
	}

	/** Removes what live events drew but no entry confirmed, before a resync redraws it from the server. */
	function dropProvisional() {
		for (const el of msgsEl.querySelectorAll("[data-provisional]")) {
			if (el.dataset.userKey) appendedUserMessageKeys.delete(el.dataset.userKey);
			el.remove();
		}
		tools.prune();
		for (const block of streamingBlocks) {
			if (!block.block.isConnected) streamingBlocks.delete(block);
		}
		if (currentAssistant && !currentAssistant.block.isConnected) currentAssistant = null;
	}

	/** Draws the in-flight part of a run: running tools, then the assistant message still streaming. */
	function renderLive(live) {
		if (!live || typeof live !== "object") return;
		for (const tool of Array.isArray(live.tools) ? live.tools : []) {
			if (!tool || typeof tool.toolCallId !== "string") continue;
			for (const event of toolEventsFromLive(tool)) handleAgentEvent(event);
		}
		const message = live.streamingMessage;
		if (!message || message.role !== "assistant") return;
		const block = ensureLiveAssistantBlock();
		const parsed = parseAssistantContent(message.content);
		block.rawThinking = parsed.thinking;
		block.rawText = parsed.text;
		markStreaming(block);
		for (const call of parsed.toolCalls) setLiveToolCall(call.id, call.name, call.arguments);
	}

	function confirmAssistant(block, message, entryId) {
		if (block) confirmNode(block.block, entryId);
		for (const call of parseAssistantContent(message.content).toolCalls) tools.confirm(call.id, entryId);
		noteEntry(entryId);
	}

	/** The session stopped while this pane watched it: the transcript goes and one line says so. @param {string} text */
	function renderReleased(text) {
		clear();

		const block = document.createElement("div");
		block.className = "assistant-block";
		const t = document.createElement("div");
		t.className = "thinking-text";
		t.textContent = text;
		block.appendChild(t);

		mount(block);
		follower.pin();
	}

	function handleAgentEvent(event, entryId) {
		if (!event || typeof event.type !== "string") return;

		if (event.type === "turn_start") {
			ensureLiveAssistantBlock();
			return;
		}

		if (event.type === "agent_end" || event.type === "agent_settled") {
			currentAssistant = null;
			return;
		}

		// pi's turn boundaries append entries (relay's notices and resets) with no message events: draw them the way
		// history does, under their entry id, so a resync that brings the same entry skips it
		if (event.type === "entry_appended") {
			const message = entryMessage(event.entry);
			if (message) renderHistory([message]);
			return;
		}

		if (event.type === "message_start") {
			if (event.message && event.message.role === "user") {
				maybeAppendUserMessage(event.message);
				return;
			}
			if (event.message && event.message.role === "assistant") {
				ensureLiveAssistantBlock();
			}
			return;
		}

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (!update || typeof update.type !== "string") return;

			if (update.type === "toolcall_start") {
				if (typeof update.id === "string" && update.id && typeof update.toolName === "string" && update.toolName) {
					setLiveToolCall(update.id, update.toolName, {});
				}
				return;
			}
			if (update.type === "toolcall_end") {
				const call = update.toolCall;
				if (call && typeof call.id === "string" && typeof call.name === "string") {
					setLiveToolCall(call.id, call.name, call.arguments);
				}
				return;
			}
			if (typeof update.delta !== "string") return;
			if (update.type === "thinking_delta" || update.type === "reasoning_delta") {
				const block = ensureLiveAssistantBlock();
				block.rawThinking += update.delta;
				markStreaming(block);
			} else if (update.type === "text_delta") {
				const block = ensureLiveAssistantBlock();
				block.rawText += update.delta;
				markStreaming(block);
			}
			return;
		}

		if (event.type === "message_end") {
			const msg = event.message;
			if (!msg) return;
			if (entryId && renderedEntryIds.has(entryId)) {
				if (msg.role === "assistant") currentAssistant = null;
				return;
			}
			if (msg.role === "user") {
				const el = maybeAppendUserMessage(msg);
				if (entryId) {
					confirmNode(el, entryId);
					noteEntry(entryId);
				}
				return;
			}
			if (msg.role === "custom") {
				if (msg.display !== false) confirmNode(aheadOfEmptyAssistant(appendCustomMessage(msg)), entryId);
				noteEntry(entryId);
				return;
			}
			if (msg.role === "toolResult") {
				noteEntry(entryId);
				return;
			}
			if (msg.role === "assistant") {
				const final = parseAssistantContent(msg.content);
				const block = currentAssistant || (final.text || final.thinking ? appendAssistantBlock() : null);
				if (block) {
					finalizeStreaming(block);
					block.rawText = final.text || block.rawText;
					block.rawThinking = final.thinking || block.rawThinking;
					if (block.rawThinking) {
						block.thinking.style.display = "";
						block.thinking.classList.add("shown");
						block.thinking.textContent = block.rawThinking;
					}
					renderMarkdown(block.text, block.rawText);
					scheduleFrame();
				}

				const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
				if (stopReason === "aborted" || stopReason === "error") {
					const content = Array.isArray(msg.content) ? msg.content : [];
					const hasToolCalls = content.some((c) => c && typeof c === "object" && c.type === "toolCall");

					const abortMessage = "Operation aborted";
					const errMessage =
						stopReason === "aborted"
							? abortMessage
							: typeof msg.errorMessage === "string" && msg.errorMessage.trim()
								? `Error: ${msg.errorMessage.trim()}`
								: "Error";

					if (hasToolCalls) {
						abortPendingTools(stopReason === "aborted" ? abortMessage : errMessage);
					} else if (block) {
						const err = document.createElement("div");
						err.className = "notice-text error";
						err.textContent = stopReason === "aborted" ? abortMessage : errMessage;
						block.block.appendChild(err);
					} else {
						appendNotice(stopReason === "aborted" ? abortMessage : errMessage, "error");
					}
				}
				if (entryId) confirmAssistant(block, msg, entryId);
				currentAssistant = null;
			}
			return;
		}

		if (typeof event.parentToolCallId === "string" && event.type.startsWith("tool_execution_")) {
			if (event.type === "tool_execution_update") return;
			const status = event.type === "tool_execution_start" ? "pending" : event.isError ? "error" : "success";
			const nested = { id: event.toolCallId, name: event.toolName, status, durationMs: event.durationMs };
			if (event.type === "tool_execution_start") nested.args = event.args;
			if (tools.setNested(event.parentToolCallId, nested)) return;
		}

		if (event.type === "tool_execution_start") {
			pendingToolOutput.delete(event.toolCallId);
			if (tools.has(event.toolCallId)) {
				tools.setStatus(event.toolCallId, "pending");
			} else {
				tools.ensure(event.toolCallId, event.toolName, "pending");
			}
			tools.setCall(event.toolCallId, event.toolName, event.args);
			tools.setText(event.toolCallId, event.toolName, "");
			return;
		}

		if (event.type === "tool_execution_update") {
			if (!tools.has(event.toolCallId)) return;
			pendingToolOutput.set(event.toolCallId, { toolName: event.toolName, result: event.partialResult });
			scheduleFrame();
			return;
		}

		if (event.type === "tool_execution_end") {
			pendingToolOutput.delete(event.toolCallId);
			if (!tools.has(event.toolCallId)) {
				tools.ensure(event.toolCallId, event.toolName, event.isError ? "error" : "success");
			}
			tools.setStatus(event.toolCallId, event.isError ? "error" : "success");
			tools.setText(event.toolCallId, event.toolName, toolOutputText(event.toolName, event.result, { isError: Boolean(event.isError) }));
			tools.setDuration(event.toolCallId, event.durationMs);
			tools.setImages(event.toolCallId, imageBlocks(event.result?.content));
			return;
		}
	}

	return {
		clear,
		flush,
		pin: follower.pin,
		restoreScroll: follower.restore,
		isPinned: follower.isPinned,
		getScrollTop: follower.getScrollTop,
		appendNotice,
		appendCompactionSummary: (message, entryId) => {
			if (entryId && renderedEntryIds.has(entryId)) return;
			confirmNode(appendCompactionSummary(message), entryId);
			noteEntry(entryId);
		},
		setWindow,
		entryCount: () => entryIdsInOrder(msgsEl.children).length,
		dropProvisional,
		renderLive,
		prependHistory,
		setOlderControl,
		isNearTop,
		renderQueuedMessages,
		renderHistory,
		renderReleased,
		handleAgentEvent,
		hasPendingTools: tools.hasPendingTools,
		hasAssistant: () => Boolean(currentAssistant),
		markPendingToolsAborted: abortPendingTools,
	};
}
