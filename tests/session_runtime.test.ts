import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiWebRuntime } from "../src/session-runtime.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

async function makeAgentDir(): Promise<string> {
	const root = await realpath(tmpdir());
	const dir = await mkdtemp(join(root, "pi-web-runtime-"));
	tempDirs.push(dir);
	return join(dir, "agent");
}

afterEach(async () => {
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("session runtime", () => {
	test("starts a repo session with the current pi sdk resource loader", async () => {
		process.env.PI_CODING_AGENT_DIR = await makeAgentDir();
		const runtime = new PiWebRuntime();
		await runtime.addRepo(process.cwd());

		const started = await runtime.startSession({ cwd: process.cwd(), clientId: "client-1" });
		const state = runtime.getSessionState(started.sessionId);

		expect(state.sessionId).toBe(started.sessionId);
		expect(state.cwd).toBe(process.cwd());
		expect(state.isStreaming).toBe(false);
		expect(state.isCompacting).toBe(false);

		await runtime.release(started.sessionId, { clientId: "client-1" });
	});

	test("routes compact slash prompts through manual compaction", async () => {
		process.env.PI_CODING_AGENT_DIR = await makeAgentDir();
		const runtime = new PiWebRuntime();
		await runtime.addRepo(process.cwd());

		const started = await runtime.startSession({ cwd: process.cwd(), clientId: "client-1" });
		await expect(runtime.handleCommand(started.sessionId, { type: "prompt", clientId: "client-1", text: "/compact" })).rejects.toThrow(
			"Nothing to compact (no messages yet)",
		);
		expect(runtime.getSessionState(started.sessionId).isCompacting).toBe(false);

		await runtime.release(started.sessionId, { clientId: "client-1" });
	});

	test("does not compact only-kept recent context", async () => {
		process.env.PI_CODING_AGENT_DIR = await makeAgentDir();
		const runtime = new PiWebRuntime();
		await runtime.addRepo(process.cwd());

		const started = await runtime.startSession({ cwd: process.cwd(), clientId: "client-1" });
		const state = runtime.getSessionState(started.sessionId);
		state.messages.push(
			{ role: "user", content: [{ type: "text", text: "short prompt" }], timestamp: Date.now() },
			{ role: "assistant", content: [{ type: "text", text: "short answer" }], timestamp: Date.now(), provider: "test", model: "test", stopReason: "end_turn" },
		);
		await expect(runtime.handleCommand(started.sessionId, { type: "compact", clientId: "client-1" })).rejects.toThrow(
			"Nothing to compact yet",
		);

		await runtime.release(started.sessionId, { clientId: "client-1" });
	});
});
