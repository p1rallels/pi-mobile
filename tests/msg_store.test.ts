import { describe, expect, test } from "bun:test";
import { isMsgId, msgStoreRoot, newMailDir, parseCall, parsePresence, presencePath } from "../src/msg-store.ts";

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

	test("a record's running call reads the way msg reads one: an id, a name and a start, the preview one line of 120 characters", () => {
		const raw = { v: 1, id: PILL, parent: LEAD, cwd: "/repo/.forks/2", pid: 77172, mode: "print", activity: "busy", startedAt: 1, heartbeatAt: 2 };
		const call = { id: "toolu_01", name: "bash", preview: "bun run e2e", since: 1_000 };
		expect(parsePresence({ ...raw, call })?.call).toEqual(call);
		expect(parseCall({ id: "toolu_02", name: "read", since: 5 })).toEqual({ id: "toolu_02", name: "read", since: 5 });
		// records from before msg wrote calls, and a run that settled, have none
		expect(parsePresence(raw)).not.toHaveProperty("call");
		expect(parseCall({ ...call, preview: "  sleep\n\t 600  " })?.preview).toBe("sleep 600");
		expect(parseCall({ ...call, preview: " \n " })).toEqual({ id: "toolu_01", name: "bash", since: 1_000 });
		expect(parseCall({ ...call, preview: 42 })).not.toHaveProperty("preview");
		const long = parseCall({ ...call, preview: `echo ${"x".repeat(200)}` })?.preview ?? "";
		expect([...long]).toHaveLength(120);
		expect(long.endsWith("\u2026")).toBe(true);
		expect(parseCall({ ...call, name: "  mcp\n tool " })?.name).toBe("mcp tool");
		// junk is no call, and the record still reads
		const junk = [{ ...call, id: "" }, { ...call, id: 7 }, { ...call, name: "" }, { ...call, name: "  " }, { ...call, name: null }, { ...call, since: "1000" }, { ...call, since: Number.NaN }, { id: "toolu_01", name: "bash" }, [call], "bash", null];
		for (const broken of junk) {
			expect(parseCall(broken)).toBeUndefined();
			const record = parsePresence({ ...raw, call: broken });
			expect(record?.id).toBe(PILL);
			expect(record).not.toHaveProperty("call");
		}
	});
});
