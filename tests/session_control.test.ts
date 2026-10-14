import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { SseEvent } from "../src/types.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

const GRACE_MS = 20;

function controllerChanges(events: SseEvent[]): Array<string | null> {
	return events.flatMap((event) => (event.type === "controller_changed" ? [event.controllerClientId] : []));
}

function stalled(): { release: () => void; step: FauxResponseStep } {
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		release,
		step: async () => {
			await released;
			return fauxAssistantMessage("late");
		},
	};
}

describe("session control", () => {
	test("hands control to a remaining viewer after the controller drops", async () => {
		const { runtime, sessionId } = await startFauxSession([], { runtime: { controllerGraceMs: GRACE_MS } });
		const laptopEvents: SseEvent[] = [];
		runtime.addClient(sessionId, { connectionId: "laptop-1", clientId: "laptop", send: (event) => laptopEvents.push(event), close() {} });

		runtime.removeClient(sessionId, "connection-1");
		expect(runtime.getSessionRole(sessionId, "laptop").role).toBe("viewer");
		await waitFor(() => controllerChanges(laptopEvents).includes("laptop"));
		expect(runtime.getSessionRole(sessionId, "laptop").role).toBe("controller");
	});

	test("keeps control when the controller reconnects within the grace period", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([], { runtime: { controllerGraceMs: GRACE_MS } });
		runtime.addClient(sessionId, { connectionId: "laptop-1", clientId: "laptop", send: () => {}, close() {} });

		runtime.removeClient(sessionId, "connection-1");
		runtime.addClient(sessionId, { connectionId: "connection-2", clientId, send: () => {}, close() {} });
		await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));

		expect(controllerChanges(events)).toEqual([]);
		expect(runtime.getSessionRole(sessionId, clientId).role).toBe("controller");
	});

	test("leaves control vacant with nobody watching and gives it to the next viewer", async () => {
		const { runtime, sessionId } = await startFauxSession([], { runtime: { controllerGraceMs: GRACE_MS } });
		runtime.removeClient(sessionId, "connection-1");
		await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
		expect(runtime.getSessionRole(sessionId, "anyone").controllerClientId).toBeNull();

		const role = runtime.addClient(sessionId, { connectionId: "tablet-1", clientId: "tablet", send: () => {}, close() {} });
		expect(role.role).toBe("controller");
	});

	test("lets viewers take over and abort while a run is streaming", async () => {
		const slow = stalled();
		const { runtime, sessionId, clientId, events } = await startFauxSession([slow.step]);
		runtime.addClient(sessionId, { connectionId: "laptop-1", clientId: "laptop", send: () => {}, close() {} });
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "long task" });
		expect(runtime.getSessionState(sessionId).isStreaming).toBe(true);

		await expect(runtime.handleCommand(sessionId, { type: "prompt", clientId: "laptop", text: "steer" })).rejects.toThrow("not_controller");
		runtime.takeover(sessionId, { clientId: "laptop" });
		expect(runtime.getSessionRole(sessionId, "laptop").role).toBe("controller");

		const abort = runtime.handleCommand(sessionId, { type: "abort", clientId });
		slow.release();
		await abort;
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		expect(runtime.getSessionState(sessionId).isStreaming).toBe(false);
	});
});
