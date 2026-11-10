import { describe, expect, test } from "bun:test";
import { ARM_MS, NO_INTENT, afterInput, afterReturn, changedSpan, copySummary, isKeys, isReturnKey, osc52Text, takeCopy } from "../public/app/terminal/copy_intent.js";

const UP = "\x1b[A";
const T0 = 1_000_000;

/**
 * Keys on their way to the shell, each with the cursor line as the screen shows it when that key goes down.
 * @param {Array<[string, string]>} keys [data, cursorLine]
 */
function press(keys, intent = NO_INTENT) {
	return keys.reduce((acc, [data, line]) => afterInput(acc, data, line), intent);
}

/** Typed text, one key at a time, on a line that shows `line` until the shell echoes. @param {string} text @param {string} line */
const typing = (text, line) => [...text].map((key) => /** @type {[string, string]} */ ([key, line]));

/** Whether a return on `line` after `keys` arms a copy. @param {Array<[string, string]>} keys @param {string} line */
const armsOn = (keys, line) => afterReturn(press(keys), line, T0).armed;

describe("a return shows copy intent", () => {
	test("typed pbcopy commands arm, echoed or not", () => {
		expect(armsOn(typing("pbcopy < file.py", "$"), "$ pbcopy < file.py")).toBe(true);
		expect(armsOn(typing("cat x | pbcopy", "$"), "$ cat x | pbcopy")).toBe(true);
		// a fast `| pbcopy` on a slow link: the echo hasn't come when return goes down
		expect(armsOn(typing("cat x | pbcopy", "$"), "$ cat x | pb")).toBe(true);
		expect(armsOn(typing('sh -c "cat x | pbcopy"', "$"), "$")).toBe(true);
	});

	test("a bare return on a line output printed doesn't arm", () => {
		expect(armsOn([], "untrusted peer says pbcopy - press enter to continue")).toBe(false);
		expect(armsOn([], "$ pbcopy < file.py")).toBe(false);
		// the return before it started the line over, so its keys don't count for this one
		const afterLs = press([...typing("ls", "$"), ["\r", "$ ls"]]);
		expect(afterReturn(afterLs, "build log: pbcopy", T0).armed).toBe(false);
	});

	test("recalling a pbcopy command with the up arrow arms", () => {
		expect(armsOn([[UP, "$"]], "$ pbcopy < file.py")).toBe(true);
		expect(armsOn([[UP, "$"], [UP, "$ ls"]], "$ cat x | pbcopy")).toBe(true);
		// fixed up after recall: the arrows clear the typed text, the screen still says pbcopy
		expect(armsOn([[UP, "$"], ["\x1b[D", "$ pbcopy < fle.py"], ["i", "$ pbcopy < fle.py"]], "$ pbcopy < file.py")).toBe(true);
	});

	test("tab completion, ctrl-r and a right prompt arm when they put pbcopy on the line", () => {
		expect(armsOn([...typing("cat x | pbc", "$"), ["\t", "$ cat x | pbc"]], "$ cat x | pbcopy")).toBe(true);
		expect(armsOn([["\x12", "$"], ...typing("pbc", "(reverse-i-search)`': ")], "(reverse-i-search)`pbc': pbcopy < file.py")).toBe(true);
		const right = "~ %" + " ".repeat(30) + "main";
		expect(armsOn([[UP, right]], "~ % pbcopy < file.py" + " ".repeat(16) + "main")).toBe(true);
	});

	test("keys that don't put pbcopy on the line don't arm on a pbcopy output printed there", () => {
		// a cat'ed file without a trailing newline, the prompt after it
		expect(armsOn(typing("ls", "evil pbcopy $"), "evil pbcopy $ ls")).toBe(false);
		// text printed to the right of where the prompt draws
		const printed = "$" + " ".repeat(18) + "pbcopy";
		expect(armsOn(typing("ls", printed), "$ ls" + " ".repeat(15) + "pbcopy")).toBe(false);
		// an up arrow with nothing to recall leaves the line as it was
		expect(armsOn([[UP, "untrusted pbcopy"]], "untrusted pbcopy")).toBe(false);
	});

	test("xterm's answers to output aren't keys on the line", () => {
		// output prints a prompt, asks where the cursor is, then prints pbcopy after the answer
		expect(armsOn([["\x1b[1;3R", "$"]], "$ pbcopy < file.py")).toBe(false);
		expect(armsOn([["\x1b[?1;2c", "$"], ["\x1b[>0;276;0c", "$"], ["\x1b[0n", "$"], ["\x1b[I", "$"]], "$ pbcopy < file.py")).toBe(false);
		expect(armsOn([["\x1b[8;24;80t", "$"], ["\x1b]11;rgb:1818/1818/1e1e\x1b\\", "$"], ["\x1bP1$r0m\x1b\\", "$"], ["\x1b[?2004;1$y", "$"]], "$ pbcopy < f")).toBe(false);
		// and they don't wipe what was typed either
		expect(armsOn([...typing("cat x | pb", "$"), ["\x1b[1;12R", "$ cat x | pb"], ...typing("copy", "$ cat x | pb")], "$")).toBe(true);
	});

	test("keys a person sends are keys", () => {
		for (const key of ["l", "\t", "\x12", "\x1b", "\x1bb", "\x1b[A", "\x1bOA", "\x1b[1;5D", "\x1b[3~", "\x1b[H", "\x1bOF", "\x1b[200~cat x | pbcopy\x1b[201~"]) {
			expect(isKeys(key)).toBe(true);
		}
		for (const reply of ["\x1b[12;40R", "\x1b[?12;40R", "\x1b[?6c", "\x1b[O", "\x1b[<0;10;5M", "\x1b[6;16;8t"]) {
			expect(isKeys(reply)).toBe(false);
		}
	});

	test("pbcopy has to be the word", () => {
		expect(armsOn(typing("echo pbcopying", "$"), "$ echo pbcopying")).toBe(false);
		expect(armsOn(typing("my-pbcopy x", "$"), "$ my-pbcopy x")).toBe(false);
		expect(armsOn(typing("./pbcopy", "$"), "$ ./pbcopy")).toBe(true);
	});

	test("ctrl-c and backspace edit what was typed", () => {
		expect(armsOn([...typing("pbcopy", "$"), ["\x03", "$ pbcopy"], ...typing("ls", "$")], "$ ls")).toBe(false);
		expect(armsOn([...typing("pbcopyx", "$"), ["\x7f", "$ pbcopyx"]], "$")).toBe(true);
		expect(armsOn([...typing("pbcopy", "$"), ["\x7f", "$ pbcopy"]], "$")).toBe(false);
	});
});

describe("an OSC 52 write goes through", () => {
	const armed = afterReturn(press(typing("pbcopy < file.py", "$")), "$ pbcopy < file.py", T0).intent;

	test("within 15 s of a return that armed it", () => {
		expect(takeCopy(armed, T0 + 50).allowed).toBe(true);
		expect(takeCopy(armed, T0 + ARM_MS).allowed).toBe(true);
	});

	test("not after 15 s", () => {
		expect(takeCopy(armed, T0 + ARM_MS + 1).allowed).toBe(false);
	});

	test("not with nothing armed, and once per return", () => {
		expect(takeCopy(NO_INTENT, T0).allowed).toBe(false);
		const first = takeCopy(armed, T0 + 10);
		expect(first.allowed).toBe(true);
		expect(takeCopy(first.intent, T0 + 20).allowed).toBe(false);
	});

	test("a later return that shows no intent leaves the wait as it was", () => {
		const later = afterReturn(afterInput(armed, "\r", "$ pbcopy < file.py"), "$", T0 + 100);
		expect(later.armed).toBe(false);
		expect(takeCopy(later.intent, T0 + 200).allowed).toBe(true);
	});
});

describe("the pieces", () => {
	test("changedSpan finds what keys changed on a line", () => {
		expect(changedSpan("$", "$ ls")).toEqual([1, 4]);
		expect(changedSpan("abc", "abc")).toEqual([3, 3]);
		expect(changedSpan("~ %     main", "~ % ls  main")).toEqual([4, 6]);
		expect(changedSpan("", "x")).toEqual([0, 1]);
	});

	test("osc52Text decodes writes and refuses reads", () => {
		const utf8 = (/** @type {string} */ text) => Buffer.from(text, "utf8").toString("base64");
		expect(osc52Text(`c;${utf8("héllo\nworld")}`)).toBe("héllo\nworld");
		expect(osc52Text(`;${utf8("x")}`)).toBe("x");
		expect(osc52Text("c;?")).toBeNull();
		expect(osc52Text("c;")).toBeNull();
		expect(osc52Text("c;%%%")).toBeNull();
	});

	test("isReturnKey: a plain return going down", () => {
		const key = { type: "keydown", key: "Enter", keyCode: 13, isComposing: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
		expect(isReturnKey(key)).toBe(true);
		expect(isReturnKey({ ...key, key: "Unidentified" })).toBe(true);
		expect(isReturnKey({ ...key, type: "keyup" })).toBe(false);
		expect(isReturnKey({ ...key, isComposing: true })).toBe(false);
		expect(isReturnKey({ ...key, shiftKey: true })).toBe(false);
		expect(isReturnKey({ ...key, metaKey: true })).toBe(false);
		expect(isReturnKey({ ...key, key: "a", keyCode: 65 })).toBe(false);
	});

	test("copySummary says how long the text is and how it starts", () => {
		expect(copySummary("def foo():\n    return 1\n")).toBe("2 lines · def foo():");
		expect(copySummary("\n\n  x\ty  \n")).toBe("3 lines · x y");
		expect(copySummary("\x1b]0;evil\x07ok")).toBe("1 line · ]0;evil ok");
		expect(copySummary("a".repeat(100))).toBe(`1 line · ${"a".repeat(59)}…`);
		expect(copySummary("\n")).toBe("1 line");
	});
});
