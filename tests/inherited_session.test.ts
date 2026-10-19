import { describe, expect, test } from "bun:test";
import { dropInheritedSessionIdentity } from "../src/inherited-session.ts";

describe("a server started from a pi's bash", () => {
	test("forgets that pi's session, and nothing else", () => {
		const env: NodeJS.ProcessEnv = { PI_SESSION_ID: "01a152a0", PI_SESSION_FILE: "/s/a.jsonl", PI_WEB_PORT: "4319", HOME: "/home/me" };
		expect(dropInheritedSessionIdentity(env)).toEqual(["PI_SESSION_ID", "PI_SESSION_FILE"]);
		expect(env).toEqual({ PI_WEB_PORT: "4319", HOME: "/home/me" });
		expect(dropInheritedSessionIdentity(env)).toEqual([]);
	});
});
