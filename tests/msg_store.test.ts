import { describe, expect, test } from "bun:test";
import { isMsgId, msgStoreRoot, newMailDir, parsePresence, presencePath } from "../src/msg-store.ts";

const LEAD = "01a152a0-f00d-72aa-a896-d904c458282b";
const PILL = "01a15313-9e4e-72d8-9b42-450d6296524e";

describe("msg's store as pi-web reads it", () => {
	test("the root is msg's: $PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg; a leading ~ is home", () => {
		expect(msgStoreRoot({}, "/home/me")).toBe("/home/me/.pi/agent/msg");
		expect(msgStoreRoot({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/me")).toBe("/tmp/agent/msg");
		expect(msgStoreRoot({ PI_CODING_AGENT_DIR: " ~/agent " }, "/home/me")).toBe("/home/me/agent/msg");
		expect(msgStoreRoot({ PI_MSG_DIR: "/x/msg", PI_CODING_AGENT_DIR: "/agent" }, "/home/me")).toBe("/x/msg");
		expect(msgStoreRoot({ PI_MSG_DIR: "~/mail", PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/me")).toBe("/home/me/mail");
		expect(msgStoreRoot({ PI_MSG_DIR: "  ", PI_CODING_AGENT_DIR: "~" }, "/home/me")).toBe("/home/me/msg");
	});

	test("inboxes and presence records sit under the root by session id, and ids msg wouldn't take name none", () => {
		expect(newMailDir("/r", LEAD)).toBe(`/r/inbox/${LEAD}/new`);
		expect(presencePath("/r", LEAD)).toBe(`/r/sessions/${LEAD}.json`);
		expect(isMsgId(LEAD)).toBe(true);
		for (const id of ["", "../x", "a/b", ".hidden", "a..b", "x".repeat(129)]) expect(isMsgId(id)).toBe(false);
	});

	test("presence records read the way msg reads them", () => {
		const raw = { v: 1, id: PILL, parent: LEAD, cwd: "/repo/.forks/2", pid: 77172, mode: "print", activity: "busy", startedAt: 1, heartbeatAt: 2, name: "  lineage\n pill " };
		expect(parsePresence(raw)).toEqual({ id: PILL, name: "lineage pill", parent: LEAD, cwd: "/repo/.forks/2", pid: 77172, mode: "print", activity: "busy", startedAt: 1, heartbeatAt: 2 });
		expect(parsePresence({ ...raw, endedAt: 3 })?.endedAt).toBe(3);
		expect(parsePresence({ ...raw, mode: "spaceship", activity: "dancing" })).toMatchObject({ mode: "rpc", activity: "idle" });
		expect(parsePresence({ ...raw, parent: PILL })?.parent).toBeUndefined();
		expect(parsePresence({ ...raw, parent: "../escape" })?.parent).toBeUndefined();
		for (const broken of [{ ...raw, v: 2 }, { ...raw, id: "../x" }, { ...raw, pid: "77172" }, { ...raw, pid: null }, { ...raw, heartbeatAt: "now" }, { ...raw, startedAt: undefined }, [raw], null, "x"]) {
			expect(parsePresence(broken)).toBeNull();
		}
	});
});
