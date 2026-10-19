// @ts-check
import { defineConfig, devices } from "@playwright/test";

// the main folder's e2e and mock ports, the live server's and caddy's: never a pfs fork's default
const SHARED_PORTS = new Set(["4317", "4318", "4321", "8443", "2019"]);
// a pfs fork's run has its own port block in $PORT: its e2e servers default to it, so they never meet another fork's
const forkPort = /^\d+$/.test(process.env.PORT ?? "") && !SHARED_PORTS.has(process.env.PORT ?? "") ? Number(process.env.PORT) : null;
const PORT = Number.parseInt(process.env.PI_WEB_E2E_PORT || String(forkPort ?? 4318), 10);
// the mock ui (mock-ui/server.ts) for the canvas prototype and perf harness; exported to tests as MOCK_UI_URL
const MOCK_PORT = Number.parseInt(process.env.PI_WEB_E2E_MOCK_PORT || String(forkPort === null ? 4321 : forkPort + 1), 10);
process.env.MOCK_UI_URL = `http://127.0.0.1:${MOCK_PORT}`;

export default defineConfig({
	testDir: "tests/e2e",
	testMatch: "**/*.e2e.js",
	timeout: 60_000,
	retries: process.env.CI ? 1 : 0,
	expect: {
		toHaveScreenshot: {
			animations: "disabled",
			maxDiffPixelRatio: 0.01,
		},
	},
	webServer: [
		{
			command: `bun tests/support/sandboxed_server.ts PI_WEB_PORT=${PORT} PI_WEB_REPLAY=1 PI_WEB_CLIENT_SESSIONS_PER_MINUTE=1000`,
			url: `http://127.0.0.1:${PORT}/health`,
			reuseExistingServer: true,
			timeout: 120_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
		},
		{
			command: `bun mock-ui/server.ts`,
			env: { PORT: String(MOCK_PORT), HOST: "127.0.0.1" },
			url: `http://127.0.0.1:${MOCK_PORT}/canvas.html`,
			reuseExistingServer: true,
			timeout: 30_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
		},
	],
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "webkit-iphone",
			use: { ...devices["iPhone 14"] },
		},
	],
});
