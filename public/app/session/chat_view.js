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

export function createChatView({ msgsEl, queuedEl, pillEl = null }) {
	let currentAssistant = null; // { block, text, thinking, rawText, rawThinking, shownText, shownThinking }
	let renderedEntryIds = new Set();
	let appendedUserMessageKeys = new Set();
	let expandedCompactionIds = new Set();
	let appendedCompactionIds = new Set();
	const streamingBlocks = new Set();
	let frameRequested = false;
	let mountTarget = null;
	let olderControl = null;

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

	function mount(el) {
		(mountTarget || msgsEl).appendChild(el);
	}

	function clear() {
		msgsEl.innerHTML = "";
		olderControl = null;
		currentAssistant = null;
		streamingBlocks.clear();
		tools.clear();
		renderedEntryIds = new Set();
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
	}

	function formatTokenCount(n) {
		const num = Number(n || 0);
		return Number.isFinite(num) && num > 0 ? Math.round(num).toLocaleString() : "0";
	}

	function appendCompactionSummary(message) {
		if (!message || typeof message !== "object") return;
		const tokensBefore = typeof message.tokensBefore === "number" ? message.tokensBefore : 0;
		appendSummaryCard(message, {
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
		if (appendedCompactionIds.has(id)) return;
		appendedCompactionIds.add(id);
		const expanded = expandedCompactionIds.has(id);

		const card = document.createElement("div");
		card.className = `compact-card${expanded ? " expanded" : ""}`;
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

	function stopReasonNotice(message) {
		if (message.stopReason === "aborted") return "Operation aborted";
		if (message.stopReason !== "error") return null;
		return typeof message.errorMessage === "string" && message.errorMessage.trim() ? `Error: ${message.errorMessage.trim()}` : "Error";
	}

	function appendCustomMessage(message) {
		const text = extractTextContent(message.content);
		if (!text) return;
		const type = typeof message.customType === "string" && message.customType ? `[${message.customType}] ` : "";
		appendNotice(`${type}${text}`, "custom");
	}

	function appendBashExecution(message, index) {
		const id = `bash:${typeof message.timestamp === "number" ? message.timestamp : index}`;
		const failed = message.cancelled || (typeof message.exitCode === "number" && message.exitCode !== 0);
		tools.setCall(id, "bash", { command: typeof message.command === "string" ? message.command : "" });
		tools.setStatus(id, failed ? "error" : "success");
		const output = typeof message.output === "string" ? message.output : "";
		tools.setText(id, "bash", message.cancelled ? `${output}\n(cancelled)`.trim() : output);
	}

	/** Renders persisted messages, skipping entries already on screen so resyncs can overlap safely. */
	function renderHistory(messages) {
		const seen = new Set(renderedEntryIds);
		for (const [index, m] of orderMessagesForDisplay(messages).entries()) {
			if (!m || typeof m !== "object") continue;
			if (typeof m.entryId === "string") {
				if (seen.has(m.entryId)) continue;
				renderedEntryIds.add(m.entryId);
			}
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
			} else if (m.role === "compactionSummary") {
				appendCompactionSummary(m);
			} else if (m.role === "branchSummary") {
				appendBranchSummary(m);
			} else if (m.role === "custom") {
				appendCustomMessage(m);
			} else if (m.role === "bashExecution") {
				appendBashExecution(m, index);
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
		}
	}

	function prependHistory(messages, { hasOlder = false } = {}) {
		const fragment = document.createDocumentFragment();
		const liveAssistant = currentAssistant;
		mountTarget = fragment;
		try {
			renderHistory(messages);
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
		for (const call of parseAssistantContent(message.content).toolCalls) tools.setProvisional(call.id, false);
		if (entryId) renderedEntryIds.add(entryId);
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
			mount(cmdBox);
		}

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
					renderedEntryIds.add(entryId);
				}
				return;
			}
			if (msg.role === "custom") {
				if (msg.display !== false) appendCustomMessage(msg);
				if (entryId) renderedEntryIds.add(entryId);
				return;
			}
			if (msg.role === "toolResult") {
				if (entryId) renderedEntryIds.add(entryId);
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
			if (entryId) renderedEntryIds.add(entryId);
			appendCompactionSummary(message);
		},
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
		markPendingToolsAborted: tools.markPendingToolsAborted,
	};
}
