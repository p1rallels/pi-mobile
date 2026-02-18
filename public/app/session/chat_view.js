import { safeRandomUUID } from "../core/uuid.js";
import { safeStringify } from "../core/stringify.js";
import { toolResultToText } from "../core/tool_format.js";
import { renderMarkdown } from "../render/markdown.js";
import { extractTextContent, parseAssistantContent } from "./content.js";
import { createToolBoxManager } from "./tool_boxes.js";

export function createChatView({ msgsEl, isPhoneLikeFn }) {
	let currentAssistant = null; // { block, text, thinking, rawText, rawThinking }
	let appendedUserMessageKeys = new Set();

	function scrollToBottom() {
		msgsEl.scrollTop = msgsEl.scrollHeight;
	}

	function isNearBottom(el, thresholdPx = 80) {
		const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
		return remaining <= thresholdPx;
	}

	function clear() {
		msgsEl.innerHTML = "";
		currentAssistant = null;
		tools.clear();
		appendedUserMessageKeys = new Set();
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

		currentAssistant = { block, text, thinking, rawText: "", rawThinking: "" };
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
		scrollToBottom();
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
		scrollToBottom();
	}

	const tools = createToolBoxManager({ msgsEl, scrollToBottom });

	function renderHistory(messages) {
		for (const m of messages) {
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
		scrollToBottom();
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

			const block = ensureAssistantBlock();
			if ((update.type === "thinking_delta" || update.type === "reasoning_delta") && typeof update.delta === "string") {
				block.rawThinking += update.delta;
				block.thinking.style.display = "";
				block.thinking.classList.add("shown");
				block.thinking.textContent = block.rawThinking;
			} else if (update.type === "text_delta" && typeof update.delta === "string") {
				block.rawText += update.delta;
				block.text.textContent = block.rawText;
			} else {
				return;
			}
			scrollToBottom();
			return;
		}

		if (event.type === "message_end") {
			const msg = event.message;
			if (!msg) return;
			if (msg.role === "user") maybeAppendUserMessage(msg);
			if (msg.role === "assistant") {
				const block = currentAssistant;
				if (block) {
					renderMarkdown(block.text, block.rawText);
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
			const stick = isPhoneLikeFn() && isNearBottom(msgsEl);
			tools.setText(event.toolCallId, event.toolName, toolResultToText(event.partialResult));
			if (stick) scrollToBottom();
			return;
		}

		if (event.type === "tool_execution_end") {
			const stick = isPhoneLikeFn() && isNearBottom(msgsEl);
			if (!tools.has(event.toolCallId)) {
				tools.ensure(event.toolCallId, event.toolName, event.isError ? "error" : "success");
			}
			tools.setStatus(event.toolCallId, event.isError ? "error" : "success");
			tools.setText(event.toolCallId, event.toolName, toolResultToText(event.result));
			if (stick) scrollToBottom();
			return;
		}
	}

	return {
		clear,
		scrollToBottom,
		appendNotice,
		renderHistory,
		renderReleased,
		handleAgentEvent,
		hasPendingTools: tools.hasPendingTools,
		hasAssistant: () => Boolean(currentAssistant),
		markPendingToolsAborted: tools.markPendingToolsAborted,
	};
}
