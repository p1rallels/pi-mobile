// Markdown for assistant text and msg bodies, drawn as DOM (never innerHTML): fenced code blocks, GFM tables, inline
// code and bold. Everything else stays text in .md's pre-wrap.

/** @typedef {"" | "left" | "center" | "right"} Align */
/**
 * @typedef {{ kind: "text", text: string }
 *   | { kind: "code", text: string }
 *   | { kind: "table", align: Align[], head: string[], rows: string[][] }} Block
 */

const FENCE = "```";
const DELIMITER_CELL = /^:?-+:?$/;
const BR_TAG = /<br\s*\/?>/gi;
/** A cell this long or shorter (in characters, its longest line) never wraps; a longer one wraps, but no narrower (styles.css, .md-table .wrap). */
const NOWRAP_CHARS = 20;

function appendBold(target, text) {
	const parts = String(text).split("**");
	const markerCount = parts.length - 1;
	if (markerCount === 0 || markerCount % 2 !== 0) {
		target.appendChild(document.createTextNode(String(text)));
		return;
	}

	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i];
		if (i % 2 === 0) {
			if (part) target.appendChild(document.createTextNode(part));
			continue;
		}
		const span = document.createElement("span");
		span.className = "bold";
		span.textContent = part;
		target.appendChild(span);
	}
}

function appendInlineMarkdown(target, text) {
	const chunks = String(text).split("`");
	const backtickCount = chunks.length - 1;
	if (backtickCount === 0 || backtickCount % 2 !== 0) {
		appendBold(target, text);
		return;
	}

	for (let i = 0; i < chunks.length; i += 1) {
		const chunk = chunks[i];
		if (i % 2 === 0) {
			if (chunk) appendBold(target, chunk);
		} else {
			const span = document.createElement("span");
			span.className = "ci";
			span.textContent = chunk;
			target.appendChild(span);
		}
	}
}

/** @param {string} line */
const hasPipe = (line) => /(^|[^\\])\|/.test(line);

/** A table row's cells: pipes split them, the outer ones are optional, and \| is a pipe inside a cell. @param {string} line */
export function splitRow(line) {
	const row = line.trim();
	const cells = [""];
	for (let i = 0; i < row.length; i += 1) {
		if (row[i] === "\\" && row[i + 1] === "|") {
			cells[cells.length - 1] += "|";
			i += 1;
		} else if (row[i] === "|") {
			cells.push("");
		} else {
			cells[cells.length - 1] += row[i];
		}
	}
	if (row.startsWith("|")) cells.shift();
	if (row.endsWith("|") && !row.endsWith("\\|")) cells.pop();
	return cells.map((cell) => cell.trim());
}

/** @param {string} cell @returns {Align} */
const cellAlign = (cell) => (cell.startsWith(":") ? (cell.endsWith(":") ? "center" : "left") : cell.endsWith(":") ? "right" : "");

/** The column alignments a delimiter row (| --- | :-: | --: |) sets, or null when the line isn't one. @param {string} line */
function delimiterRow(line) {
	if (!hasPipe(line)) return null;
	const cells = splitRow(line);
	return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell)) ? cells.map(cellAlign) : null;
}

/** @param {string} line */
const isBodyRow = (line) => line.trim() !== "" && hasPipe(line) && !line.startsWith(FENCE);

/** A cell's text with <br> as a line break, except inside inline code. @param {string} cell */
function cellText(cell) {
	const chunks = cell.split("`");
	if (chunks.length % 2 === 0) return cell.replace(BR_TAG, "\n");
	return chunks.map((chunk, i) => (i % 2 === 0 ? chunk.replace(BR_TAG, "\n") : chunk)).join("`");
}

/**
 * The table whose header row is lines[start], or null: a delimiter row with as many cells comes right under it, and
 * body rows run to the first line without a pipe. A short row gets empty cells, a long one loses the extra.
 * @param {string[]} lines @param {number} start
 * @returns {{ block: Block, next: number } | null}
 */
function readTable(lines, start) {
	if (start + 1 >= lines.length || !hasPipe(lines[start])) return null;
	const align = delimiterRow(lines[start + 1]);
	const head = splitRow(lines[start]);
	if (!align || align.length !== head.length) return null;
	let end = start + 2;
	while (end < lines.length && isBodyRow(lines[end])) end += 1;
	const rows = lines.slice(start + 2, end).map((line) => {
		const cells = splitRow(line);
		return head.map((_, i) => cellText(cells[i] ?? ""));
	});
	return { block: { kind: "table", align, head: head.map(cellText), rows }, next: end };
}

/** The blocks markdown draws, in order: fenced code (an unclosed fence runs to the end), tables, and the text between. @param {string} text @returns {Block[]} */
export function parseBlocks(text) {
	const lines = String(text).split("\n");
	/** @type {Block[]} */
	const blocks = [];
	/** @type {string[]} */
	let textLines = [];
	const flushText = () => {
		if (textLines.length > 0) blocks.push({ kind: "text", text: textLines.join("\n") });
		textLines = [];
	};

	let i = 0;
	while (i < lines.length) {
		if (lines[i].startsWith(FENCE)) {
			flushText();
			let end = i + 1;
			while (end < lines.length && !lines[end].startsWith(FENCE)) end += 1;
			blocks.push({ kind: "code", text: lines.slice(i + 1, end).join("\n") });
			i = end + 1;
			continue;
		}
		const table = readTable(lines, i);
		if (table) {
			flushText();
			blocks.push(table.block);
			i = table.next;
			continue;
		}
		textLines.push(lines[i]);
		i += 1;
	}
	flushText();
	return blocks;
}

/** @param {string} text */
function codeNode(text) {
	const block = document.createElement("div");
	block.className = "codeblock";
	const code = document.createElement("code");
	code.textContent = text;
	block.appendChild(code);
	return block;
}

/** @param {"th" | "td"} tag @param {string} text @param {Align} align */
function cellNode(tag, text, align) {
	const cell = document.createElement(tag);
	appendInlineMarkdown(cell, text);
	if (align) cell.style.textAlign = align;
	const longest = Math.max(...(cell.textContent ?? "").split("\n").map((line) => line.length));
	if (longest > NOWRAP_CHARS) cell.classList.add("wrap");
	return cell;
}

/** A table in its own horizontal scroller, like a code block. @param {{ align: Align[], head: string[], rows: string[][] }} table */
function tableNode({ align, head, rows }) {
	const scroller = document.createElement("div");
	scroller.className = "md-table";
	const table = document.createElement("table");
	const headRow = table.createTHead().insertRow();
	head.forEach((text, i) => headRow.appendChild(cellNode("th", text, align[i])));
	const body = table.createTBody();
	for (const row of rows) {
		const tr = body.insertRow();
		row.forEach((text, i) => tr.appendChild(cellNode("td", text, align[i])));
	}
	scroller.appendChild(table);
	return scroller;
}

/** @param {Block} block @returns {Node} */
function blockNode(block) {
	switch (block.kind) {
		case "code":
			return codeNode(block.text);
		case "table":
			return tableNode(block);
		default: {
			const text = document.createDocumentFragment();
			appendInlineMarkdown(text, block.text);
			return text;
		}
	}
}

export function renderMarkdown(target, text) {
	target.replaceChildren(...parseBlocks(text).map(blockNode));
}
