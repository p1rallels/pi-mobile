import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyNeverSaved } from "../src/never-saved.ts";
import { sessionDirForCwd } from "../src/session-index.ts";
import { NeverSavedError, PiWebRuntime } from "../src/session-runtime.ts";
import { cleanupAgentDirs, startFauxSession } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

const SESSIONS = "/home/me/.pi/agent/sessions";
const ID = "01a1410a-b6d4-7741-b541-08a5f154bad3";
const pathIn = (cwd: string, id = ID) => join(sessionDirForCwd(SESSIONS, cwd), `2026-10-15T19-29-43-636Z_${id}.jsonl`);
const nothingThere = () => false;

describe("classifyNeverSaved", () => {
	test("a session path with no file is never saved, in the folder whose session folder holds it", () => {
		const path = pathIn("/home/me/repo");
		const folders = ["/home/me/other", "/home/me/repo"];
		expect(classifyNeverSaved(path, { sessionsDir: SESSIONS, folders, exists: nothingThere })).toEqual({ neverSaved: true, cwd: "/home/me/repo" });
		expect(classifyNeverSaved(path, { sessionsDir: SESSIONS, folders, exists: nothingThere, sessionId: ID })).toEqual({ neverSaved: true, cwd: "/home/me/repo" });
	});

	test("a file that's there, another session's name, or a path that isn't a session file is not", () => {
		const path = pathIn("/home/me/repo");
		const folders = ["/home/me/repo"];
		expect(classifyNeverSaved(path, { sessionsDir: SESSIONS, folders, exists: () => true })).toBeNull();
		expect(classifyNeverSaved(path, { sessionsDir: SESSIONS, folders, exists: nothingThere, sessionId: "someone-else" })).toBeNull();
		expect(classifyNeverSaved(path.replace(".jsonl", ".json"), { sessionsDir: SESSIONS, folders, exists: nothingThere })).toBeNull();
		expect(classifyNeverSaved(join(SESSIONS, `x_${ID}.jsonl`), { sessionsDir: SESSIONS, folders, exists: nothingThere })).toBeNull();
		expect(classifyNeverSaved(join(SESSIONS, "a", "b", `x_${ID}.jsonl`), { sessionsDir: SESSIONS, folders, exists: nothingThere })).toBeNull();
	});

	test("the folder is unknown when none or several map to the session folder", () => {
		const path = pathIn("/home/me/a-b/c");
		expect(classifyNeverSaved(path, { sessionsDir: SESSIONS, folders: ["/home/me/elsewhere"], exists: nothingThere })).toEqual({ neverSaved: true, cwd: null });
		expect(classifyNeverSaved(path, { sessionsDir: SESSIONS, folders: ["/home/me/a-b/c", "/home/me/a/b-c", "/home/me/a-b/c"], exists: nothingThere })).toEqual({
			neverSaved: true,
			cwd: null,
		});
	});
});

describe("never-saved sessions in the runtime", () => {
	test("a session nobody messaged is gone after a restart: resume and attach say so, with its folder", async () => {
		const { runtime, sessionId, clientId, modelRuntime, agentDir } = await startFauxSession();
		const path = runtime.getSessionState(sessionId).sessionFile;
		expect(path).not.toBeNull();
		expect(existsSync(path!)).toBe(false);
		expect(await runtime.neverSaved(path!, sessionId)).toBeNull();

		await runtime.shutdown(1_000);
		const restarted = new PiWebRuntime({ modelRuntime });
		expect(await restarted.loadDetachedSessions()).toBe(0);
		const cwd = resolve(process.cwd());
		expect(await restarted.neverSaved(path!, sessionId)).toEqual({ neverSaved: true, cwd });
		expect(await restarted.neverSaved(path!, "someone-else")).toBeNull();
		expect(await restarted.neverSaved("/etc/passwd")).toBeNull();
		await expect(restarted.attachSession(sessionId, path!, clientId)).rejects.toThrow("session_not_attachable");
		const resumed = restarted.startSession({ resumeSessionPath: path!, clientId });
		await expect(resumed).rejects.toBeInstanceOf(NeverSavedError);
		await expect(resumed).rejects.toMatchObject({ cwd });
		expect(path!.startsWith(join(agentDir, "sessions"))).toBe(true);
	});

	test("a new session starts with the model and thinking level it's asked for, when they apply", async () => {
		const models = [
			{ id: "faux-a", reasoning: true },
			{ id: "faux-b", reasoning: true },
		];
		const { runtime, sessionId, clientId, faux } = await startFauxSession([], { faux: { models } });
		const provider = faux.models[0].provider;
		expect(runtime.getSessionState(sessionId).model?.id).toBe("faux-a");

		const { sessionId: asked } = await runtime.startSession({ cwd: process.cwd(), clientId, model: { provider, id: "faux-b" }, thinkingLevel: "high" });
		expect(runtime.getSessionState(asked).model).toMatchObject({ provider, id: "faux-b" });
		expect(runtime.getSessionState(asked).thinkingLevel).toBe("high");

		const { sessionId: unknown } = await runtime.startSession({ cwd: process.cwd(), clientId, model: { provider, id: "gone" }, thinkingLevel: "loud" });
		expect(runtime.getSessionState(unknown).model?.id).toBe("faux-a");
		expect(runtime.getSessionState(unknown).thinkingLevel).toBe(runtime.getSessionState(sessionId).thinkingLevel);

		await Promise.all([sessionId, asked, unknown].map((id) => runtime.release(id, { clientId })));
	});
});
