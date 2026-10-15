import { fauxProvider, type FauxProviderHandle, type FauxResponseStep, type RegisterFauxProviderOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiWebRuntime } from "../../src/session-runtime.ts";
import type { SseEvent } from "../../src/types.ts";

export interface FauxSession {
	runtime: PiWebRuntime;
	sessionId: string;
	clientId: string;
	events: SseEvent[];
	frames: SseFrame[];
	faux: FauxProviderHandle;
	modelRuntime: ModelRuntime;
	agentDir: string;
}

export interface SseFrame {
	event: SseEvent;
	id?: string;
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

export async function makeAgentDir(settings: Record<string, unknown> = {}): Promise<string> {
	const root = await realpath(tmpdir());
	const dir = await mkdtemp(join(root, "pi-web-runtime-"));
	tempDirs.push(dir);
	const agentDir = join(dir, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { maxRetries: 1, baseDelayMs: 1 }, ...settings }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return agentDir;
}

export async function cleanupAgentDirs(): Promise<void> {
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

type RuntimeOptions = Omit<NonNullable<ConstructorParameters<typeof PiWebRuntime>[0]>, "modelRuntime">;

export async function startFauxSession(
	responses: FauxResponseStep[] = [],
	options: {
		settings?: Record<string, unknown>;
		runtime?: RuntimeOptions;
		faux?: RegisterFauxProviderOptions;
		/** Extension sources by file name, loaded like ~/.pi/agent/extensions. */
		extensions?: Record<string, string>;
		cwd?: string;
	} = {},
): Promise<FauxSession> {
	const agentDir = await makeAgentDir(options.settings);
	if (options.extensions) {
		await mkdir(join(agentDir, "extensions"), { recursive: true });
		await Promise.all(Object.entries(options.extensions).map(([name, source]) => writeFile(join(agentDir, "extensions", name), source)));
	}
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const faux = fauxProvider(options.faux);
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-key");
	faux.setResponses(responses);

	const runtime = new PiWebRuntime({ ...options.runtime, modelRuntime });
	const cwd = options.cwd ?? process.cwd();
	await runtime.addRepo(cwd);
	const clientId = "client-1";
	const { sessionId } = await runtime.startSession({ cwd, clientId });
	const events: SseEvent[] = [];
	const frames: SseFrame[] = [];
	const send = (event: SseEvent, id?: string) => {
		events.push(event);
		frames.push({ event, id });
	};
	runtime.addClient(sessionId, { connectionId: "connection-1", clientId, send, close() {} });
	return { runtime, sessionId, clientId, events, frames, faux, modelRuntime, agentDir };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export function agentEventTypes(events: SseEvent[]): string[] {
	return events.flatMap((event) => (event.type === "agent_event" ? [event.event.type] : []));
}
