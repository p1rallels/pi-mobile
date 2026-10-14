import { safeStringify } from "./stringify.js";

export function toolPreviewLines(toolName) {
	if (toolName === "bash") return 5;
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

export function toolCallToText(toolName, args) {
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

