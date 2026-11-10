import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TripwireService, toolPathArgs } from "../src/tripwire.ts";
import type { PiWebRuntime } from "../src/session-runtime.ts";
import type { SseEvent } from "../src/types.ts";
import { agentEventTypes, cleanupAgentDirs, makeAgentDir, startFauxSession, waitFor } from "./support/faux_runtime.ts";

const originalCwd = process.cwd();
const folders: string[] = [];

async function folder(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
	folders.push(dir);
	return dir;
}

afterEach(async () => {
	process.chdir(originalCwd);
	await cleanupAgentDirs();
	await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function alertsOf(events: SseEvent[]) {
	return events.flatMap((event) => (event.type === "tripwire_alert" ? [event.alert] : []));
}

const settled = (events: SseEvent[]) => () => agentEventTypes(events).includes("agent_settled");

/** Alerts are stored after the call they're about, unawaited: read them back (also proving they were kept) before the folders go. */
async function finish(runtime: PiWebRuntime, sessionId: string, clientId: string, events: SseEvent[]): Promise<void> {
	const stored = await runtime.getTripwireAlerts(sessionId, `${clientId}-check`);
	expect(stored.alerts.map((alert) => alert.id)).toEqual(alertsOf(events).map((alert) => alert.id));
	await runtime.release(sessionId, { clientId });
}

describe("the agent dir's config", () => {
	test("writes to models.json, extensions/ and settings.json are logged as persistence and go through", async () => {
		const repo = await folder("pi-web-repo-");
		const session = await startFauxSession([], { cwd: repo });
		const { agentDir, runtime, sessionId, clientId, events } = session;
		const settings = JSON.stringify({ retry: { maxRetries: 1, baseDelayMs: 1 } });
		const writes = [
			{ path: join(agentDir, "models.json"), content: '{"providers":{}}' },
			{ path: join(agentDir, "extensions", "x.ts"), content: "export default function () {}\n" },
			{ path: join(agentDir, "settings.json"), content: settings },
		];
		session.faux.setResponses([
			fauxAssistantMessage(
				writes.map((args, index) => fauxToolCall("write", args, { id: `call_${String(index)}` })),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "set it up" });
		await waitFor(settled(events));

		const alerts = alertsOf(events);
		expect(alerts.map((alert) => [alert.category, alert.severity, alert.response])).toEqual(writes.map(() => ["persistence", "observe", "logged"]));
		for (const { path } of writes) expect(alerts.some((alert) => alert.detail?.includes(path))).toBe(true);
		for (const { path, content } of writes) expect(await readFile(path, "utf8")).toBe(content);
		expect(session.faux.getPendingResponseCount()).toBe(0);
		await finish(runtime, sessionId, clientId, events);
	});

	test("a bash command naming mcp.json is logged as persistence and runs", async () => {
		const repo = await folder("pi-web-repo-");
		const session = await startFauxSession([], { cwd: repo });
		const { agentDir, runtime, sessionId, clientId, events } = session;
		const target = join(agentDir, "mcp.json");
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: `printf '{}' > ${target}` }, { id: "call_mcp" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "add a server" });
		await waitFor(settled(events));

		const alerts = alertsOf(events);
		expect(alerts.map((alert) => [alert.category, alert.severity, alert.response])).toEqual([["persistence", "observe", "logged"]]);
		expect(alerts[0]?.detail).toContain(target);
		expect(await readFile(target, "utf8")).toBe("{}");
		await finish(runtime, sessionId, clientId, events);
	});

	test("auth.json stays a secret: critical and blocked", async () => {
		const repo = await folder("pi-web-repo-");
		const session = await startFauxSession([], { cwd: repo });
		const { agentDir, runtime, sessionId, clientId, events } = session;
		const auth = join(agentDir, "auth.json");
		const before = existsSync(auth) ? await readFile(auth, "utf8") : null;
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: auth, content: "planted" }, { id: "call_auth" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("this turn must never be requested"),
		]);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "reset auth" });
		await waitFor(settled(events));

		expect(alertsOf(events).map((alert) => [alert.category, alert.severity, alert.response])).toEqual([["secret_access", "critical", "blocked"]]);
		expect(existsSync(auth) ? await readFile(auth, "utf8") : null).toBe(before);
		await finish(runtime, sessionId, clientId, events);
	});
});

describe("agent config paths (service)", () => {
	async function service(): Promise<{ tripwire: TripwireService; agentDir: string; repo: string }> {
		const agentDir = await makeAgentDir();
		const repo = await folder("pi-web-repo-");
		return { tripwire: new TripwireService(join(agentDir, "pi-web", "tripwire-state.json")), agentDir, repo };
	}

	test("every config file and folder a future session runs or reads into its prompt alerts on edit", async () => {
		const { tripwire, agentDir, repo } = await service();
		const context = { sessionId: "s", cwd: repo, allowedRoots: [repo] };
		const targets = [
			"models.json",
			"settings.json",
			"mcp.json",
			"trust.json",
			"AGENTS.md",
			"AGENTS.override.md",
			"CLAUDE.md",
			"SYSTEM.md",
			"APPEND_SYSTEM.md",
			"extensions/x/index.ts",
			"skills/x/SKILL.md",
			"prompts/x.md",
			"npm/node_modules/x/index.js",
			"git/github.com/x/y/index.ts",
			"bin/rg",
		];
		for (const target of targets) {
			const inspection = tripwire.inspectToolCall(context, "edit", "c", { path: join(agentDir, target), edits: [] });
			expect([target, inspection.shouldBlock, inspection.alerts.map((alert) => [alert.category, alert.severity])]).toEqual([target, false, [["persistence", "observe"]]]);
		}
	});

	test("reads of the config and writes to the rest of the agent dir stay quiet", async () => {
		const { tripwire, agentDir, repo } = await service();
		const context = { sessionId: "s", cwd: repo, allowedRoots: [repo] };
		expect(tripwire.inspectToolCall(context, "read", "c", { path: join(agentDir, "settings.json") }).alerts).toEqual([]);
		expect(tripwire.inspectToolCall(context, "grep", "c", { pattern: "x", path: join(agentDir, "skills") }).alerts).toEqual([]);
		expect(tripwire.inspectToolCall(context, "write", "c", { path: join(agentDir, "notes.md"), content: "" }).alerts).toEqual([]);
		expect(tripwire.inspectToolCall(context, "bash", "c", { command: `ls ${join(agentDir, "sessions")}` }).alerts).toEqual([]);
	});

	test("a symlink in the repo pointing at the config is followed", async () => {
		const { tripwire, agentDir, repo } = await service();
		await mkdir(join(agentDir, "extensions"), { recursive: true });
		await symlink(join(agentDir, "extensions"), join(repo, "ext"));
		const inspection = tripwire.inspectToolCall({ sessionId: "s", cwd: repo, allowedRoots: [repo] }, "write", "c", { path: "ext/x.ts", content: "" });
		expect(inspection.alerts.map((alert) => [alert.category, alert.severity])).toEqual([["persistence", "observe"]]);
	});
});

describe("custom and MCP tools' path arguments", () => {
	test("come from the SDK's keys, their snake_case, file_path and the MCP filesystem server's, nothing else", () => {
		expect(toolPathArgs("mcp__fs__move_file", { source: "a", destination: "b", content: "c" })).toEqual(["a", "b"]);
		expect(toolPathArgs("x", { file_path: "a", filePath: "b", old_path: "c", new_path: "d", target_path: "e" })).toEqual(["a", "b", "c", "d", "e"]);
		expect(toolPathArgs("x", { path: "a", oldPath: "b", newPath: "c", targetPath: "d", from: "e", to: "f" })).toEqual(["a", "e", "f", "b", "c", "d"]);
		expect(toolPathArgs("mcp__fs__read_multiple_files", { paths: ["a", 1, "b"] })).toEqual(["a", "b"]);
		expect(toolPathArgs("x", { filename: "a", dir: "b", file_path: 3 })).toEqual([]);
		expect(toolPathArgs("read", { path: "a", file_path: "b" })).toEqual(["a"]);
		expect(toolPathArgs("grep", { pattern: "x" })).toEqual(["."]);
	});

	test("each spelling of a path argument reaches the secret check", async () => {
		const agentDir = await makeAgentDir();
		const repo = await folder("pi-web-repo-");
		const tripwire = new TripwireService(join(agentDir, "pi-web", "tripwire-state.json"));
		const secret = join(agentDir, "auth.json");
		const spellings: Record<string, unknown>[] = [
			{ file_path: secret },
			{ filePath: secret },
			{ old_path: secret },
			{ new_path: secret },
			{ target_path: secret },
			{ source: secret, destination: join(repo, "a") },
			{ source: join(repo, "a"), destination: secret },
			{ paths: [join(repo, "a"), secret] },
		];
		for (const input of spellings) {
			const inspection = tripwire.inspectToolCall({ sessionId: "s", cwd: repo, allowedRoots: [repo] }, "mcp__fs__tool", "c", input);
			expect([input, inspection.shouldBlock, inspection.alerts.map((alert) => alert.category)]).toEqual([input, true, ["secret_access"]]);
		}
	});

	test("an extension tool called with { file_path: <a secret> } is blocked before it runs", async () => {
		const repo = await folder("pi-web-repo-");
		const marker = join(repo, "peek-ran");
		const extension = `
import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.registerTool({
		name: "peek",
		label: "peek",
		description: "Shows a file.",
		parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
		async execute() {
			writeFileSync(${JSON.stringify(marker)}, "ran");
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	});
}
`;
		const session = await startFauxSession([], { cwd: repo, extensions: { "peek.ts": extension } });
		const { agentDir, runtime, sessionId, clientId, events } = session;
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("peek", { file_path: join(agentDir, "auth.json") }, { id: "call_peek" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("this turn must never be requested"),
		]);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "peek" });
		await waitFor(settled(events));

		expect(alertsOf(events).map((alert) => [alert.category, alert.response])).toEqual([["secret_access", "blocked"]]);
		expect(existsSync(marker)).toBe(false);
		await finish(runtime, sessionId, clientId, events);
	});
});

describe("the server's own checkout", () => {
	test("is no root for a session in another repo, but is for a session in it", async () => {
		const server = await folder("pi-web-server-");
		const repoA = await folder("pi-web-repo-");
		await mkdir(join(server, "src"), { recursive: true });
		process.chdir(server);

		const session = await startFauxSession([], { cwd: repoA });
		const { runtime, sessionId, clientId, events } = session;
		const planted = join(server, "src", "server.ts");
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: planted, content: "pwned" }, { id: "call_plant" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("this turn must never be requested"),
		]);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "plant it" });
		await waitFor(settled(events));

		expect(alertsOf(events).map((alert) => [alert.category, alert.response])).toEqual([["repo_escape", "blocked"]]);
		expect(existsSync(planted)).toBe(false);
		await finish(runtime, sessionId, clientId, events);

		// listed, never saved: the server's checkout is a folder sessions may start in, and their own root
		expect((await runtime.listRepos()).includes(server)).toBe(true);
		const own = await runtime.startSession({ cwd: server, clientId });
		const ownEvents: SseEvent[] = [];
		runtime.addClient(own.sessionId, { connectionId: "connection-own", clientId, send: (event) => ownEvents.push(event), close() {} });
		const edited = join(server, "src", "own.ts");
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: edited, content: "fine" }, { id: "call_own" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await runtime.handleCommand(own.sessionId, { type: "prompt", clientId, text: "edit it" });
		await waitFor(settled(ownEvents));

		expect(alertsOf(ownEvents)).toEqual([]);
		expect(await readFile(edited, "utf8")).toBe("fine");
		await finish(runtime, own.sessionId, clientId, ownEvents);
	});
});
