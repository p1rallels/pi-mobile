import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHostRegistry, normalizeHostId, normalizeHostUrl, removeHost, upsertHost } from "../src/host-registry.ts";

const tempDirs: string[] = [];

async function registryPath() {
	const tempRoot = await realpath(tmpdir());
	const dir = await mkdtemp(join(tempRoot, "pi-web-host-registry-"));
	tempDirs.push(dir);
	return join(dir, "hosts.json");
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		await rm(dir, { recursive: true, force: true });
	}
});

describe("host registry", () => {
	test("normalizes host ids and urls", () => {
		expect(normalizeHostId("Prod-A")).toBe("prod-a");
		expect(normalizeHostUrl("https://box.tailnet.ts.net:8443/path?q=1#x")).toBe("https://box.tailnet.ts.net:8443");
		expect(() => normalizeHostId("not ok")).toThrow();
		expect(() => normalizeHostUrl("ftp://box")).toThrow();
	});

	test("upserts, lists, and removes hosts", async () => {
		const path = await registryPath();
		await upsertHost(path, {
			id: "Prod-A",
			label: "Prod A",
			url: "https://prod-a.tailnet.ts.net:8443",
			tailscaleName: "prod-a",
			tailscaleIp: "100.64.0.10",
		});
		await upsertHost(path, {
			id: "prod-a",
			url: "https://prod-a.tailnet.ts.net:9443",
		});
		const registry = await loadHostRegistry(path);
		expect(registry.hosts).toHaveLength(1);
		expect(registry.hosts[0]?.id).toBe("prod-a");
		expect(registry.hosts[0]?.label).toBe("Prod A");
		expect(registry.hosts[0]?.url).toBe("https://prod-a.tailnet.ts.net:9443");
		const removed = await removeHost(path, "prod-a");
		expect(removed.id).toBe("prod-a");
		expect((await loadHostRegistry(path)).hosts).toHaveLength(0);
	});
});
