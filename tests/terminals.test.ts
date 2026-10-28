import { afterEach, expect, test } from "bun:test";
import { createTerminalManager, type TerminalPeer } from "../src/terminals.ts";

const managers: ReturnType<typeof createTerminalManager>[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.shutdown();
	delete process.env.PIWEB_TEST_BEFORE_BOOT;
	delete process.env.PIWEB_TEST_AFTER_BOOT;
});

/** A websocket stand-in that keeps everything the shell shows: the snapshot, then the live bytes. */
function capturePeer() {
	const decoder = new TextDecoder();
	let screen = "";
	const peer: TerminalPeer = {
		sendText(data) {
			const message = JSON.parse(data) as { type: string; data?: string };
			if (message.type === "snapshot" && message.data) screen += message.data;
			return data.length;
		},
		sendBinary(data) {
			screen += decoder.decode(data, { stream: true });
			return data.length;
		},
		close() {},
	};
	return { peer, screen: () => screen };
}

async function waitFor(read: () => string, pattern: RegExp, timeoutMs = 8_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const match = pattern.exec(read());
		if (match) return match[0];
		await Bun.sleep(25);
	}
	throw new Error(`never saw ${String(pattern)} in:\n${read()}`);
}

test("a shell gets the env the server started with, not what was written into process.env since", async () => {
	process.env.PIWEB_TEST_BEFORE_BOOT = "present";
	const manager = createTerminalManager({ shell: "/bin/sh", log: () => {} });
	managers.push(manager);
	// what op_load does in a session: every later shell would inherit it
	process.env.PIWEB_TEST_AFTER_BOOT = "leaked";

	const info = manager.create({ expiresAt: null, openedBy: "test" });
	const { peer, screen } = capturePeer();
	expect(manager.attach(info.id, peer, {})).toBe(true);
	manager.handleMessage(info.id, JSON.stringify({ type: "input", data: 'echo "before=[$PIWEB_TEST_BEFORE_BOOT] after=[${PIWEB_TEST_AFTER_BOOT:-unset}]"\r' }));

	// the echoed command line has $ and { in the brackets, so only the expanded output matches
	expect(await waitFor(screen, /before=\[\w+\] after=\[\w+\]/)).toBe("before=[present] after=[unset]");
}, 15_000);
