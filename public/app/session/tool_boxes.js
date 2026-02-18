import { toolCallToText, toolPreviewLines } from "../core/tool_format.js";

export function createToolBoxManager({ msgsEl, scrollToBottom }) {
	let toolBoxes = new Map(); // toolCallId -> { box, call, out, toolName, previewLines, expanded, callText, fullText }

	function clear() {
		toolBoxes = new Map();
	}

	function appendToolBox(toolCallId, toolName, status) {
		const box = document.createElement("div");
		box.className = `tool-box ${status}`;
		box.dataset.toolCallId = toolCallId;

		const call = document.createElement("div");
		call.className = "tool-call";
		call.textContent = "";

		const out = document.createElement("div");
		out.className = "tool-out";
		out.textContent = "";

		box.appendChild(call);
		box.appendChild(out);
		msgsEl.appendChild(box);

		const entry = {
			box,
			call,
			out,
			toolName,
			previewLines: toolPreviewLines(toolName),
			expanded: false,
			callText: "",
			fullText: "",
		};
		toolBoxes.set(toolCallId, entry);
		scrollToBottom();
		return entry;
	}

	function ensure(toolCallId, toolName, status = "pending") {
		return toolBoxes.get(toolCallId) || appendToolBox(toolCallId, toolName, status);
	}

	function renderToolBoxText(toolCallId) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;

		const text = String(entry.fullText ?? "");
		const lines = text.split("\n");
		const truncated = lines.length > entry.previewLines;

		entry.out.innerHTML = "";
		if (!truncated) {
			entry.out.textContent = text;
			return;
		}

		const isBash = entry.toolName === "bash";
		const remaining = Math.max(0, lines.length - entry.previewLines);
		const preview = isBash ? lines.slice(-entry.previewLines).join("\n") : lines.slice(0, entry.previewLines).join("\n");

		const trunc = document.createElement("div");
		trunc.className = "tool-trunc";

		if (!entry.expanded) {
			const label = isBash ? `${remaining} earlier lines` : `${remaining} more lines`;
			trunc.appendChild(document.createTextNode(`... (${label}, `));

			const key = document.createElement("span");
			key.className = "exp-key";
			key.textContent = "click";
			key.addEventListener("click", () => {
				entry.expanded = true;
				renderToolBoxText(toolCallId);
			});
			trunc.appendChild(key);

			const desc = document.createElement("span");
			desc.className = "exp-desc";
			desc.textContent = " to expand";
			trunc.appendChild(desc);
			trunc.appendChild(document.createTextNode(")"));

			if (isBash) entry.out.appendChild(trunc);

			const previewEl = document.createElement("div");
			previewEl.textContent = preview;
			entry.out.appendChild(previewEl);

			if (!isBash) entry.out.appendChild(trunc);
			return;
		}

		const full = document.createElement("div");
		full.textContent = text;
		entry.out.appendChild(full);

		const key = document.createElement("span");
		key.className = "exp-key";
		key.textContent = "click";
		key.addEventListener("click", () => {
			entry.expanded = false;
			renderToolBoxText(toolCallId);
		});

		trunc.appendChild(document.createTextNode("... ("));
		trunc.appendChild(key);

		const desc = document.createElement("span");
		desc.className = "exp-desc";
		desc.textContent = " to collapse";
		trunc.appendChild(desc);
		trunc.appendChild(document.createTextNode(")"));
		entry.out.appendChild(trunc);
	}

	function setCall(toolCallId, toolName, args) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
		entry.callText = toolCallToText(toolName, args);
		entry.call.textContent = entry.callText;
	}

	function setText(toolCallId, toolName, text) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
		entry.fullText = String(text ?? "");
		renderToolBoxText(toolCallId);
	}

	function setStatus(toolCallId, status) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		entry.box.classList.remove("pending", "success", "error");
		entry.box.classList.add(status);
	}

	function hasPendingTools() {
		for (const entry of toolBoxes.values()) {
			if (entry.box.classList.contains("pending")) return true;
		}
		return false;
	}

	function markPendingToolsAborted(message) {
		for (const [toolCallId, entry] of toolBoxes.entries()) {
			if (!entry.box.classList.contains("pending")) continue;
			setStatus(toolCallId, "error");
			setText(toolCallId, entry.toolName, message);
		}
	}

	return {
		clear,
		ensure,
		has: (toolCallId) => toolBoxes.has(toolCallId),
		setCall,
		setText,
		setStatus,
		hasPendingTools,
		markPendingToolsAborted,
	};
}

