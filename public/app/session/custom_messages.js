// What the page draws for extension traffic in the stream: msg's messages between sessions, relay's notices and
// resets, and the entries pi appends at turn boundaries (entry_appended). Pure view models: every field is
// optional, and anything malformed falls back to the generic notice instead of breaking the transcript.
import { extractTextContent } from "./content.js";

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : "");

/** @param {unknown} value */
const trimmed = (value) => text(value).trim();

/** @param {unknown} value */
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** @param {string} value */
const firstLine = (value) => value.split("\n").find((line) => line.trim())?.trim() ?? "";

/**
 * How msg names a session: its name, else the first 8 characters of its id.
 * @param {unknown} party
 */
export function partyLabel(party) {
	if (!isRecord(party)) return "";
	return trimmed(party.name) || trimmed(party.id).slice(0, 8);
}

/**
 * "45%" from relay's percent (0-100), or null. Floored to a tenth like relay's own text, so 44.96 never reads as
 * the 45% step: "44.9%".
 * @param {unknown} percent
 */
export function percentLabel(percent) {
	const value = finite(percent);
	if (value === null || value < 0) return null;
	const tenth = Math.floor(value * 10 + 1e-9) / 10;
	return `${Number.isInteger(tenth) ? tenth : tenth.toFixed(1)}%`;
}

/**
 * The text a message carries when its details lack it: msg frames it for the model as `<msg …>text</msg>` plus a
 * hint, so the page shows what is inside the tags.
 * @param {string} content
 */
function unframeMsg(content) {
	const match = /^<msg\b[^>]*>\n?([\s\S]*?)\n?<\/msg>/.exec(content.trim());
	return match ? match[1].replace(/<\\\/msg>/gi, "</msg>") : content;
}

const MSG_KIND_LABELS = { ended: "finished", died: "died" };

/**
 * @typedef {{
 *   sender: { id: string, label: string, cwd: string },
 *   replyTo: string,
 *   kind: string,
 *   kindLabel: string,
 *   byUser: boolean,
 *   text: string,
 * }} MsgView
 */

/**
 * A msg message (customType "msg", details = msg's Message): who sent it, what it answers, how it came and the
 * text itself. The body is details.text; content is what the model reads, framing and all.
 * @param {any} message @returns {MsgView | null} null when there is nothing to show
 */
export function msgView(message) {
	if (!isRecord(message)) return null;
	const details = isRecord(message.details) ? message.details : {};
	const from = isRecord(details.from) ? details.from : {};
	const body = trimmed(details.text) ? details.text : unframeMsg(extractTextContent(message.content));
	if (!body.trim()) return null;
	const kind = trimmed(details.kind);
	return {
		sender: { id: trimmed(from.id), label: partyLabel(from) || "another session", cwd: trimmed(from.cwd) },
		replyTo: trimmed(details.replyTo),
		kind,
		kindLabel: MSG_KIND_LABELS[/** @type {keyof typeof MSG_KIND_LABELS} */ (kind)] ?? kind,
		byUser: details.byUser === true,
		text: body,
	};
}

/**
 * @typedef {{ label: string, meta: string[], summary: string, full: string }} RelayView
 */

/**
 * A relay notice (customType "relay"): "relay · 41% · you're at 41%…" on one line, the full text a tap away.
 * Nudges and loop prompts show their own text (without relay's "[relay]" tag), resets their note; each falls
 * back to the others.
 * @param {any} message @returns {RelayView | null}
 */
export function relayView(message) {
	if (!isRecord(message)) return null;
	const details = isRecord(message.details) ? message.details : {};
	const full = extractTextContent(message.content).trim();
	const kind = trimmed(details.kind);
	const note = trimmed(details.note);
	const goal = trimmed(details.goal);
	const lead = firstLine(full).replace(/^\[relay(?: loop)?\]\s*/i, "");
	const summary = (kind === "reset" ? [note, lead, goal] : [lead, note, goal]).find(Boolean) ?? "";
	const n = finite(details.n);
	const percent = percentLabel(details.percent);
	const shownKind = kind === "nudge" ? "" : kind === "loop" && trimmed(details.stopped) ? "loop stopped" : kind;
	const meta = [...(shownKind ? [percent ? `${shownKind} at ${percent}` : shownKind] : percent ? [percent] : []), ...(details.byUser === true ? ["by you"] : [])];
	if (!summary && meta.length === 0) return null;
	return { label: n === null ? "relay" : `relay #${n}`, meta, summary, full: full === summary ? "" : full };
}

/**
 * @typedef {{ title: string, note: string, goal: string }} RelayResetView
 */

/**
 * A compaction relay wrote (details.relay): a context reset, "relay #2 · context reset at 45%", with the note
 * the agent left for its fresh context. Null for any other compaction.
 * @param {any} message @returns {RelayResetView | null}
 */
export function relayResetView(message) {
	const relay = isRecord(message) && isRecord(message.details) && isRecord(message.details.relay) ? message.details.relay : null;
	if (!relay) return null;
	const n = finite(relay.n);
	const percent = percentLabel(relay.percent);
	return {
		title: `${n === null ? "relay" : `relay #${n}`} · context reset${percent ? ` at ${percent}` : ""}`,
		note: trimmed(relay.note),
		goal: trimmed(relay.goal),
	};
}

/** @param {unknown} timestamp an entry's ISO time */
function entryTime(timestamp) {
	const ms = typeof timestamp === "string" ? Date.parse(timestamp) : finite(timestamp);
	return ms !== null && Number.isFinite(ms) ? ms : Date.now();
}

/**
 * The transcript message an appended entry stands for, the way the host builds history (src/transcript.ts), so a
 * live entry and a resync draw the same thing under the same entry id. Null for entries that draw nothing (custom
 * state, context edits, hidden custom messages) or that already come with message events.
 * @param {any} entry @returns {Record<string, any> | null}
 */
export function entryMessage(entry) {
	if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) return null;
	const timestamp = entryTime(entry.timestamp);
	switch (entry.type) {
		case "custom_message":
			if (!entry.display) return null;
			return { role: "custom", customType: text(entry.customType), content: entry.content ?? [], display: true, details: entry.details, timestamp, entryId: entry.id };
		case "compaction": {
			const relay = isRecord(entry.details) && isRecord(entry.details.relay) ? entry.details.relay : null;
			return {
				role: "compactionSummary",
				summary: text(entry.summary),
				tokensBefore: finite(entry.tokensBefore) ?? 0,
				timestamp,
				...(relay ? { details: { relay } } : {}),
				entryId: entry.id,
			};
		}
		default:
			return null;
	}
}
