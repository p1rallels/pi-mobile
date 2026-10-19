/** What pi's bash tool tells its children about the session running them. */
const SESSION_IDENTITY_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE"] as const;

/**
 * A server started from a pi's bash (a dev run, a deploy kicked off by an agent) inherits that pi's session id and
 * file. Hosted sessions are nobody's children, so neither they (msg reads PI_SESSION_ID as a session's parent)
 * nor the terminal shells get that pi's identity. pi's own bash sets the hosted session's id per call regardless.
 * @returns the keys it removed
 */
export function dropInheritedSessionIdentity(env: NodeJS.ProcessEnv): string[] {
	const present = SESSION_IDENTITY_KEYS.filter((key) => env[key] !== undefined);
	for (const key of present) delete env[key];
	return present;
}
