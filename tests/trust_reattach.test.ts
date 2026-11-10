// Re-attaching a detached session under PI_WEB_PROJECT_TRUST=ask (src/project-trust.ts, src/session-runtime.ts): only
// the session's own answer comes back. "No resources" was never an approval, so an extension added since asks first,
// on every path that reopens a detached session (attach, msg mail, a parent its subs wait on). Real runtimes, faux
// sessions, a restart in between (the detached record goes through detached-sessions.json).
import { afterEach, describe, expect, test } from "bun:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detachedProjectTrust,
	ProjectTrustRequiredError,
	restoredProjectTrust,
	type ApiProjectTrust,
	type ApiProjectTrustSource,
	type ProjectTrustMode,
} from "../src/project-trust.ts";
import { PiWebRuntime } from "../src/session-runtime.ts";
import { cleanupAgentDirs, startFauxSession, waitFor, type FauxSession } from "./support/faux_runtime.ts";

const SUB = "01a155b1-0000-7000-8000-0000000000c1";
// above any pid macOS hands out: the waiting rule only reads the sub's record
const DEAD_PID = 999_999;

const roots: string[] = [];
const runtimes: PiWebRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown(1_000)));
	await cleanupAgentDirs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Project {
	cwd: string;
	/** Written (outside the project) when pi-web loads the project's extension. */
	marker: string;
}

async function emptyProject(): Promise<Project> {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-reattach-"));
	roots.push(root);
	const cwd = join(root, "repo");
	await mkdir(cwd);
	return { cwd, marker: join(root, "extension-ran") };
}

/** What a pull could bring in: a project extension, harmless here, that leaves the marker when it loads. */
async function addExtension({ cwd, marker }: Project): Promise<void> {
	await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
	const source = `import { writeFileSync } from "node:fs";\nexport default function () {\n\twriteFileSync(${JSON.stringify(marker)}, "ran");\n}\n`;
	await writeFile(join(cwd, ".pi", "extensions", "marker.ts"), source);
}

const ASK = { projectTrustMode: "ask", listPiProcesses: async () => [] } as const;

/** An ask-mode runtime with a session in the (still empty) project: nothing to approve, so it starts without asking. */
async function askRuntime(project: Project, lines: string[] = []): Promise<FauxSession> {
	const session = await startFauxSession([], { cwd: project.cwd, runtime: { ...ASK, log: (line) => lines.push(line) } });
	runtimes.push(session.runtime);
	return session;
}

/** Sends a prompt and waits until the answer is saved: only a saved session can be detached and re-attached. */
async function persist(session: FauxSession, sessionId: string): Promise<string> {
	const { runtime } = session;
	session.faux.setResponses([fauxAssistantMessage("saved")]);
	await runtime.handleCommand(sessionId, { type: "prompt", clientId: session.clientId, text: "hi" });
	await waitFor(() => {
		const state = runtime.getSessionState(sessionId);
		return !state.isStreaming && state.messages.length === 2 && state.sessionFile !== null && runtime.getHealth().busySessions === 0;
	});
	const path = runtime.getSessionState(sessionId).sessionFile;
	if (!path) throw new Error("the session was never saved");
	return path;
}

/** The project gets an extension and the session is approved for this session only, the way the page answers the prompt. */
async function approvedForSession(project: Project, session: FauxSession): Promise<{ sessionId: string; path: string }> {
	await session.runtime.release(session.sessionId, { clientId: session.clientId });
	await addExtension(project);
	const { sessionId } = await session.runtime.startSession({ cwd: project.cwd, clientId: session.clientId, projectTrust: "trust_session" });
	expect(session.runtime.getSessionState(sessionId).projectTrust).toEqual({ trusted: true, gated: true, source: "session" });
	expect(existsSync(project.marker)).toBe(true);
	return { sessionId, path: await persist(session, sessionId) };
}

/** pi-web after a restart: the re-attach records the old one wrote at shutdown, loaded. */
async function restarted(session: FauxSession, mode: ProjectTrustMode = "ask", lines: string[] = []): Promise<PiWebRuntime> {
	const runtime = new PiWebRuntime({ modelRuntime: session.modelRuntime, projectTrustMode: mode, listPiProcesses: async () => [], log: (line) => lines.push(line) });
	runtimes.push(runtime);
	expect(await runtime.loadDetachedSessions()).toBe(1);
	return runtime;
}

type Outcome = ApiProjectTrust | "project_trust_required";

async function attach(runtime: PiWebRuntime, sessionId: string, path: string, clientId: string): Promise<Outcome> {
	try {
		await runtime.attachSession(sessionId, path, clientId);
	} catch (error) {
		if (error instanceof ProjectTrustRequiredError) return "project_trust_required";
		throw error;
	}
	return runtime.getSessionState(sessionId).projectTrust;
}

function detachedStore(agentDir: string): string {
	return join(agentDir, "pi-web", "detached-sessions.json");
}

describe("re-attach in ask mode", () => {
	test("an empty project's session asks once an extension appeared, and the extension doesn't run until it's answered", async () => {
		const project = await emptyProject();
		const session = await askRuntime(project);
		const { sessionId, clientId } = session;
		expect(session.runtime.getSessionState(sessionId).projectTrust).toEqual({ trusted: true, gated: false, source: "no_resources" });
		const path = await persist(session, sessionId);
		await session.runtime.shutdown(1_000);

		await addExtension(project);
		const runtime = await restarted(session);
		const outcome = await attach(runtime, sessionId, path, clientId);
		expect({ outcome, extensionRan: existsSync(project.marker) }).toEqual({ outcome: "project_trust_required", extensionRan: false });
		expect(runtime.isRunning(sessionId)).toBe(false);

		// the page answers the prompt by resuming with the choice: the session is still there
		await runtime.startSession({ resumeSessionPath: path, clientId, projectTrust: "trust_session" });
		expect(runtime.getSessionState(sessionId).projectTrust).toEqual({ trusted: true, gated: true, source: "session" });
		expect(existsSync(project.marker)).toBe(true);
	});

	test("a session approved for this session only comes back approved without asking, restart after restart", async () => {
		const project = await emptyProject();
		const session = await askRuntime(project);
		const { sessionId, path } = await approvedForSession(project, session);
		await session.runtime.shutdown(1_000);

		await rm(project.marker);
		const runtime = await restarted(session);
		expect(await attach(runtime, sessionId, path, session.clientId)).toEqual({ trusted: true, gated: true, source: "restored" });
		expect(existsSync(project.marker)).toBe(true);
		await runtime.shutdown(1_000);

		await rm(project.marker);
		const again = await restarted(session);
		expect(await attach(again, sessionId, path, session.clientId)).toEqual({ trusted: true, gated: true, source: "restored" });
		expect(existsSync(project.marker)).toBe(true);
	});

	test("a record from before pi-web kept the decision's provenance (only projectTrusted: true) restores no approval", async () => {
		const project = await emptyProject();
		const session = await askRuntime(project);
		const path = await persist(session, session.sessionId);
		await session.runtime.shutdown(1_000);
		const store = detachedStore(session.agentDir);
		const records = JSON.parse(await readFile(store, "utf8")) as Array<Record<string, unknown>>;
		const legacy = records.map(({ projectTrust: _, ...record }) => ({ ...record, projectTrusted: true }));
		await writeFile(store, JSON.stringify(legacy), { mode: 0o600 });

		await addExtension(project);
		const runtime = await restarted(session);
		expect(await attach(runtime, session.sessionId, path, session.clientId)).toBe("project_trust_required");
		expect(existsSync(project.marker)).toBe(false);
	});

	test("a denial saved after the detach, then never and always, come before the session's own answer", async () => {
		const project = await emptyProject();
		const session = await askRuntime(project);
		const { sessionId, path } = await approvedForSession(project, session);
		await session.runtime.shutdown(1_000);
		await rm(project.marker);

		new ProjectTrustStore(session.agentDir).set(project.cwd, false);
		const denied = await restarted(session);
		expect(await attach(denied, sessionId, path, session.clientId)).toEqual({ trusted: false, gated: true, source: "saved" });
		expect(existsSync(project.marker)).toBe(false);
		await denied.shutdown(1_000);

		new ProjectTrustStore(session.agentDir).set(project.cwd, null);
		const never = await restarted(session, "never");
		expect(await attach(never, sessionId, path, session.clientId)).toEqual({ trusted: false, gated: true, source: "setting" });
		expect(existsSync(project.marker)).toBe(false);
		await never.shutdown(1_000);

		const always = await restarted(session, "always");
		expect(await attach(always, sessionId, path, session.clientId)).toEqual({ trusted: true, gated: true, source: "setting" });
		expect(existsSync(project.marker)).toBe(true);
	});

	test("msg mail reopening an empty project's session asks once an extension appeared", async () => {
		const project = await emptyProject();
		const session = await askRuntime(project);
		const path = await persist(session, session.sessionId);
		await session.runtime.shutdown(1_000);

		await addExtension(project);
		const runtime = await restarted(session);
		const reopen = runtime.reopenForMail(session.sessionId, path, null);
		expect(reopen).not.toBeNull();
		expect(await reopen?.running.then(() => "reopened", (error: unknown) => error)).toBeInstanceOf(ProjectTrustRequiredError);
		expect(existsSync(project.marker)).toBe(false);
		expect(runtime.isRunning(session.sessionId)).toBe(false);
	});

	test("a parent its subs wait on, in an empty project that got an extension, isn't reopened without an answer", async () => {
		const project = await emptyProject();
		const session = await askRuntime(project);
		await persist(session, session.sessionId);
		await session.runtime.shutdown(1_000);

		await addExtension(project);
		const presence = join(session.agentDir, "msg", "sessions");
		await mkdir(presence, { recursive: true });
		const record = { v: 1, id: SUB, parent: session.sessionId, cwd: project.cwd, mode: "print", activity: "busy", pid: DEAD_PID, startedAt: Date.now() - 60_000, heartbeatAt: Date.now() };
		await writeFile(join(presence, `.${SUB}.tmp`), `${JSON.stringify(record)}\n`);
		await rename(join(presence, `.${SUB}.tmp`), join(presence, `${SUB}.json`));

		const lines: string[] = [];
		const runtime = await restarted(session, "ask", lines);
		expect((await runtime.sweep()).reopened).toEqual([]);
		expect(lines).toEqual([`[pi-web] could not reopen ${session.sessionId} for its subs: project_trust_required`]);
		expect(existsSync(project.marker)).toBe(false);
		expect(runtime.isRunning(session.sessionId)).toBe(false);
	});
});

describe("what a detached record restores", () => {
	const decision = (trusted: boolean, gated: boolean, source: ApiProjectTrustSource): ApiProjectTrust => ({ trusted, gated, source });
	const restored = (trusted: boolean): ApiProjectTrust => ({ trusted, gated: true, source: "restored" });

	test("the session's own answer and any denial come back; no approval nobody gave", () => {
		expect(restoredProjectTrust(undefined)).toBeUndefined();
		expect(restoredProjectTrust(decision(true, false, "no_resources"))).toBeUndefined();
		expect(restoredProjectTrust(decision(true, true, "session"))).toEqual(restored(true));
		expect(restoredProjectTrust(decision(true, true, "restored"))).toEqual(restored(true));
		expect(restoredProjectTrust(decision(false, true, "session"))).toEqual(restored(false));
		expect(restoredProjectTrust(decision(false, true, "restored"))).toEqual(restored(false));
		// a saved approval or "always" that no longer applies is no answer; their denials still hold
		expect(restoredProjectTrust(decision(true, true, "saved"))).toBeUndefined();
		expect(restoredProjectTrust(decision(true, true, "setting"))).toBeUndefined();
		expect(restoredProjectTrust(decision(false, true, "saved"))).toEqual(restored(false));
		expect(restoredProjectTrust(decision(false, true, "setting"))).toEqual(restored(false));
	});

	test("reads the decision a record kept, and of an older boolean-only record only a denial", () => {
		expect(detachedProjectTrust({ projectTrust: decision(true, true, "session") })).toEqual(decision(true, true, "session"));
		expect(detachedProjectTrust({ projectTrust: decision(true, false, "no_resources"), projectTrusted: true })).toEqual(decision(true, false, "no_resources"));
		expect(detachedProjectTrust({ projectTrusted: true })).toBeUndefined();
		expect(detachedProjectTrust({ projectTrusted: false })).toEqual(restored(false));
		expect(detachedProjectTrust({})).toBeUndefined();
		for (const projectTrust of [null, true, "session", { trusted: true, gated: true }, { trusted: true, gated: true, source: "always" }, { trusted: "yes", gated: true, source: "session" }]) {
			expect(detachedProjectTrust({ projectTrust, projectTrusted: false })).toBeUndefined();
		}
	});
});
