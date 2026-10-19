// What a session's header shows of msg's lineage and relay (src/msg-lineage.ts, src/relay-state.ts), as one compact
// line of segments: "child of cc · 01a152a0", "3 children: died · mail-wakes · lineage-pill", "relay · 2 resets · loop".
// The parent and each child are links to that session when pi-web can open it, else they say where it runs. Pure view
// models: lineage_line.js draws them, and a tap on the line opens the same thing in full (lineageDetails).
import { isRecord, percentLabel } from "./custom_messages.js";

/** @typedef {{ id: string, label: string, state: string | null, openable: boolean, where: string | null }} Party */
/** @typedef {{ text: string, className?: string, party?: Party }} LinePart a party part is a link when it opens */
/** @typedef {{ kind: "parent" | "children" | "relay", parts: LinePart[], title: string }} LineSegment */
/** @typedef {{ segments: LineSegment[], key: string }} LineView */

const STATES = new Set(["live", "ended", "died", "offline"]);

/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value.trim() : "");

/** @param {unknown} value */
const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** @param {string} id */
const shortId = (id) => id.slice(0, 8);

/**
 * A party as the host sent it, or null when it isn't one.
 * @param {unknown} value @returns {Party | null}
 */
export function partyOf(value) {
	if (!isRecord(value)) return null;
	const id = text(value.id);
	if (!id) return null;
	const state = text(value.state);
	return { id, label: text(value.label) || shortId(id), state: STATES.has(state) ? state : null, openable: value.openable === true, where: text(value.where) || null };
}

/** The word after a child or parent that isn't live: "ended", "died", "offline"; "" when live or unknown. @param {Party} party */
export const stateWord = (party) => (party.state && party.state !== "live" ? party.state : "");

/** "2 resets", "1 reset". @param {number} n */
const resets = (n) => `${n} reset${n === 1 ? "" : "s"}`;

/**
 * Hover text for a party: who it is, how it stands, where it runs, and whether a click opens it.
 * @param {Party} party
 */
export function partyTitle(party) {
	return [`${party.label} · ${party.id}`, party.state ?? "never ran msg", party.where, party.openable ? "click to open" : "pi-web can't open it"]
		.filter(Boolean)
		.join(" · ");
}

/** @param {Party} party @returns {LinePart[]} */
function partyParts(party) {
	const word = stateWord(party);
	return [{ text: party.label, party }, ...(word ? [{ text: ` ${word}`, className: `lin-state is-${word}` }] : [])];
}

/** @param {Party} parent @returns {LineSegment} */
function parentSegment(parent) {
	const id = shortId(parent.id);
	const word = stateWord(parent);
	return {
		kind: "parent",
		parts: [
			{ text: "child of " },
			{ text: parent.label, party: parent },
			...(parent.label === id ? [] : [{ text: ` · ${id}`, className: "lin-id" }]),
			...(word ? [{ text: ` · ${word}`, className: `lin-state is-${word}` }] : []),
			...(parent.openable || !parent.where ? [] : [{ text: ` · ${parent.where}`, className: "lin-where" }]),
		],
		title: `parent: ${partyTitle(parent)}`,
	};
}

/** @param {Party[]} children @param {number} total @returns {LineSegment} */
function childrenSegment(children, total) {
	const parts = /** @type {LinePart[]} */ ([{ text: `${total} ${total === 1 ? "child" : "children"}: ` }]);
	children.forEach((child, index) => {
		if (index > 0) parts.push({ text: " · " });
		parts.push(...partyParts(child));
	});
	if (total > children.length) parts.push({ text: ` · +${total - children.length}`, className: "lin-more" });
	return { kind: "children", parts, title: children.map((child) => partyTitle(child)).join("\n") };
}

/**
 * The relay state the host sent, or null when there is nothing to show.
 * @param {unknown} value @returns {{ resets: number, loop: boolean, goal: string, nudge: string | null } | null}
 */
export function relayOf(value) {
	if (!isRecord(value)) return null;
	const relay = { resets: count(value.resets), loop: value.loop === true, goal: text(value.goal), nudge: percentLabel(value.nudge) };
	return relay.resets > 0 || relay.loop || relay.nudge ? relay : null;
}

/** The loop's goal in words: relay's own default when it was switched on without one. @param {string} goal */
export const goalText = (goal) => goal || "the task in the session's first message";

/** @param {NonNullable<ReturnType<typeof relayOf>>} relay @returns {LineSegment} */
function relaySegment(relay) {
	const parts = /** @type {LinePart[]} */ ([{ text: "relay", className: "lin-relay" }]);
	if (relay.resets > 0) parts.push({ text: ` · ${resets(relay.resets)}` });
	if (relay.loop) parts.push({ text: " · loop", className: "lin-loop" });
	if (relay.nudge) parts.push({ text: ` · nudged at ${relay.nudge}`, className: "lin-nudge" });
	const title = [
		`relay: ${relay.resets > 0 ? `${resets(relay.resets)} of the context so far` : "no context reset yet"}`,
		relay.loop ? `loop on, goal: ${goalText(relay.goal)}` : "loop off",
		...(relay.nudge ? [`asked to hand off at ${relay.nudge} of the context`] : []),
	].join("\n");
	return { kind: "relay", parts, title };
}

/**
 * The header line for a session's state (its lineage and relay), or null when there's nothing to show.
 * @param {any} state @returns {LineView | null}
 */
export function lineageLine(state) {
	const lineage = isRecord(state?.lineage) ? state.lineage : null;
	const parent = partyOf(lineage?.parent);
	const children = Array.isArray(lineage?.children) ? lineage.children.map(partyOf).filter((party) => party !== null) : [];
	const total = Math.max(count(lineage?.childCount), children.length);
	const relay = relayOf(state?.relay);
	const segments = [...(parent ? [parentSegment(parent)] : []), ...(total > 0 ? [childrenSegment(children, total)] : []), ...(relay ? [relaySegment(relay)] : [])];
	if (segments.length === 0) return null;
	return { segments, key: JSON.stringify([parent, children, total, relay]) };
}

/**
 * @typedef {{ primary: string, secondary: string, party: Party | null, wrap?: boolean }} DetailsRow `wrap`: the secondary line wraps (a goal)
 * @typedef {{ heading: string, rows: DetailsRow[] }} DetailsSection
 */

/**
 * Everything the line stands for, in full, for the menu a tap on the line opens: the parent, each child listed (with
 * how many more there are), relay with the loop's goal.
 * @param {any} state @returns {DetailsSection[]}
 */
export function lineageDetails(state) {
	const lineage = isRecord(state?.lineage) ? state.lineage : null;
	const parent = partyOf(lineage?.parent);
	const children = Array.isArray(lineage?.children) ? lineage.children.map(partyOf).filter((party) => party !== null) : [];
	const total = Math.max(count(lineage?.childCount), children.length);
	const relay = relayOf(state?.relay);
	/** @param {Party} party @returns {DetailsRow} */
	const row = (party) => ({
		primary: [party.label, party.label === shortId(party.id) ? "" : shortId(party.id), stateWord(party)].filter(Boolean).join(" · "),
		secondary: [party.state ?? "never ran msg", party.where, party.openable ? "" : "pi-web can't open it"].filter(Boolean).join(" · "),
		party,
	});
	/** @type {DetailsSection[]} */
	const sections = [];
	if (parent) sections.push({ heading: "parent", rows: [row(parent)] });
	if (total > 0) {
		const more = total - children.length;
		sections.push({
			heading: `${total} ${total === 1 ? "child" : "children"}`,
			rows: [...children.map(row), ...(more > 0 ? [{ primary: `+${more} more`, secondary: "not listed: the ones that ended longest ago go first", party: null }] : [])],
		});
	}
	if (relay) {
		sections.push({
			heading: "relay",
			rows: [
				{ primary: relay.resets > 0 ? `${resets(relay.resets)} of the context so far` : "no context reset yet", secondary: "", party: null },
				{ primary: relay.loop ? "loop on" : "loop off", secondary: relay.loop ? `goal: ${goalText(relay.goal)}` : "", party: null, wrap: true },
				...(relay.nudge ? [{ primary: `nudged at ${relay.nudge}`, secondary: "asked to hand off before the next reset", party: null }] : []),
			],
		});
	}
	return sections;
}
