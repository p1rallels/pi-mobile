import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

interface ModelCatalogRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}

interface ModelCatalogRuntime {
	refresh(options: { allowNetwork: boolean; force: boolean; signal: AbortSignal }): Promise<ModelCatalogRefreshResult>;
}

interface ModelRuntimeCreateOptions {
	authPath: string;
	modelsPath: string;
	allowModelNetwork: boolean;
	refreshOnCreate: boolean;
	signal: AbortSignal;
}

interface RefreshModelCatalogOptions {
	agentDir?: string;
	timeoutMs?: number;
	createModelRuntime?: (options: ModelRuntimeCreateOptions) => Promise<ModelCatalogRuntime>;
}

export async function refreshModelCatalogs(options: RefreshModelCatalogOptions = {}): Promise<void> {
	const agentDir = options.agentDir ?? getAgentDir();
	const createModelRuntime = options.createModelRuntime ?? ModelRuntime.create;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

	try {
		const modelRuntime = await createModelRuntime({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
			signal: controller.signal,
		});
		const result = await modelRuntime.refresh({
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});
		if (result.aborted || controller.signal.aborted) throw new Error("Model catalog refresh timed out.");
		if (result.errors.size > 0) {
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			throw new Error(`Could not refresh model catalogs: ${details}`);
		}
	} finally {
		clearTimeout(timeout);
	}
}
