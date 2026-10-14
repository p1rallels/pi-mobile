import { safeRandomUUID } from "../core/uuid.js";
import { safeStringify } from "../core/stringify.js";
import { toolResultToText } from "../core/tool_format.js";
import { renderMarkdown } from "../render/markdown.js";
import { extractTextContent, parseAssistantContent } from "./content.js";
import { createScrollFollower } from "./scroll_follow.js";
import { createToolBoxManager } from "./tool_boxes.js";

function messageTimestamp(message) {
	return message && typeof message.timestamp === "number" ? message.timestamp : null;
}

export function orderMessagesForDisplay(messages) {
	if (!Array.isArray(messages)) return [];
	const indexed = messages.map((message, index) => ({ message, index }));
	const compactions = indexed.filter(({ message }) => message && typeof message === "object" && message.role === "compactionSummary");
	if (compactions.length === 0) return messages;

	const ordered = indexed.filter(({ message }) => !message || typeof message !== "object" || message.role !== "compactionSummary").map(({ message }) => message);
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

export function createChatView({ msgsEl, queuedEl, pillEl = null }) {
	let currentAssistant = null; // { block, text, thinking, rawText, rawThinking, shownText, shownThinking }
	let appendedUserMessageKeys = new Set();
	let expandedCompactionIds = new Set();
	let appendedCompactionIds = new Set();
	const streamingBlocks = new Set();
	let frameRequested = false;

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

	function flush() {
		frameRequested = false;
		for (const block of streamingBlocks) writeStreamingBlock(block);
		streamingBlocks.clear();
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

	function clear() {
		msgsEl.innerHTML = "";
		currentAssistant = null;
		streamingBlocks.clear();
		tools.clear();
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

	function appendAssistantBlock() {
		const block = document.createElement("div");
		block.className = "assistant-block";

		const thinking = document.createElement("div");
		thinking.className = "thinking-text";
		thinking.style.display = "none";

		const text = document.createElement("div");
		text.className = "md";
		text.textContent = "";

		block.appendChild(thinking);
		block.appendChild(text);
		msgsEl.appendChild(block);

		currentAssistant = { block, text, thinking, rawText: "", rawThinking: "", shownText: 0, shownThinking: 0 };
		return currentAssistant;
	}

	function ensureAssistantBlock() {
		return currentAssistant || appendAssistantBlock();
	}

	function appendUserMessage(text, opts = {}) {
		const el = document.createElement("div");
		el.className = "user-msg";
		el.textContent = text;

		const insertBeforeEl = opts.insertBefore instanceof HTMLElement ? opts.insertBefore : null;
		if (insertBeforeEl && insertBeforeEl.parentNode === msgsEl) {
			msgsEl.insertBefore(el, insertBeforeEl);
		} else {
			msgsEl.appendChild(el);
		}
		scheduleFrame();
	}

	function userMessageKey(msg, text) {
		const ts = msg && typeof msg.timestamp === "number" ? msg.timestamp : null;
		if (ts !== null) return `u:${ts}:${text}`;
		return `u:${text}`;
	}

	function maybeAppendUserMessage(msg) {
		if (!msg || typeof msg !== "object") return;
		const text = extractTextContent(msg.content);
		if (!text) return;

		const key = userMessageKey(msg, text);
		if (appendedUserMessageKeys.has(key)) return;
		appendedUserMessageKeys.add(key);
		if (appendedUserMessageKeys.size > 200) appendedUserMessageKeys.clear();

		const assistant = currentAssistant;
		const assistantIsEmpty = Boolean(assistant && assistant.rawText === "" && assistant.rawThinking === "");
		const insertBeforeEl = assistantIsEmpty && assistant.block ? assistant.block : null;
		appendUserMessage(text, { insertBefore: insertBeforeEl });
	}

	function appendNotice(text, kind = "info") {
		const block = document.createElement("div");
		block.className = "assistant-block";
		const el = document.createElement("div");
		el.className = `notice-text ${kind}`;
		el.textContent = text;
		block.appendChild(el);
		msgsEl.appendChild(block);
		scheduleFrame();
	}

	function formatTokenCount(n) {
		const num = Number(n || 0);
		return Number.isFinite(num) && num > 0 ? Math.round(num).toLocaleString() : "0";
	}

	function appendCompactionSummary(message) {
		if (!message || typeof message !== "object") return;
		const summary = typeof message.summary === "string" ? message.summary : "";
		const tokensBefore = typeof message.tokensBefore === "number" ? message.tokensBefore : 0;
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
		const id = `compaction:${timestamp}:${tokensBefore}:${summary.length}`;
		if (appendedCompactionIds.has(id)) return;
		appendedCompactionIds.add(id);
		const expanded = expandedCompactionIds.has(id);

		const card = document.createElement("div");
		card.className = `compact-card${expanded ? " expanded" : ""}`;
		card.dataset.compactionId = id;
		card.compactionSummary = summary;

		const label = document.createElement("div");
		label.className = "compact-label";
		label.textContent = "[compaction]";

		const line = document.createElement("div");
		line.className = "compact-summary";
		line.appendChild(document.createTextNode(`Compacted from ${formatTokenCount(tokensBefore)} tokens `));
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

		msgsEl.appendChild(card);
		scheduleFrame();
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

	const tools = createToolBoxManager({ msgsEl, onContentChange: scheduleFrame });

	function renderHistory(messages) {
		for (const m of orderMessagesForDisplay(messages)) {
			if (!m || typeof m !== "object") continue;
			if (m.role === "user") {
				const text = extractTextContent(m.content);
				if (text) appendUserMessage(text);
			} else if (m.role === "assistant") {
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
				for (const call of parsed.toolCalls) {
					tools.setCall(call.id, call.name, call.arguments);
				}
				currentAssistant = null;
			} else if (m.role === "compactionSummary") {
				appendCompactionSummary(m);
			} else if (m.role === "toolResult") {
				const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : safeRandomUUID();
				const toolName = typeof m.toolName === "string" ? m.toolName : "tool";
				const isError = Boolean(m.isError);
				const contentText = extractTextContent(m.content);
				if (!tools.has(toolCallId)) {
					tools.ensure(toolCallId, toolName, isError ? "error" : "success");
				}
				tools.setStatus(toolCallId, isError ? "error" : "success");
				tools.setText(toolCallId, toolName, contentText || safeStringify(m.content));
			}
		}
	}

	function renderReleased({ cliCommand }) {
		clear();

		const block = document.createElement("div");
		block.className = "assistant-block";
		const t = document.createElement("div");
		t.className = "thinking-text";
		t.textContent = "Released. Safe to resume in native CLI.";
		block.appendChild(t);

		if (cliCommand) {
			const cmdBox = document.createElement("div");
			cmdBox.className = "tool-box success";
			const title = document.createElement("div");
			title.className = "tool-title";
			title.textContent = "CLI resume:";
			const out = document.createElement("div");
			out.className = "tool-out";
			out.textContent = cliCommand;
			cmdBox.appendChild(title);
			cmdBox.appendChild(out);
			msgsEl.appendChild(cmdBox);
		}

		msgsEl.appendChild(block);
		follower.pin();
	}

	function handleAgentEvent(event) {
		if (!event || typeof event.type !== "string") return;

		if (event.type === "turn_start") {
			ensureAssistantBlock();
			return;
		}

		if (event.type === "agent_end") {
			currentAssistant = null;
			return;
		}

		if (event.type === "message_start") {
			if (event.message && event.message.role === "user") {
				maybeAppendUserMessage(event.message);
				return;
			}
			if (event.message && event.message.role === "assistant") {
				ensureAssistantBlock();
			}
			return;
		}

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (!update || typeof update.type !== "string") return;

			if (typeof update.delta !== "string") return;
			if (update.type === "thinking_delta" || update.type === "reasoning_delta") {
				const block = ensureAssistantBlock();
				block.rawThinking += update.delta;
				markStreaming(block);
			} else if (update.type === "text_delta") {
				const block = ensureAssistantBlock();
				block.rawText += update.delta;
				markStreaming(block);
			}
			return;
		}

		if (event.type === "message_end") {
			const msg = event.message;
			if (!msg) return;
			if (msg.role === "user") maybeAppendUserMessage(msg);
			if (msg.role === "assistant") {
				const block = currentAssistant;
				if (block) {
					finalizeStreaming(block);
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
						tools.markPendingToolsAborted(stopReason === "aborted" ? abortMessage : errMessage);
					} else if (block) {
						const err = document.createElement("div");
						err.className = "notice-text error";
						err.textContent = stopReason === "aborted" ? abortMessage : errMessage;
						block.block.appendChild(err);
					} else {
						appendNotice(stopReason === "aborted" ? abortMessage : errMessage, "error");
					}
				}
				currentAssistant = null;
			}
			return;
		}

		if (event.type === "tool_execution_start") {
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
			tools.setText(event.toolCallId, event.toolName, toolResultToText(event.partialResult));
			return;
		}

		if (event.type === "tool_execution_end") {
			if (!tools.has(event.toolCallId)) {
				tools.ensure(event.toolCallId, event.toolName, event.isError ? "error" : "success");
			}
			tools.setStatus(event.toolCallId, event.isError ? "error" : "success");
			tools.setText(event.toolCallId, event.toolName, toolResultToText(event.result));
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
		appendCompactionSummary,
		renderQueuedMessages,
		renderHistory,
		renderReleased,
		handleAgentEvent,
		hasPendingTools: tools.hasPendingTools,
		hasAssistant: () => Boolean(currentAssistant),
		markPendingToolsAborted: tools.markPendingToolsAborted,
	};
}
