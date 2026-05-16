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
});
