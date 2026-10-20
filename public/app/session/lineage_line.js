// The lineage line in a session's header (lineage.js has the view model): whose child the session is, the children
// it started and relay's state, in one line whose segments cut short rather than wrap. The parent and each child are
// links when pi-web can open them; a click anywhere else on the line opens it all in full (buildLineageMenu).
import { lineageLine, partyTitle } from "./lineage.js";

/** @typedef {import("./lineage.js").Party} Party */
/** @typedef {import("./lineage.js").LinePart} LinePart */
/** @typedef {import("./lineage.js").DetailsSection} DetailsSection */
/** @typedef {import("./lineage.js").DetailsRow} DetailsRow */
/** @typedef {import("./chat_view.js").SessionRef} SessionRef */

/** @param {Party} party @returns {SessionRef} */
const refOf = (party) => ({ id: party.id, label: party.label, cwd: "" });

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {Document} doc @param {K} tag @param {string} className @param {string} [text]
 */
function make(doc, tag, className, text) {
	const el = doc.createElement(tag);
	el.className = className;
	if (text !== undefined) el.textContent = text;
	return el;
}

/** A party is a link when it opens (`links`: there's an opener), else plain text saying where it runs on hover. @param {Document} doc @param {LinePart} part @param {boolean} links */
function partNode(doc, part, links) {
	const { party } = part;
	if (!party) return part.className ? make(doc, "span", part.className, part.text) : doc.createTextNode(part.text);
	const link = links && party.openable;
	const el = make(doc, link ? "a" : "span", `lin-party${party.state ? ` is-${party.state}` : ""}`, part.text);
	el.title = partyTitle(party, link);
	if (link) {
		el.setAttribute("href", "#");
		el.dataset.sessionId = party.id;
	}
	return el;
}

/**
 * @param {HTMLElement} el the line, hidden while there's nothing to show
 * @param {{ onOpen?: ((ref: SessionRef) => void) | null, onDetails?: ((anchor: HTMLElement) => void) | null }} [options]
 * `onOpen` opens a session the line names (without it the parties are plain text); `onDetails` hears a click on the
 * line anywhere but a link.
 */
export function createLineageLine(el, { onOpen = null, onDetails = null } = {}) {
	const doc = el.ownerDocument;
	/** @type {Map<string, Party>} */
	let parties = new Map();
	/** @type {string | null} */
	let shownKey = null;
	// what the line was last drawn from: a pane renders often, and these only change when the host sends new ones
	/** @type {unknown} */
	let drawnLineage;
	/** @type {unknown} */
	let drawnRelay;

	/** @param {Event} event */
	function onClick(event) {
		const target = event.target instanceof Element ? event.target : null;
		const link = target?.closest("a.lin-party");
		if (link instanceof HTMLElement) {
			event.preventDefault();
			event.stopPropagation();
			const party = parties.get(link.dataset.sessionId ?? "");
			if (party && onOpen) onOpen(refOf(party));
			return;
		}
		onDetails?.(el);
	}
	el.addEventListener("click", onClick);

	function clear() {
		shownKey = "";
		parties = new Map();
		el.hidden = true;
		el.replaceChildren();
	}

	/** @param {import("./lineage.js").LineSegment} segment */
	function segmentNode(segment) {
		const seg = make(doc, "span", `lin-seg lin-seg-${segment.kind}`);
		seg.title = segment.title;
		for (const part of segment.parts) {
			if (part.party) parties.set(part.party.id, part.party);
			seg.append(partNode(doc, part, Boolean(onOpen)));
		}
		return seg;
	}

	return {
		/** Draws the line for a session's status (its lineage and relay), unless it shows that already. @param {any} state */
		render(state) {
			if (shownKey !== null && state?.lineage === drawnLineage && state?.relay === drawnRelay) return;
			drawnLineage = state?.lineage;
			drawnRelay = state?.relay;
			const view = lineageLine(state);
			const key = view?.key ?? "";
			if (key === shownKey) return;
			if (!view) {
				clear();
				return;
			}
			shownKey = key;
			parties = new Map();
			el.replaceChildren(...view.segments.map(segmentNode));
			// the children give way first; the other segments keep their width up to a share of the line
			el.classList.toggle("lin-has-children", view.segments.some((segment) => segment.kind === "children"));
			el.hidden = false;
		},
		destroy() {
			el.removeEventListener("click", onClick);
			clear();
		},
	};
}

/** A row's secondary line: its text, or a span per piece when it comes in pieces (a running call's, lin-split). @param {Document} doc @param {DetailsRow} row */
function secondaryNode(doc, row) {
	const parts = row.parts ?? [];
	if (parts.length < 2) return make(doc, "div", "secondary", row.secondary);
	const el = make(doc, "div", "secondary lin-split");
	el.append(...parts.map((part) => make(doc, "span", part.className ?? "", part.text)));
	return el;
}

/**
 * The line in full, in a menu panel: a section each for the parent, the children and relay, and a row per party that
 * opens it when pi-web can.
 * @param {HTMLElement} panel @param {DetailsSection[]} sections
 * @param {{ onOpen?: ((ref: SessionRef) => void) | null, close: () => void }} options
 */
export function buildLineageMenu(panel, sections, { onOpen = null, close }) {
	const doc = panel.ownerDocument;
	const hdr = make(doc, "div", "menu-hdr");
	const closeBtn = make(doc, "button", "menu-mini", "Close");
	closeBtn.type = "button";
	closeBtn.addEventListener("click", () => close());
	hdr.append(make(doc, "div", "menu-title", "Lineage and relay"), closeBtn);
	const body = make(doc, "div", "menu-body lin-menu");
	if (sections.length === 0) body.append(make(doc, "div", "si-meta", "Nothing to show: no parent, no children, no relay."));
	for (const section of sections) {
		const list = make(doc, "div", "menu-list");
		for (const row of section.rows) {
			const party = onOpen && row.party?.openable ? row.party : null;
			const item = make(doc, "div", `menu-item${party ? "" : " is-static"}${row.wrap ? " is-wrap" : ""}`);
			item.append(make(doc, "div", "primary", row.primary));
			if (row.secondary) item.append(secondaryNode(doc, row));
			if (party && onOpen) {
				item.dataset.sessionId = party.id;
				item.title = `open ${party.label}`;
				item.addEventListener("click", () => {
					close();
					onOpen(refOf(party));
				});
			}
			list.append(item);
		}
		body.append(make(doc, "div", "menu-sub", section.heading), list);
	}
	panel.append(hdr, body);
}
