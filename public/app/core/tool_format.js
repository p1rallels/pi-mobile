import { safeStringify } from "./stringify.js";

export function toolPreviewLines(toolName) {
	if (toolName === "bash") return 5;
	if (toolName === "msg_list") return 6;
	if (toolName === "read" || toolName === "write") return 10;
	if (toolName === "grep") return 15;
	return 20;
}

/** `mcp__server__tool` reads as `server › tool`. */
export function displayToolName(toolName) {
	const name = String(toolName ?? "");
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	return mcp ? `${mcp[1]} › ${mcp[2]}` : name;
}

export function formatDuration(ms) {
	const value = Number(ms);
	if (!Number.isFinite(value) || value < 0) return "";
	if (value < 1000) return `${Math.round(value)}ms`;
	if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
	const minutes = Math.floor(value / 60_000);
	const seconds = Math.round((value % 60_000) / 1000);
	return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
}

function compactJson(value, maxChars) {
	let text;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function firstString(args) {
	if (typeof args === "string") return args;
	if (!args || typeof args !== "object") return "";
	const value = Object.values(args).find((candidate) => typeof candidate === "string");
	return typeof value === "string" ? value : "";
}

/** First meaningful line of a codemode script, skipping its optional `// @options:` line. */
export function codemodeSummary(args) {
	const lines = firstString(args)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("// @options:"));
	return lines[0] ?? "";
}

/** @param {unknown} value */
const argText = (value) => (typeof value === "string" ? value.trim() : "");

/** @param {unknown} value */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** How msg names a session: its name, else the first 8 characters of its id. @param {any} party */
const partyName = (party) => (isRecord(party) ? argText(party.name) || argText(party.id).slice(0, 8) : "");

/**
 * msg's tools and relay's, as what they do: `→ worker: message`, `msg_wait ← worker · up to 300s`, `relay: note`.
 * Null for any other tool, and while the call's arguments are still streaming in.
 * @param {string} toolName @param {any} args
 */
export function peerToolCallText(toolName, args) {
	const a = isRecord(args) ? args : {};
	switch (toolName) {
		case "msg_send": {
			const to = argText(a.to);
			const message = typeof a.message === "string" ? a.message.trim() : "";
			if (!to && !message) return null;
			const notes = [argText(a.reply_to) ? `re ${argText(a.reply_to)}` : "", a.delivery === "follow_up" ? "follow-up" : ""].filter(Boolean);
			const head = `→ ${to || "?"}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
			return message ? `${head}: ${message}` : head;
		}
		case "msg_wait": {
			const timeout = typeof a.timeout_seconds === "number" && a.timeout_seconds > 0 ? ` · up to ${formatDuration(a.timeout_seconds * 1000)}` : "";
			return `msg_wait ← ${argText(a.from) || "anyone"}${timeout}`;
		}
		case "msg_list":
			return ["msg_list", a.all === true ? "all" : "", argText(a.set_name) ? `as ${argText(a.set_name)}` : ""].filter(Boolean).join(" · ");
		case "relay": {
			const note = typeof a.note === "string" ? a.note.trim() : "";
			const head = a.done === true ? "relay (done)" : "relay";
			return note ? `${head}: ${note}` : head;
		}
		default:
			return null;
	}
}

export function toolCallToText(toolName, args) {
	const peer = peerToolCallText(toolName, args);
	if (peer !== null) return peer;
	if (toolName === "codemode") {
		const summary = codemodeSummary(args);
		return summary ? `codemode: ${summary}` : "codemode";
	}
	if (typeof toolName === "string" && toolName.startsWith("mcp__")) {
		const keys = args && typeof args === "object" ? Object.keys(args) : [];
		return keys.length > 0 ? `${displayToolName(toolName)} ${compactJson(args, 160)}` : displayToolName(toolName);
	}
	if (!args || typeof args !== "object") return safeStringify(args);
	if (toolName === "bash") {
		const cmd = typeof args.command === "string" ? args.command : safeStringify(args);
		return `$ ${cmd}`;
	}
	if (toolName === "grep") {
		const pattern = typeof args.pattern === "string" ? args.pattern : null;
		const p = typeof args.path === "string" ? args.path : ".";
		if (pattern) return `grep /${pattern}/ in ${p}`;
		return "grep";
	}
	if (toolName === "find") {
		const pattern = typeof args.pattern === "string" ? args.pattern : null;
		const p = typeof args.path === "string" ? args.path : ".";
		if (pattern) return `find ${pattern} in ${p}`;
		return "find";
	}
	if (toolName === "ls") {
		const p = typeof args.path === "string" ? args.path : ".";
		return `ls ${p}`;
	}
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		const p = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (p) return `${toolName} ${p}`;
	}
	return toolName;
}

/** The "when" msg_send's result spells out after its message id: `Sent <id> to <who>: <when>.` @param {string} text */
function sentWhen(text) {
	const match = /^Sent \S+ to .+?\): (.+?)\.?$/m.exec(text);
	return match ? match[1] : "";
}

/**
 * What msg's tools came back with, said short: sent (and when it lands), the reply, no reply; the message a
 * wait got. Null when the result isn't one of theirs or doesn't carry what this needs (then its text shows).
 * @param {string} toolName @param {any} result @param {{ isError?: boolean, partial?: boolean }} [options]
 */
export function peerToolOutcome(toolName, result, { isError = false, partial = false } = {}) {
	if (isError || !isRecord(result) || !isRecord(result.details)) return null;
	const details = result.details;
	switch (toolName) {
		case "msg_send": {
			const reply = isRecord(details.reply) ? details.reply : null;
			if (reply && typeof reply.text === "string") return `↩ ${partyName(reply.from) || "reply"}: ${reply.text}`;
			if (details.outcome === "timeout") return "no reply";
			if (details.outcome === "aborted") return "stopped waiting, no reply";
			if (!isRecord(details.message)) return null;
			if (partial) return "sent · waiting for a reply…";
			const when = sentWhen(toolResultToText(result));
			return when ? `sent · ${when}` : "sent";
		}
		case "msg_wait": {
			const message = isRecord(details.message) ? details.message : null;
			if (message && typeof message.text === "string") {
				const who = partyName(message.from) || "message";
				const how = message.kind === "ended" ? " (finished)" : message.kind === "died" ? " (died)" : message.byUser === true ? " (you)" : "";
				return `${who}${how}: ${message.text}`;
			}
			if (details.outcome === "timeout") return "no message";
			if (details.outcome === "aborted") return "stopped waiting";
			return null;
		}
		default:
			return null;
	}
}

/**
 * The text a tool box shows for a result: msg's tools say what happened, any other tool its text.
 * @param {string} toolName @param {any} result @param {{ isError?: boolean, partial?: boolean }} [options]
 */
export function toolOutputText(toolName, result, options = {}) {
	return peerToolOutcome(toolName, result, options) ?? toolResultToText(result);
}

export function toolResultToText(result) {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return safeStringify(result);

	const content = Array.isArray(result.content) ? result.content : null;
	if (!content) return safeStringify(result);

	const out = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			out.push(block.text);
		} else if (block.type === "image" && typeof block.mimeType === "string") {
			out.push(`[image: ${block.mimeType}]`);
		}
	}
	return out.join("\n").trimEnd();
}

