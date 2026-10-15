// Env for anything a test starts. A test run inside a pi or pi-web session inherits that session's
// config (PI_WEB_* of the live server, PI_CODING_AGENT_DIR, ...), so every PI_* key is dropped and
// the server under test gets its own state root instead of ~/.pi-web and ~/.pi/agent.
import { join } from "node:path";

/** @param {string} key */
export const isInheritedPiKey = (key) => key.startsWith("PI_");

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>}
 */
export function scrubbedEnv(env = process.env) {
	return Object.fromEntries(
		Object.entries(env).filter(/** @returns {entry is [string, string]} */ (entry) => entry[1] !== undefined && !isInheritedPiKey(entry[0])),
	);
}

/**
 * Env for a pi-web server under test, with PI_WEB_HOME and PI_CODING_AGENT_DIR under `root`.
 * @param {string} root
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string>}
 */
export function sandboxServerEnv(root, overrides) {
	return {
		...scrubbedEnv(),
		PI_WEB_HOME: join(root, "home"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_WEB_HOST: "127.0.0.1",
		...overrides,
	};
}
