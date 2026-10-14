import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TripwireService } from "../src/tripwire.ts";

const tempDirs: string[] = [];

async function createService() {
	const tempRoot = await realpath(tmpdir());
	const dir = await mkdtemp(join(tempRoot, "pi-web-tripwire-"));
	tempDirs.push(dir);
	return new TripwireService(join(dir, "tripwire-state.json"));
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		await rm(dir, { recursive: true, force: true });
	}
});

describe("tripwire service", () => {
	test("marks repo-external writes as critical and unread until consumed", async () => {
		const service = await createService();
		const ctx = {
			sessionId: "sess-write",
			cwd: "/workspace/repo",
			allowedRoots: ["/workspace/repo"],
		};

		const inspection = service.inspectToolCall(ctx, "write", "call-write", { path: "../outside.txt", content: "oops" });

		expect(inspection.shouldBlock).toBe(true);
		expect(inspection.alerts).toHaveLength(1);
		expect(service.toApiAlert(inspection.alerts[0]!).category).toBe("repo_escape");
		expect(service.toApiAlert(inspection.alerts[0]!).response).toBe("blocked");

		await service.recordAlerts(ctx.sessionId, inspection.alerts);

		const firstSnapshot = await service.consumeAlerts(ctx.sessionId, "client-a");
		expect(firstSnapshot.unreadAlerts).toHaveLength(1);
		expect(firstSnapshot.unreadAlerts[0]?.severity).toBe("critical");

		const secondSnapshot = await service.consumeAlerts(ctx.sessionId, "client-a");
		expect(secondSnapshot.unreadAlerts).toHaveLength(0);
		expect(secondSnapshot.alerts).toHaveLength(1);
	});

	test("logs repo-external reads without blocking", async () => {
		const service = await createService();
		const inspection = service.inspectToolCall(
			{
				sessionId: "sess-read",
				cwd: "/workspace/repo",
				allowedRoots: ["/workspace/repo"],
			},
			"read",
			"call-read",
			{ path: "../notes.txt" },
		);

		expect(inspection.shouldBlock).toBe(false);
		expect(inspection.alerts).toHaveLength(1);
		expect(service.toApiAlert(inspection.alerts[0]!).severity).toBe("observe");
		expect(service.toApiAlert(inspection.alerts[0]!).category).toBe("repo_escape");
	});

	test("blocks host persistence bash patterns", async () => {
		const service = await createService();
		const inspection = service.inspectToolCall(
			{
				sessionId: "sess-persist",
				cwd: "/workspace/repo",
				allowedRoots: ["/workspace/repo"],
			},
			"bash",
			"call-bash",
			{ command: "echo 'alias ll=ls -la' >> ~/.zshrc" },
		);

		expect(inspection.shouldBlock).toBe(true);
		expect(inspection.alerts).toHaveLength(1);
		expect(service.toApiAlert(inspection.alerts[0]!).category).toBe("persistence");
	});
});
