import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

describe("tripwire guard", () => {
	test("blocks a critical tool call before it runs and stops the run", async () => {
		const session = await startFauxSession();
		const marker = join(session.agentDir, "tripwire-marker");
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${marker} && ls ~/.ssh` }, { id: "call_secret" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("this turn must never be requested"),
		]);
		const { runtime, sessionId, clientId, events } = session;

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "look around" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));

		expect(existsSync(marker)).toBe(false);
		const alerts = events.flatMap((event) => (event.type === "tripwire_alert" ? [event.alert] : []));
		expect(alerts.map((alert) => [alert.category, alert.response])).toEqual([["secret_access", "blocked"]]);

		const result = events.find((event) => event.type === "agent_event" && event.event.type === "tool_execution_end");
		const text = result?.type === "agent_event" && result.event.type === "tool_execution_end" ? JSON.stringify(result.event.result) : "";
		expect(text).toContain("Blocked by the pi-web tripwire");
		expect(session.faux.getPendingResponseCount()).toBe(1);

		await runtime.release(sessionId, { clientId });
	});

	test("lets ordinary tool calls through", async () => {
		const session = await startFauxSession();
		const marker = join(session.agentDir, "ordinary-marker");
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${marker}` }, { id: "call_ok" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { runtime, sessionId, clientId, events } = session;
		await runtime.addRepo(session.agentDir);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "touch it" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));

		expect(existsSync(marker)).toBe(true);
		expect(events.some((event) => event.type === "tripwire_alert" && event.alert.response === "blocked")).toBe(false);
		await runtime.release(sessionId, { clientId });
	});
});
