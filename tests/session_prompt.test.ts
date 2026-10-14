import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

function gate(): { open: () => void; step: FauxResponseStep } {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return {
		open,
		step: async () => {
			await opened;
			return fauxAssistantMessage("finally done");
		},
	};
}

describe("prompt command", () => {
	test("acknowledges once the run starts instead of when it finishes", async () => {
		const slow = gate();
		const { runtime, sessionId, clientId, events } = await startFauxSession([slow.step]);

		const result = await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "take your time" });

		expect(result).toEqual({ ok: true, disposition: "started" });
		expect(runtime.getSessionState(sessionId).isStreaming).toBe(true);
		expect(agentEventTypes(events)).not.toContain("agent_settled");

		slow.open();
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		await runtime.release(sessionId, { clientId });
	});

	test("reports prompts sent during a run as queued", async () => {
		const slow = gate();
		const { runtime, sessionId, clientId, events } = await startFauxSession([slow.step, fauxAssistantMessage("second")]);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "first" });
		const queued = await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "/queue second" });

		expect(queued).toEqual({ ok: true, disposition: "queued" });
		expect(runtime.getSessionState(sessionId).queuedMessages.followUp).toEqual(["second"]);

		slow.open();
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		await runtime.release(sessionId, { clientId });
	});

	test("rejects prompts pi refuses before accepting them", async () => {
		const summary = gate();
		const { runtime, sessionId, clientId, events } = await startFauxSession([fauxAssistantMessage("first answer"), summary.step], {
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hello" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));

		await runtime.handleCommand(sessionId, { type: "compact", clientId });
		await waitFor(() => runtime.getSessionState(sessionId).isCompacting);
		const agentStarts = agentEventTypes(events).filter((type) => type === "agent_start").length;

		await expect(runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "too early" })).rejects.toThrow(/compaction/);
		expect(agentEventTypes(events).filter((type) => type === "agent_start").length).toBe(agentStarts);

		summary.open();
		await waitFor(() => agentEventTypes(events).includes("compaction_end"));
		await runtime.release(sessionId, { clientId });
	});
});
