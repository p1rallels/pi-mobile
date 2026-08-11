import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { refreshModelCatalogs } from "../src/model-catalog.ts";

describe("model catalog refresh", () => {
	test("forces a network refresh into the agent model store", async () => {
		const agentDir = "/tmp/pi-web-model-catalog";
		let createOptions: { authPath: string; modelsPath: string; allowModelNetwork: boolean; refreshOnCreate: boolean; signal: AbortSignal } | undefined;
		let refreshOptions: { allowNetwork: boolean; force: boolean; signal: AbortSignal } | undefined;

		await refreshModelCatalogs({
			agentDir,
			createModelRuntime: async (options) => {
				createOptions = options;
				return {
					refresh: async (refresh) => {
						refreshOptions = refresh;
						return { aborted: false, errors: new Map() };
					},
				};
			},
		});

		expect(createOptions).toMatchObject({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		expect(refreshOptions).toMatchObject({ allowNetwork: true, force: true });
	});

	test("reports provider refresh failures", async () => {
		const refresh = refreshModelCatalogs({
			createModelRuntime: async () => ({
				refresh: async () => ({
					aborted: false,
					errors: new Map([
						["anthropic", new Error("unavailable")],
						["openai", new Error("unauthorized")],
					]),
				}),
			}),
		});

		await expect(refresh).rejects.toThrow("Could not refresh model catalogs: anthropic: unavailable; openai: unauthorized");
	});

	test("aborts refreshes after the timeout", async () => {
		const refresh = refreshModelCatalogs({
			timeoutMs: 1,
			createModelRuntime: async () => ({
				refresh: async ({ signal }) => {
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
					return { aborted: signal.aborted, errors: new Map() };
				},
			}),
		});

		await expect(refresh).rejects.toThrow("Model catalog refresh timed out.");
	});
});
