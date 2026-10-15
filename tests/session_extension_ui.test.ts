import { afterEach, describe, expect, test } from "bun:test";
import type { SseEvent } from "../src/types.ts";
import { cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

afterEach(cleanupAgentDirs);

const ASK_EXTENSION = `
export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("ask", "ready");
	});
	pi.registerCommand("ask", {
		description: "asks before acting",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Proceed?", "This needs a human");
			ctx.ui.setStatus("ask", ok ? "confirmed" : "declined");
			ctx.ui.notify(ok ? "went ahead" : "stopped", "info");
		},
	});
}
`;

type UiEvent<T extends SseEvent["type"]> = Extract<SseEvent, { type: T }>;

function ofType<T extends SseEvent["type"]>(events: SseEvent[], type: T): Array<UiEvent<T>> {
	return events.filter((event): event is UiEvent<T> => event.type === type);
}

describe("extension ui in sessions", () => {
	test("asks the browser from an extension command and applies the answer", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([], { extensions: { "ask.ts": ASK_EXTENSION } });

		const late = runtime.connectClient(sessionId, { connectionId: "late", clientId: "late", send() {}, close() {} });
		expect(late.init.ui.statuses).toEqual({ ask: "ready" });

		const result = await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "/ask" });
		expect(result).toEqual({ ok: true, disposition: "handled" });
		await waitFor(() => ofType(events, "extension_ui_request").length === 1);
		const [{ request }] = ofType(events, "extension_ui_request");
		expect(request).toMatchObject({ method: "confirm", title: "Proceed?", message: "This needs a human" });

		const joining = runtime.connectClient(sessionId, { connectionId: "joining", clientId: "joining", send() {}, close() {} });
		expect(joining.init.ui.dialogs.map((dialog) => dialog.id)).toEqual([request.id]);

		expect(() => runtime.answerExtensionUi(sessionId, { id: request.id, value: "nope" })).toThrow("invalid_dialog_answer");
		runtime.answerExtensionUi(sessionId, { id: request.id, confirmed: true });
		expect(() => runtime.answerExtensionUi(sessionId, { id: request.id, confirmed: true })).toThrow("unknown_dialog");

		await waitFor(() => ofType(events, "extension_ui_notify").length === 1);
		expect(ofType(events, "extension_ui_closed").map((event) => event.id)).toEqual([request.id]);
		expect(ofType(events, "extension_ui_notify")[0]).toMatchObject({ message: "went ahead", notifyType: "info" });
		expect(ofType(events, "extension_ui_chrome").at(-1)?.chrome.statuses).toEqual({ ask: "confirmed" });

		await runtime.release(sessionId, { clientId });
	});

	test("cancels open dialogs when the session is released", async () => {
		const { runtime, sessionId, clientId, events } = await startFauxSession([], { extensions: { "ask.ts": ASK_EXTENSION } });
		await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "/ask" });
		await waitFor(() => ofType(events, "extension_ui_request").length === 1);

		await runtime.release(sessionId, { clientId });
		expect(ofType(events, "extension_ui_closed").length).toBe(1);
	});
});
