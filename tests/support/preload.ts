// bun test preload: in-process tests never see the caller's PI_* config or the real ~/.pi/agent and ~/.pi-web.
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInheritedPiKey } from "./sandbox_env.js";

for (const key of Object.keys(process.env).filter(isInheritedPiKey)) delete process.env[key];

const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-web-test-"));
process.env.PI_WEB_HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
afterAll(() => rmSync(root, { recursive: true, force: true }));
