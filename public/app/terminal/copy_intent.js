// When terminal output may write the clipboard. pbcopy's text reaches the page as OSC 52, and so can any bytes the
// terminal shows (a cat'ed file, an ssh peer, a build log), so OSC 52 alone proves nothing. A write follows only a
// return that showed copy intent, and only within ARM_MS of it:
// - the keys typed on the line run pbcopy (`pbcopy < f`, `cat f | pbcopy`, a fast `| pbcopy` whose echo hasn't come), or
// - the line shows pbcopy where the keys pressed on it put it (recalled with ↑, completed with tab, found with ctrl-r).
// A bare return on a line output printed shows nothing. Every other OSC 52 waits for a tap or click instead.
// Pure: the terminal view feeds it keys, the cursor line and the time, and acts on what it says.

/** How long a return on a pbcopy line waits for its text. */
export const ARM_MS = 15_000;
/** How much typed text a line keeps. */
const TYPED_MAX = 2_000;
/** How much of the text a copy affordance shows. */
const PREVIEW_MAX = 60;
/**
 * Escape sequences a person sends: arrows, home/end, editing and function keys, esc and alt plus a key, a bracketed
 * paste. Not the reports xterm answers output with (cursor position, device attributes, modes, window size, colours,
 * focus, mouse), which output could ask for to fake keys pressed on its line.
 */
const KEY_SEQUENCE = /^\x1b(?:\[[\d;]*[A-DHF~]|O[A-DHFP-S]|\[200~[\s\S]*\x1b\[201~|[\s\S]?)$/;
/** pbcopy as a word anywhere on a line; the group is what comes before it. */
const PBCOPY = /(^|[^\w-])pbcopy(?=$|[^\w-])/g;
const PBCOPY_LEN = "pbcopy".length;

/**
 * What the keys pressed since the last return say: `typed` is the text typed (cleared by keys that move the cursor),
 * `lineStart` the cursor line when the first key on this line went down (null before it), `armedAt` when a return
 * showed copy intent (null when none waits).
 * @typedef {{ readonly typed: string, readonly lineStart: string | null, readonly armedAt: number | null }} CopyIntent
 */

/** @type {CopyIntent} */
export const NO_INTENT = Object.freeze({ typed: "", lineStart: null, armedAt: null });

/** @param {string} text @returns {Array<[number, number]>} where pbcopy is, as words */
function pbcopySpans(text) {
	return [...text.matchAll(PBCOPY)].map((match) => {
		const start = (match.index ?? 0) + match[1].length;
		return [start, start + PBCOPY_LEN];
	});
}

/** @param {string} text */
export const mentionsPbcopy = (text) => pbcopySpans(text).length > 0;

/**
 * The stretch of `now` that isn't `before`: what lies between their common start and their common end.
 * @param {string} before @param {string} now @returns {[number, number]}
 */
export function changedSpan(before, now) {
	const most = Math.min(before.length, now.length);
	let start = 0;
	while (start < most && before[start] === now[start]) start += 1;
	let end = 0;
	while (end < most - start && before[before.length - 1 - end] === now[now.length - 1 - end]) end += 1;
	return [start, now.length - end];
}

/** A pbcopy on the line that the keys pressed on it put there. @param {string} lineStart @param {string} line */
function keysPutPbcopy(lineStart, line) {
	const [from, to] = changedSpan(lineStart, line);
	return pbcopySpans(line).some(([start, end]) => start < to && end > from);
}

/** Input a person sent, as opposed to xterm's answer to something output asked. @param {string} data */
export const isKeys = (data) => !data.startsWith("\x1b") || KEY_SEQUENCE.test(data);

/**
 * Input on its way to the shell (after the phone's ctrl mapping), with the cursor line as it is before the shell
 * answers. Returns and ctrl-c start a new line; ctrl-u and escape sequences (arrows, esc, pastes) leave typed text that
 * no longer says what's on the line. xterm's answers to output count for nothing.
 * @param {CopyIntent} intent @param {string} data @param {string} cursorLine @returns {CopyIntent}
 */
export function afterInput(intent, data, cursorLine) {
	if (!isKeys(data)) return intent;
	if (/[\r\x03]/.test(data)) return { ...intent, typed: "", lineStart: null };
	const lineStart = intent.lineStart ?? cursorLine;
	if (/[\x15\x1b]/.test(data)) return { ...intent, typed: "", lineStart };
	if (data === "\x7f") return { ...intent, typed: intent.typed.slice(0, -1), lineStart };
	return { ...intent, typed: (intent.typed + data).slice(-TYPED_MAX), lineStart };
}

/**
 * A return going down on `cursorLine` at `now`: `armed` when it shows copy intent, which then waits ARM_MS for its text.
 * A return that shows none leaves an earlier one waiting.
 * @param {CopyIntent} intent @param {string} cursorLine @param {number} now @returns {{ intent: CopyIntent, armed: boolean }}
 */
export function afterReturn(intent, cursorLine, now) {
	const armed = mentionsPbcopy(intent.typed) || (intent.lineStart !== null && keysPutPbcopy(intent.lineStart, cursorLine));
	return { intent: armed ? { ...intent, armedAt: now } : intent, armed };
}

/**
 * An OSC 52 write arriving at `now`: `allowed` when a return armed one in the last ARM_MS. Either way it uses up the
 * wait, so one return lets one write through.
 * @param {CopyIntent} intent @param {number} now @returns {{ intent: CopyIntent, allowed: boolean }}
 */
export function takeCopy(intent, now) {
	const since = intent.armedAt === null ? Number.NaN : now - intent.armedAt;
	return { intent: { ...intent, armedAt: null }, allowed: since >= 0 && since <= ARM_MS };
}

/**
 * A key event that sends a plain return (no modifier, no composition under way).
 * @param {Pick<KeyboardEvent, "type" | "key" | "keyCode" | "isComposing" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">} event
 */
export function isReturnKey(event) {
	if (event.type !== "keydown" || event.isComposing) return false;
	if (event.key !== "Enter" && event.keyCode !== 13) return false;
	return !(event.shiftKey || event.altKey || event.ctrlKey || event.metaKey);
}

/** @param {string} payload base64 @returns {string} */
function decodeBase64Utf8(payload) {
	const binary = atob(payload);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return new TextDecoder().decode(bytes);
}

/**
 * The text an OSC 52 asks to write (`c;<base64>`), or null for nothing to write: a read (`?`, always refused, so
 * nothing in the shell reads the clipboard back), an empty payload or one that isn't base64.
 * @param {string} data @returns {string | null}
 */
export function osc52Text(data) {
	const payload = data.slice(data.indexOf(";") + 1);
	if (!payload || payload === "?") return null;
	try {
		return decodeBase64Utf8(payload);
	} catch {
		return null;
	}
}

/** @param {string} text */
export function lineCount(text) {
	const lines = text.replace(/\n$/, "").split("\n").length;
	return `${lines} line${lines === 1 ? "" : "s"}`;
}

/** What a copy affordance says about text waiting for a tap: how long it is and how it starts. @param {string} text */
export function copySummary(text) {
	const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
	const flat = first.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
	const preview = flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
	return preview ? `${lineCount(text)} · ${preview}` : lineCount(text);
}
