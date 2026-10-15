import { describe, expect, test } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createExtensionUiBridge, parseExtensionUiResponse, type ExtensionUiEvent } from "../src/extension-ui.ts";

const fallback = { getAllThemes: () => [], getToolsExpanded: () => false } as unknown as ExtensionUIContext;

function bridge(now = () => 1_000) {
	const events: ExtensionUiEvent[] = [];
	const ui = createExtensionUiBridge({ emit: (event) => events.push(event), fallback, now });
	const requestId = (index = 0) => events.filter((event) => event.type === "extension_ui_request")[index]?.request.id ?? "";
	return { ui, events, requestId };
}

describe("extension ui bridge", () => {
	test("forwards a select dialog and resolves with the chosen option", async () => {
		const { ui, events, requestId } = bridge();
		const answer = ui.context.select("Pick one", ["a", "b"]);

		expect(events).toEqual([{ type: "extension_ui_request", request: { id: requestId(), method: "select", title: "Pick one", options: ["a", "b"] } }]);
		expect(ui.snapshot().dialogs.map((dialog) => dialog.id)).toEqual([requestId()]);
		expect(ui.respond({ id: requestId(), value: "c" })).toBe("invalid");
		expect(ui.respond({ id: requestId(), value: "b" })).toBe("answered");

		expect(await answer).toBe("b");
		expect(events.at(-1)).toEqual({ type: "extension_ui_closed", id: requestId() });
		expect(ui.snapshot().dialogs).toEqual([]);
		expect(ui.respond({ id: requestId(), value: "a" })).toBe("unknown");
	});

	test("maps confirm, input, editor and cancel answers like pi's rpc mode", async () => {
		const { ui, requestId } = bridge();
		const confirmed = ui.context.confirm("Sure?", "really");
		const declined = ui.context.confirm("Sure?", "again");
		const typed = ui.context.input("Name", "placeholder");
		const edited = ui.context.editor("Edit", "prefill");

		expect(ui.respond({ id: requestId(0), confirmed: true })).toBe("answered");
		expect(ui.respond({ id: requestId(1), cancelled: true })).toBe("answered");
		expect(ui.respond({ id: requestId(2), value: "pi" })).toBe("answered");
		expect(ui.respond({ id: requestId(3), cancelled: true })).toBe("answered");

		expect(await Promise.all([confirmed, declined, typed, edited])).toEqual([true, false, "pi", undefined]);
	});

	test("resolves to the default answer on timeout, abort and dispose", async () => {
		const { ui, events, requestId } = bridge();
		const timedOut = ui.context.confirm("Quick", "answer fast", { timeout: 5 });
		expect(events[0]).toMatchObject({ request: { timeout: 5, expiresAt: 1_005 } });

		expect(await timedOut).toBe(false);
		expect(ui.snapshot().dialogs).toEqual([]);

		const controller = new AbortController();
		const aborted = ui.context.select("Abortable", ["x"], { signal: controller.signal });
		controller.abort();
		const disposed = ui.context.input("Forever");

		const preAborted = new AbortController();
		preAborted.abort();
		const before = events.length;
		const skipped = ui.context.select("Never shown", ["x"], { signal: preAborted.signal });
		expect(events.length).toBe(before);

		ui.dispose();
		expect(await Promise.all([aborted, disposed, skipped])).toEqual([undefined, undefined, undefined]);
		const closed = events.filter((event) => event.type === "extension_ui_closed").map((event) => event.id);
		expect(closed.sort()).toEqual([requestId(0), requestId(1), requestId(2)].sort());
	});

	test("keeps statuses, string widgets and the title for late viewers", () => {
		const { ui, events } = bridge();
		ui.context.setStatus("op", "1P: ready");
		ui.context.setWidget("todo", ["one", "two"], { placement: "belowEditor" });
		ui.context.setWidget("component", (() => ({})) as never);
		ui.context.setTitle("pi - repo");
		ui.context.setStatus("gone", "soon");
		ui.context.setStatus("gone", undefined);

		expect(ui.snapshot()).toEqual({
			statuses: { op: "1P: ready" },
			widgets: { todo: { lines: ["one", "two"], placement: "belowEditor" } },
			title: "pi - repo",
			dialogs: [],
		});
		expect(events.filter((event) => event.type === "extension_ui_chrome").length).toBe(5);

		ui.context.notify("heads up", "warning");
		ui.context.setEditorText("draft");
		expect(events.slice(-2)).toEqual([
			{ type: "extension_ui_notify", message: "heads up", notifyType: "warning" },
			{ type: "extension_ui_editor_text", text: "draft" },
		]);
		expect(ui.context.getEditorText()).toBe("");
		expect(ui.context.getAllThemes()).toEqual([]);
	});

	test("parses only well-formed answers", () => {
		expect(parseExtensionUiResponse({ id: "d1", value: "x" })).toEqual({ id: "d1", value: "x" });
		expect(parseExtensionUiResponse({ id: "d1", confirmed: false, extra: 1 })).toEqual({ id: "d1", confirmed: false });
		expect(parseExtensionUiResponse({ id: "d1", value: 3 })).toBeNull();
		expect(parseExtensionUiResponse({ value: "x" })).toBeNull();
		expect(parseExtensionUiResponse({ id: "d1", cancelled: "yes" })).toBeNull();
	});
});
