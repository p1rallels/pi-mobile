import { formatDuration, toolCallToText, toolPreviewLines } from "../core/tool_format.js";

const NESTED_STATUS = { pending: "…", success: "✓", error: "✗" };

export function createToolBoxManager({ mount, onContentChange = () => {} }) {
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
		mount(box);

		const entry = {
			box,
			call,
			out,
			meta: null,
			nested: null,
			images: null,
			toolName,
			previewLines: toolPreviewLines(toolName),
			expanded: false,
			callText: "",
			fullText: "",
		};
		toolBoxes.set(toolCallId, entry);
		onContentChange();
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
		if (entry.meta) entry.call.appendChild(entry.meta);
		onContentChange();
	}

	function setDuration(toolCallId, durationMs) {
		const entry = toolBoxes.get(toolCallId);
		const text = formatDuration(durationMs);
		if (!entry || !text) return;
		if (!entry.meta) {
			entry.meta = document.createElement("span");
			entry.meta.className = "tool-meta";
		}
		entry.meta.textContent = ` · ${text}`;
		entry.call.appendChild(entry.meta);
	}

	/** Calls a tool made itself (codemode scripts, MCP helpers) as compact lines inside the caller's box. */
	function setNested(parentId, call) {
		const parent = toolBoxes.get(parentId);
		if (!parent) return false;
		if (!parent.nested) {
			parent.nested = { list: document.createElement("div"), rows: new Map() };
			parent.nested.list.className = "tool-nested";
			parent.box.insertBefore(parent.nested.list, parent.out);
		}
		let row = parent.nested.rows.get(call.id);
		if (!row) {
			row = document.createElement("div");
			row.className = "tool-nested-call";
			parent.nested.rows.set(call.id, row);
			parent.nested.list.appendChild(row);
		}
		if (call.args !== undefined || !row.dataset.callText) row.dataset.callText = toolCallToText(call.name, call.args ?? {});
		const status = call.status ?? "pending";
		const duration = formatDuration(call.durationMs);
		const error = call.error ? ` ${call.error}` : "";
		row.className = `tool-nested-call ${status}`;
		row.textContent = `↳ ${NESTED_STATUS[status] ?? ""} ${row.dataset.callText}${duration ? ` · ${duration}` : ""}${error}`;
		onContentChange();
		return true;
	}

	function setImages(toolCallId, images) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		if (entry.images) entry.images.remove();
		entry.images = null;
		const valid = (images || []).filter((image) => image && typeof image.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(image.mimeType));
		if (valid.length === 0) return;
		entry.images = document.createElement("div");
		entry.images.className = "tool-images";
		for (const image of valid) {
			const img = document.createElement("img");
			img.className = "tool-img";
			img.alt = image.mimeType;
			img.loading = "lazy";
			img.src = `data:${image.mimeType};base64,${image.data}`;
			entry.images.appendChild(img);
		}
		entry.box.appendChild(entry.images);
		onContentChange();
	}

	function setText(toolCallId, toolName, text) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
		entry.fullText = String(text ?? "");
		renderToolBoxText(toolCallId);
		onContentChange();
	}

	function setStatus(toolCallId, status) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		entry.box.classList.remove("pending", "success", "error");
		entry.box.classList.add(status);
	}

	/** Boxes created while a message streams go away with it if a resync replaces the unpersisted tail. */
	function setProvisional(toolCallId, provisional) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		if (provisional) entry.box.dataset.provisional = "1";
		else delete entry.box.dataset.provisional;
	}

	/** A live box whose assistant message was persisted: no longer provisional, and part of that entry. */
	function confirm(toolCallId, entryId) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		delete entry.box.dataset.provisional;
		if (entryId) entry.box.dataset.entryId = entryId;
	}

	function prune() {
		toolBoxes = new Map([...toolBoxes].filter(([, entry]) => entry.box.isConnected));
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
		prune,
		confirm,
		setProvisional,
		has: (toolCallId) => toolBoxes.has(toolCallId),
		setCall,
		setDuration,
		setNested,
		setImages,
		setText,
		setStatus,
		hasPendingTools,
		markPendingToolsAborted,
	};
}

