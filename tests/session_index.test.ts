import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionIndex, sessionDirForCwd } from "../src/session-index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sessionsRoot(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-index-"));
	tempDirs.push(dir);
	return dir;
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function header(id: string, cwd: string) {
	return line({ type: "session", version: 3, id, timestamp: "2026-10-01T10:00:00.000Z", cwd });
}

function message(id: string, role: string, text: string, timestamp: string) {
	return line({ type: "message", id, parentId: null, timestamp, message: { role, content: [{ type: "text", text }], timestamp: Date.parse(timestamp) } });
}

function assistant(id: string, stopReason: string, timestamp: string, text = "ok") {
	const content = stopReason === "toolUse" ? [{ type: "toolCall", id: `call-${id}`, name: "bash", arguments: { command: "sleep 20" } }] : [{ type: "text", text }];
	return line({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "m", stopReason, timestamp: Date.parse(timestamp) },
	});
}

function toolResult(id: string, timestamp: string) {
	return line({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "toolResult", toolCallId: "call-x", toolName: "bash", content: [{ type: "text", text: "Command exited with code 137" }], isError: true, timestamp: Date.parse(timestamp) },
	});
}

async function writeSession(root: string, cwd: string, id: string, body: string): Promise<string> {
	const dir = sessionDirForCwd(root, cwd);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
	await writeFile(path, header(id, cwd) + body);
	return path;
}

describe("session index", () => {
	test("summarizes sessions and follows appends incrementally", async () => {
		const root = await sessionsRoot();
		const path = await writeSession(
			root,
			"/repo/a",
			"s1",
			line({ type: "message", id: "sys", parentId: null, timestamp: "2026-10-01T10:00:01.000Z", message: { role: "system", content: "x".repeat(2000) } }) +
				message("u1", "user", `  first\nquestion with a line separator \u2028 inside  `, "2026-10-01T10:00:02.000Z") +
				message("a1", "assistant", "answer", "2026-10-01T10:00:03.000Z"),
		);
		const index = createSessionIndex(root);

		const [summary] = await index.list();
		expect(summary).toEqual({
			path,
			id: "s1",
			cwd: "/repo/a",
			created: "2026-10-01T10:00:00.000Z",
			modified: "2026-10-01T10:00:03.000Z",
			messageCount: 3,
			firstMessage: "first question with a line separator inside",
			turn: "done",
			lastWrite: new Date((await stat(path)).mtimeMs).toISOString(),
		});

		await appendFile(path, line({ type: "session_info", id: "n1", parentId: "a1", timestamp: "2026-10-01T10:05:00.000Z", name: "Named" }));
		await appendFile(path, message("u2", "user", "later", "2026-10-01T10:06:00.000Z"));
		await appendFile(path, '{"type":"message","id":"partial"');

		const [updated] = await index.list();
		expect(updated?.name).toBe("Named");
		expect(updated?.messageCount).toBe(4);
		expect(updated?.modified).toBe("2026-10-01T10:06:00.000Z");
		expect(updated?.firstMessage).toBe(summary?.firstMessage);
	});

	test("rescans rewritten files, drops deleted ones and filters by cwd", async () => {
		const root = await sessionsRoot();
		const path = await writeSession(root, "/repo/a", "s1", message("u1", "user", "one", "2026-10-01T10:00:02.000Z") + message("a1", "assistant", "two", "2026-10-01T10:00:03.000Z"));
		await writeSession(root, "/repo/b", "s2", message("u1", "user", "other repo", "2026-10-01T11:00:00.000Z"));
		const index = createSessionIndex(root);

		expect((await index.list()).map((summary) => summary.id)).toEqual(["s2", "s1"]);
		expect((await index.list({ cwd: "/repo/a" })).map((summary) => summary.id)).toEqual(["s1"]);

		await writeFile(path, header("s1", "/repo/a") + message("u9", "user", "rewritten", "2026-10-01T12:00:00.000Z"));
		const [rewritten] = await index.list({ cwd: "/repo/a" });
		expect(rewritten?.firstMessage).toBe("rewritten");
		expect(rewritten?.messageCount).toBe(1);

		await rm(path);
		expect(await index.list({ cwd: "/repo/a" })).toEqual([]);
	});

	test("follows where the turn stands as messages are appended", async () => {
		const root = await sessionsRoot();
		const path = await writeSession(root, "/repo/turns", "s4", message("u1", "user", "count to 20", "2026-10-01T10:00:01.000Z"));
		const index = createSessionIndex(root);
		const turn = async () => (await index.summarize([path]))[0]?.turn;

		expect(await turn()).toBe("thinking");
		await appendFile(path, assistant("a1", "toolUse", "2026-10-01T10:00:02.000Z"));
		expect(await turn()).toBe("running_tools");
		await appendFile(path, toolResult("t1", "2026-10-01T10:00:03.000Z"));
		expect(await turn()).toBe("thinking");
		await appendFile(path, assistant("a2", "stop", "2026-10-01T10:00:04.000Z", "x".repeat(3000)));
		expect(await turn()).toBe("done");

		await appendFile(
			path,
			line({ type: "message", id: "b1", parentId: null, timestamp: "2026-10-01T10:00:05.000Z", message: { role: "bashExecution", command: "ls", output: "", exitCode: 0 } }) +
				line({ type: "session_info", id: "n1", parentId: null, timestamp: "2026-10-01T10:00:06.000Z", name: "named" }),
		);
		expect(await turn()).toBe("done");

		await appendFile(path, message("u2", "user", "again", "2026-10-01T10:01:00.000Z") + assistant("a3", "toolUse", "2026-10-01T10:01:01.000Z"));
		expect(await turn()).toBe("running_tools");
		await appendFile(path, assistant("a4", "aborted", "2026-10-01T10:01:02.000Z") + line({ type: "label", id: "l1", parentId: null, timestamp: "2026-10-01T10:01:03.000Z", targetId: "a4", label: "x" }));
		expect(await turn()).toBe("done");

		const fresh = createSessionIndex(root);
		expect((await fresh.summarize([path, path]))[0]?.turn).toBe("done");
		expect(await fresh.summarize([join(root, "missing.jsonl")])).toEqual([]);
	});

	test("reads the turn of a killed run from scratch", async () => {
		const root = await sessionsRoot();
		const path = await writeSession(
			root,
			"/repo/killed",
			"s5",
			message("u1", "user", "slow task", "2026-10-01T10:00:01.000Z") + assistant("a1", "toolUse", "2026-10-01T10:00:02.000Z") + toolResult("t1", "2026-10-01T10:00:03.000Z"),
		);
		const [summary] = await createSessionIndex(root).list({ cwd: "/repo/killed" });
		expect(summary?.path).toBe(path);
		expect(summary?.turn).toBe("thinking");
	});

	test("reads entries written by older pi versions with another key order", async () => {
		const root = await sessionsRoot();
		await writeSession(root, "/repo/old", "s3", line({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "legacy text" } }));
		const [legacy] = await createSessionIndex(root).list();
		expect(legacy?.firstMessage).toBe("legacy text");
		expect(legacy?.messageCount).toBe(1);
		expect(legacy?.modified).toBe("2026-01-01T00:00:00.000Z");
	});
});
