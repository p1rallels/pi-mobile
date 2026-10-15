import { afterEach, describe, expect, test } from "bun:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PiWebRuntime } from "../src/session-runtime.ts";
import {
	applyProjectTrustChoice,
	parseProjectTrustMode,
	ProjectTrustRequiredError,
	projectTrustPrompt,
	resolveProjectTrust,
} from "../src/project-trust.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

const PROJECT_EXTENSION = `
export default function (pi) {
	pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("project", "project extension loaded"));
}
`;

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(withResources: boolean): Promise<string> {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-project-"));
	dirs.push(root);
	const cwd = join(root, "repo");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	if (withResources) {
		await mkdir(join(cwd, ".pi", "extensions"));
		await writeFile(join(cwd, ".pi", "extensions", "status.ts"), PROJECT_EXTENSION);
	}
	return cwd;
}

function memoryStore(initial: Record<string, boolean> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		get: (cwd: string) => data.get(cwd) ?? (data.get(dirname(cwd)) ?? null),
		setMany: (updates: Array<{ path: string; decision: boolean | null }>) => {
			for (const { path, decision } of updates) {
				if (decision === null) data.delete(path);
				else data.set(path, decision);
			}
		},
	};
}

describe("project trust rules", () => {
	test("only gates folders with protected resources and prefers saved decisions", async () => {
		const plain = await project(false);
		const gated = await project(true);
		expect(resolveProjectTrust(plain, memoryStore(), "ask")).toEqual({ trusted: true, gated: false, source: "no_resources" });
		expect(resolveProjectTrust(gated, memoryStore(), "ask")).toBeNull();
		expect(resolveProjectTrust(gated, memoryStore(), "always")).toEqual({ trusted: true, gated: true, source: "setting" });
		expect(resolveProjectTrust(gated, memoryStore({ [gated]: false }), "always")).toEqual({ trusted: false, gated: true, source: "saved" });
		expect(resolveProjectTrust(gated, memoryStore({ [dirname(gated)]: true }), "never")).toEqual({ trusted: true, gated: true, source: "saved" });
	});

	test("offers the cli's choices and saves only the remembered ones", async () => {
		const cwd = await project(true);
		expect(projectTrustPrompt(cwd).options.map((option) => option.choice)).toEqual(["trust", "trust_parent", "trust_session", "distrust", "distrust_session"]);

		const store = memoryStore({ [cwd]: false });
		expect(applyProjectTrustChoice(cwd, "trust_session", store)).toEqual({ trusted: true, gated: true, source: "session" });
		expect([...store.data]).toEqual([[cwd, false]]);
		applyProjectTrustChoice(cwd, "trust_parent", store);
		expect([...store.data]).toEqual([[dirname(cwd), true]]);
	});

	test("reads PI_WEB_PROJECT_TRUST", () => {
		expect(parseProjectTrustMode(undefined)).toBe("always");
		expect(parseProjectTrustMode(" Ask ")).toBe("ask");
		expect(() => parseProjectTrustMode("sometimes")).toThrow("PI_WEB_PROJECT_TRUST");
	});
});

describe("project trust in sessions", () => {
	test("loads project resources without asking by default", async () => {
		const cwd = await project(true);
		const { runtime, sessionId, clientId } = await startFauxSession([], { cwd });
		const { init } = runtime.connectClient(sessionId, { connectionId: "c", clientId: "c", send() {}, close() {} });
		expect(init.state.projectTrust).toEqual({ trusted: true, gated: true, source: "setting" });
		expect(init.ui.statuses).toEqual({ project: "project extension loaded" });
		await runtime.release(sessionId, { clientId });
	});

	test("asks in ask mode, then honours the answer and the saved decision", async () => {
		const cwd = await project(true);
		const { runtime: always, sessionId: first, clientId, agentDir, modelRuntime } = await startFauxSession([], { cwd });
		await always.release(first, { clientId });

		const runtime = new PiWebRuntime({ modelRuntime, projectTrustMode: "ask" });
		const error = await runtime.startSession({ cwd, clientId }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ProjectTrustRequiredError);
		expect((error as ProjectTrustRequiredError).prompt.cwd).toBe(cwd);

		const sessionOnly = await runtime.startSession({ cwd, clientId, projectTrust: "trust_session" });
		expect(runtime.getSessionState(sessionOnly.sessionId).projectTrust).toEqual({ trusted: true, gated: true, source: "session" });
		await runtime.release(sessionOnly.sessionId, { clientId });

		const declined = await runtime.startSession({ cwd, clientId, projectTrust: "distrust" });
		const { init } = runtime.connectClient(declined.sessionId, { connectionId: "c", clientId: "c", send() {}, close() {} });
		expect(init.state.projectTrust).toEqual({ trusted: false, gated: true, source: "saved" });
		expect(init.ui.statuses).toEqual({});
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(false);
		expect(JSON.parse(await readFile(join(agentDir, "trust.json"), "utf8"))).toEqual({ [cwd]: false });
		await runtime.release(declined.sessionId, { clientId });

		const again = await runtime.startSession({ cwd, clientId });
		expect(runtime.getSessionState(again.sessionId).projectTrust.source).toBe("saved");
		await runtime.release(again.sessionId, { clientId });
	});

	test("re-attaches a session with the trust it ran with instead of asking again", async () => {
		const cwd = await project(true);
		const { modelRuntime, faux, runtime: setup, sessionId: setupId, clientId } = await startFauxSession([], { cwd });
		await setup.release(setupId, { clientId });

		const runtime = new PiWebRuntime({ modelRuntime, projectTrustMode: "ask" });
		const { sessionId } = await runtime.startSession({ cwd, clientId, projectTrust: "trust_session" });
		faux.setResponses([fauxAssistantMessage("persisted")]);
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hi" });
		await waitFor(() => runtime.getSessionState(sessionId).messages.length === 2 && !runtime.getSessionState(sessionId).isStreaming);
		const sessionFile = runtime.getSessionState(sessionId).sessionFile;
		expect(sessionFile).not.toBeNull();
		await runtime.shutdown(1_000);

		const restarted = new PiWebRuntime({ modelRuntime, projectTrustMode: "ask" });
		await restarted.loadDetachedSessions();
		await restarted.attachSession(sessionId, sessionFile!, clientId);
		expect(restarted.getSessionState(sessionId).projectTrust).toEqual({ trusted: true, gated: true, source: "restored" });
		await restarted.shutdown(1_000);
	});
});
