// Markup for a session pane outside the phone shell (canvas tiles): the same classes as the .chat
// section of index.html, without ids (many panes share a page) and without the phone keybar.
// The title-bar controls (role, model, thinking, take over, release) belong to whoever hosts the
// pane and are merged into the refs by the caller.

const BORDER = "─".repeat(400);

/**
 * @param {Document} doc @param {string} tag @param {string} className
 * @param {{ text?: string, attrs?: Record<string, string>, children?: Node[] }} [init]
 */
function h(doc, tag, className, { text, attrs = {}, children = [] } = {}) {
	const el = doc.createElement(tag);
	el.className = className;
	if (text !== undefined) el.textContent = text;
	for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
	el.append(...children);
	return el;
}

/** @param {Document} doc */
export function buildPaneDom(doc) {
	const msgs = h(doc, "div", "msgs", {
		children: [h(doc, "div", "assistant-block", { children: [h(doc, "div", "thinking-text", { text: "No session selected." })] })],
	});
	const jumpLatest = h(doc, "button", "jump-latest", { text: "↓ latest", attrs: { type: "button", hidden: "" } });
	const queuedPanel = h(doc, "div", "queued-panel");
	const workingSpin = h(doc, "span", "work-spin", { text: "⠋", attrs: { "aria-hidden": "true" } });
	const workingText = h(doc, "span", "work-text", { text: "Working..." });
	const working = h(doc, "div", "working", { children: [workingSpin, workingText] });
	const extAbove = h(doc, "div", "ext-widgets", { attrs: { hidden: "" } });
	const input = /** @type {HTMLTextAreaElement} */ (h(doc, "textarea", "editor-input", { attrs: { rows: "1", placeholder: "" } }));
	const editor = h(doc, "div", "editor-wrap", {
		children: [h(doc, "div", "editor-border", { text: BORDER }), h(doc, "div", "editor-inner", { children: [input] }), h(doc, "div", "editor-border", { text: BORDER })],
	});
	const extBelow = h(doc, "div", "ext-widgets", { attrs: { hidden: "" } });
	const footerLine1 = h(doc, "div", "footer-line footer-line-1", { text: "—" });
	const footerLeft2 = h(doc, "span", "footer-left-2", { text: "—" });
	const footerRight2 = h(doc, "span", "footer-right", { text: "—" });
	const footerExtStatus = h(doc, "div", "footer-line ext-status", { attrs: { hidden: "" } });
	const footer = h(doc, "div", "footer", {
		children: [footerLine1, h(doc, "div", "footer-line footer-line-2", { children: [footerLeft2, footerRight2] }), footerExtStatus],
	});
	const el = h(doc, "div", "chat pane", {
		children: [msgs, h(doc, "div", "jump-anchor", { children: [jumpLatest] }), queuedPanel, working, extAbove, editor, extBelow, footer],
	});
	return {
		el,
		/** @type {import("./pane.js").PaneRefs} */
		refs: { msgs, jumpLatest, queuedPanel, input, working, workingSpin, workingText, footerLine1, footerLeft2, footerRight2, footerExtStatus, extAbove, extBelow },
	};
}
