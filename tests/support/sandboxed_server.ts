// Runs src/server.ts for the e2e suite with a scrubbed env and a throwaway state root, removed on exit.
// usage: bun tests/support/sandboxed_server.ts PI_WEB_PORT=4318 [KEY=VALUE...]
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxServerEnv } from "./sandbox_env.js";

const overrides = Object.fromEntries(
	process.argv.slice(2).map((pair) => {
		const at = pair.indexOf("=");
		if (at <= 0) throw new Error(`expected KEY=VALUE, got ${pair}`);
		return [pair.slice(0, at), pair.slice(at + 1)];
	}),
);
if (!overrides.PI_WEB_PORT) throw new Error("PI_WEB_PORT=<port> is required");

const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-e2e-"));
const server = Bun.spawn({
	cmd: [process.execPath, "src/server.ts"],
	env: sandboxServerEnv(root, overrides),
	stdio: ["ignore", "inherit", "inherit"],
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => server.kill(signal));
const code = await server.exited;
await rm(root, { recursive: true, force: true });
process.exit(code);
