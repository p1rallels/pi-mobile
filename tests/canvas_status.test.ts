import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ApiCanvasSessionStatus } from "../src/types.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

const ASK_EXTENSION = `
export default function (pi) {
	pi.registerCommand("ask", {
		description: "asks before acting",
		handler: async (_args, ctx) => {
			await ctx.ui.confirm("Proceed?", "This needs a human");
		},
	});
}
`;

describe("canvas status", () => {
	test("reports every running session's work and dialogs, and tells listeners when they change", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([fauxAssistantMessage("done")], {
			extensions: { "ask.ts": ASK_EXTENSION },
			faux: { tokensPerSecond: 400, tokenSize: { min: 1, max: 1 } },
		});
		const seen: ApiCanvasSessionStatus[][] = [];
		const unsubscribe = runtime.onStatusChange(() => seen.push(runtime.canvasStatus()));
		const mine = () => runtime.canvasStatus().find((status) => status.id === sessionId);
		expect(mine()).toMatchObject({ working: false, waiting: false });

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "hello" });
		await waitFor(() => agentEventTypes(events).includes("agent_settled"));
		expect(seen.some((statuses) => statuses.find((status) => status.id === sessionId)?.working)).toBe(true);
		expect(mine()?.working).toBe(false);

		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "/ask" });
		await waitFor(() => mine()?.waiting === true);
		const dialog = runtime.connectClient(sessionId, { connectionId: "c", clientId: "c", send() {}, close() {} }).init.ui.dialogs[0];
		expect(mine()?.viewers).toBeGreaterThan(0);
		const before = seen.length;
		runtime.answerExtensionUi(sessionId, { id: dialog?.id ?? "", confirmed: true });
		await waitFor(() => mine()?.waiting === false && seen.length > before);

		unsubscribe();
		await runtime.release(sessionId, { clientId });
		expect(runtime.canvasStatus().find((status) => status.id === sessionId)).toBeUndefined();
	});
});
