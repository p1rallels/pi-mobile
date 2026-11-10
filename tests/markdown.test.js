import { describe, expect, test } from "bun:test";
import { parseBlocks, splitRow } from "../public/app/render/markdown.js";

const table = (align, head, rows) => ({ kind: "table", align, head, rows });

describe("markdown tables", () => {
	test("a table between text becomes its own block, with its alignments", () => {
		const text = ["here:", "", "| name | size | ok |", "|:--|--:|:-:|", "| a | 1 | **yes** |", "| `b` | 22 | no |", "", "after"].join("\n");

		expect(parseBlocks(text)).toEqual([
			{ kind: "text", text: "here:\n" },
			table(["left", "right", "center"], ["name", "size", "ok"], [
				["a", "1", "**yes**"],
				["`b`", "22", "no"],
			]),
			{ kind: "text", text: "\nafter" },
		]);
	});

	test("outer pipes are optional and \\| is a pipe inside a cell", () => {
		expect(parseBlocks("a | b\n--- | ---\nx \\| y | z")).toEqual([table(["", ""], ["a", "b"], [["x | y", "z"]])]);
		expect(splitRow("| a | b \\|")).toEqual(["a", "b |"]);
		expect(splitRow("|")).toEqual([]);
	});

	test("a short row gets empty cells and a long one loses the extra", () => {
		expect(parseBlocks("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")).toEqual([table(["", ""], ["a", "b"], [["1", ""], ["1", "2"]])]);
	});

	test("<br> is a line break in a cell, except inside inline code", () => {
		expect(parseBlocks("| a |\n|---|\n| one<br>two<br/>three |\n| `x<br>y` z<BR />w |")).toEqual([
			table([""], ["a"], [["one\ntwo\nthree"], ["`x<br>y` z\nw"]]),
		]);
	});

	test("the body ends at the first line without a pipe", () => {
		expect(parseBlocks("| a |\n|---|\n| 1 |\nprose right after")).toEqual([
			table([""], ["a"], [["1"]]),
			{ kind: "text", text: "prose right after" },
		]);
	});

	test("a header with no row of the same width under it is not a table", () => {
		const notTables = ["| a | b |\n| 1 | 2 |", "| a | b |\n|---|", "heading\n---", "a | b\n", "| a |"];
		for (const text of notTables) expect(parseBlocks(text)).toEqual([{ kind: "text", text }]);
	});

	test("a table inside a fence stays code, and an unclosed fence runs to the end", () => {
		expect(parseBlocks("```md\n| a |\n|---|\n```\n| b |\n|---|")).toEqual([
			{ kind: "code", text: "| a |\n|---|" },
			table([""], ["b"], []),
		]);
		expect(parseBlocks("x\n```\n| a |\n|---|")).toEqual([
			{ kind: "text", text: "x" },
			{ kind: "code", text: "| a |\n|---|" },
		]);
	});
});
