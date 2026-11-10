import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveReadPath, resolveToCwd } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import { TripwireService } from "../src/tripwire.ts";
import { CASE_INSENSITIVE_FS, isWithin, type PathLookup, readVariants, realTarget, toolPath } from "../src/tripwire-paths.ts";
import { agentEventTypes, cleanupAgentDirs, startFauxSession, waitFor } from "./support/faux_runtime.ts";

const DUMMY_KEY = "dummy-cookie-key-for-the-tripwire-test-000";
const DUMMY_FACEID = JSON.stringify({ version: 2, rpCredentials: { "dummy.example": [{ id: "dummy-owner", publicKey: "AA", counter: 0 }] } });
const DUMMY_AUTH = JSON.stringify({ dummy: { type: "api_key", key: "dummy-provider-key" } });

const originalPiWebHome = process.env.PI_WEB_HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
	await cleanupAgentDirs();
	restoreEnv("PI_WEB_HOME", originalPiWebHome);
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

interface Fixture {
	root: string;
	repo: string;
	piWebHome: string;
	agentDir: string;
	keyPath: string;
	faceIdPath: string;
	authPath: string;
}

/** A repo, a dummy pi-web home with a cookie key, a dummy agent dir with a Face ID store and auth.json, and symlinks from the repo into them. */
async function makeFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-tripwire-paths-"));
	tempDirs.push(root);
	const repo = join(root, "repo");
	const piWebHome = join(root, "pi-web-home");
	const agentDir = join(root, "agent");
	const fixture = {
		root,
		repo,
		piWebHome,
		agentDir,
		keyPath: join(piWebHome, "cookie-key"),
		faceIdPath: join(agentDir, "pi-web", "faceid-credentials.json"),
		authPath: join(agentDir, "auth.json"),
	};
	await Promise.all([
		mkdir(join(repo, "src"), { recursive: true }),
		mkdir(piWebHome, { recursive: true }),
		mkdir(join(agentDir, "pi-web"), { recursive: true }),
		mkdir(join(agentDir, "skills", "demo"), { recursive: true }),
		mkdir(join(root, "outside"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n"),
		writeFile(fixture.keyPath, DUMMY_KEY, { mode: 0o600 }),
		writeFile(fixture.faceIdPath, DUMMY_FACEID, { mode: 0o600 }),
		writeFile(fixture.authPath, DUMMY_AUTH, { mode: 0o600 }),
		symlink(piWebHome, join(repo, "state-alias")),
		symlink(fixture.keyPath, join(repo, "key-link")),
		symlink(join(piWebHome, "planted"), join(repo, "dangling")),
		symlink(join(root, "outside"), join(repo, "outside-alias")),
		symlink(repo, join(root, "repo-alias")),
	]);
	return fixture;
}

/** The service reads PI_WEB_HOME and the agent dir when it's made, like the runtime's. */
function makeService(fixture: Fixture): TripwireService {
	process.env.PI_WEB_HOME = fixture.piWebHome;
	process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
	return new TripwireService(join(fixture.agentDir, "pi-web", "tripwire-state.json"));
}

function inspect(service: TripwireService, fixture: Fixture, toolName: string, input: Record<string, unknown>, cwd = fixture.repo) {
	const context = { sessionId: "sess-paths", cwd, allowedRoots: [cwd, fixture.agentDir] };
	const result = service.inspectToolCall(context, toolName, "call-paths", input);
	return result.alerts.map((alert) => [alert.category, alert.response]);
}

describe("tripwire path spellings", () => {
	const blockedSpellings: [string, string, (fixture: Fixture) => Record<string, unknown>][] = [
		["the literal path (control)", "read", (f) => ({ path: f.keyPath })],
		["@/abs", "read", (f) => ({ path: `@${f.keyPath}` })],
		["@rel", "read", () => ({ path: "@../pi-web-home/cookie-key" })],
		["file:///abs", "read", (f) => ({ path: pathToFileURL(f.keyPath).href })],
		["@file:///abs", "read", (f) => ({ path: `@${pathToFileURL(f.keyPath).href}` })],
		["a symlinked folder", "read", () => ({ path: "state-alias/cookie-key" })],
		["a symlink to the file", "read", () => ({ path: "key-link" })],
		["a missing file under a symlinked folder", "write", () => ({ path: "state-alias/new-file", content: "x" })],
		["a dangling symlink into the protected folder", "write", () => ({ path: "dangling", content: "x" })],
		["@/abs write", "write", (f) => ({ path: `@${f.keyPath}`, content: "replaced" })],
		["@rel edit", "edit", () => ({ path: "@state-alias/cookie-key", edits: [] })],
		["ls of a symlinked folder", "ls", () => ({ path: "state-alias" })],
		["grep through a symlinked folder", "grep", () => ({ pattern: "dummy", path: "state-alias" })],
	];

	for (const [label, toolName, input] of blockedSpellings) {
		test(`${label} reaches the protected file and is blocked`, async () => {
			const fixture = await makeFixture();
			const service = makeService(fixture);
			expect(inspect(service, fixture, toolName, input(fixture))).toEqual([["secret_access", "blocked"]]);
		});
	}

	test("~/x and @~/x map to the home folder's secrets", async () => {
		const fixture = await makeFixture();
		const service = makeService(fixture);
		for (const path of ["~/.ssh/id_ed25519", "@~/.ssh/id_ed25519", "~/.netrc", "@~/.netrc"]) {
			expect(inspect(service, fixture, "read", { path })).toEqual([["secret_access", "blocked"]]);
		}
		expect(inspect(service, fixture, "write", { path: "@~/.zshrc", content: "x" })).toEqual([["persistence", "blocked"]]);
	});

	test.if(CASE_INSENSITIVE_FS)("another case of a protected folder is blocked on a case-insensitive disk", async () => {
		const fixture = await makeFixture();
		const service = makeService(fixture);
		expect(inspect(service, fixture, "read", { path: join(fixture.root, "PI-WEB-HOME", "cookie-key") })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "write", { path: join(fixture.root, "PI-WEB-HOME", "new-file"), content: "x" })).toEqual([["secret_access", "blocked"]]);
	});

	test("pi-web's own state and the agent's auth.json are protected under the agent dir", async () => {
		const fixture = await makeFixture();
		const service = makeService(fixture);
		const faceIdReset = JSON.stringify({ version: 2, rpCredentials: {} });
		expect(inspect(service, fixture, "write", { path: fixture.faceIdPath, content: faceIdReset })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "read", { path: fixture.faceIdPath })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "write", { path: join(fixture.agentDir, "pi-web", "tripwire-state.json"), content: "{}" })).toEqual([
			["secret_access", "blocked"],
		]);
		expect(inspect(service, fixture, "read", { path: fixture.authPath })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "edit", { path: `@${fixture.authPath}`, edits: [] })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "bash", { command: `cat ${fixture.faceIdPath}` })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "bash", { command: `cat ${fixture.authPath}` })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "bash", { command: "cat ~/.pi/agent/auth.json" })).toEqual([["secret_access", "blocked"]]);
	});

	test("a protected folder configured through a symlink is protected where it really is, from file tools and bash", async () => {
		const fixture = await makeFixture();
		const configured = join(fixture.root, "home-link");
		await symlink(fixture.piWebHome, configured);
		const service = makeService({ ...fixture, piWebHome: configured });
		expect(inspect(service, fixture, "read", { path: fixture.keyPath })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "bash", { command: `cat ${fixture.keyPath}` })).toEqual([["secret_access", "blocked"]]);
		expect(inspect(service, fixture, "bash", { command: `cat ${join(configured, "cookie-key")}` })).toEqual([["secret_access", "blocked"]]);
	});

	test("the rest of the agent dir stays open to the agent", async () => {
		const fixture = await makeFixture();
		const service = makeService(fixture);
		const skill = join(fixture.agentDir, "skills", "demo", "SKILL.md");
		expect(inspect(service, fixture, "write", { path: skill, content: "# demo" })).toEqual([["persistence", "logged"]]);
		expect(inspect(service, fixture, "read", { path: `@${skill}` })).toEqual([]);
		expect(inspect(service, fixture, "write", { path: join(fixture.agentDir, "settings.json"), content: "{}" })).toEqual([["persistence", "logged"]]);
		expect(inspect(service, fixture, "write", { path: join(fixture.agentDir, "notes.md"), content: "" })).toEqual([]);
		expect(inspect(service, fixture, "ls", { path: join(fixture.agentDir, "sessions") })).toEqual([]);
		expect(inspect(service, fixture, "bash", { command: `ls ${join(fixture.agentDir, "skills")}` })).toEqual([["persistence", "logged"]]);
	});

	test("ordinary project paths raise nothing, however they're spelled", async () => {
		const fixture = await makeFixture();
		const service = makeService(fixture);
		const file = join(fixture.repo, "src", "a.ts");
		for (const path of ["src/a.ts", "@src/a.ts", `@${file}`, pathToFileURL(file).href, "./src/../src/a.ts"]) {
			expect(inspect(service, fixture, "read", { path })).toEqual([]);
		}
		expect(inspect(service, fixture, "write", { path: "@src/new.ts", content: "x" })).toEqual([]);
		expect(inspect(service, fixture, "write", { path: "src/deeper/new.ts", content: "x" })).toEqual([]);
		expect(inspect(service, fixture, "grep", { pattern: "a", path: "." })).toEqual([]);
		const throughAlias = join(fixture.root, "repo-alias");
		expect(inspect(service, fixture, "write", { path: "src/new.ts", content: "x" }, throughAlias)).toEqual([]);
		expect(inspect(service, fixture, "write", { path: join(fixture.repo, "src", "new.ts"), content: "x" }, throughAlias)).toEqual([]);
	});

	test("a symlink out of the repo is where the write lands: a repo escape", async () => {
		const fixture = await makeFixture();
		const service = makeService(fixture);
		expect(inspect(service, fixture, "write", { path: "outside-alias/x.txt", content: "x" })).toEqual([["repo_escape", "blocked"]]);
		expect(inspect(service, fixture, "read", { path: "outside-alias/x.txt" })).toEqual([["repo_escape", "logged"]]);
		expect(inspect(service, fixture, "read", { path: pathToFileURL(join(fixture.root, "outside", "x.txt")).href })).toEqual([["repo_escape", "logged"]]);
	});

	test("a path that can't be resolved falls back to the path as written", async () => {
		const fixture = await makeFixture();
		const service = makeService(fixture);
		expect(inspect(service, fixture, "read", { path: "file://remote-host/etc/passwd" })).toEqual([]);
		expect(inspect(service, fixture, "read", { path: "file:///a%2Fb" })).toEqual([]);
		expect(inspect(service, fixture, "write", { path: "file://remote-host/etc/passwd", content: "x" })).toEqual([]);
	});
});

describe("tripwire path helpers", () => {
	const cwd = "/work/repo";

	test("toolPath spells paths like the SDK's file tools", () => {
		const spellings = [
			"src/a.ts",
			"/abs/x",
			"@/abs/x",
			"@rel/x",
			"@@twice",
			"file:///abs/x",
			"@file:///abs/x",
			"file:///abs/%2Edot",
			"~",
			"~/x",
			"@~/x",
			"~other/x",
			" ~/x",
			"a\u00A0b",
			"../up",
		];
		for (const raw of spellings) {
			expect(toolPath(cwd, raw)).toBe(resolveToCwd(raw, cwd));
		}
		expect(toolPath(cwd, "@~/x", "/home/me")).toBe("/home/me/x");
		expect(() => toolPath(cwd, "file://remote-host/x")).toThrow();
	});

	test("readVariants covers read's fallbacks", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "pi-web-tripwire-variants-"));
		tempDirs.push(root);
		const names = ["Shot 1\u202FAM.png", "it\u2019s.txt", "cafe\u0301.txt"];
		await Promise.all(names.map((name) => writeFile(join(root, name), "x")));
		for (const typed of ["Shot 1 AM.png", "it's.txt", "caf\u00E9.txt"]) {
			const opened = resolveReadPath(typed, root);
			expect(readVariants(join(root, typed))).toContain(opened);
		}
		expect(readVariants("/plain/path")).toEqual(["/plain/path"]);
	});

	test("realTarget follows the longest existing prefix and dangling links, bounded", () => {
		const links: Record<string, string> = { "/r/alias": "/secret", "/r/dangling": "/secret/new", "/r/loop": "/r/loop" };
		const existing = new Set(["/", "/r", "/secret"]);
		const lookup: PathLookup = {
			realpath(path) {
				if (existing.has(path)) return path;
				const prefix = Object.keys(links).find((link) => path === link || path.startsWith(`${link}/`));
				if (prefix && existing.has(links[prefix]!)) return links[prefix]! + path.slice(prefix.length);
				throw new Error("ENOENT");
			},
			readlink(path) {
				const target = links[path];
				if (target === undefined) throw new Error("EINVAL");
				return target;
			},
		};
		expect(realTarget("/r/alias/file", lookup)).toBe("/secret/file");
		expect(realTarget("/r/alias/a/b", lookup)).toBe("/secret/a/b");
		expect(realTarget("/r/dangling", lookup)).toBe("/secret/new");
		expect(realTarget("/r/plain/new", lookup)).toBe("/r/plain/new");
		expect(realTarget("/r/loop/x", lookup)).toBe("/r/loop/x");
		const nothing: PathLookup = {
			realpath() {
				throw new Error("EACCES");
			},
			readlink() {
				throw new Error("EACCES");
			},
		};
		expect(realTarget("/a/b/../c", nothing)).toBe("/a/c");
	});

	test("isWithin matches whole segments, and folds case when asked", () => {
		expect(isWithin("/a/b/c", "/a/b")).toBe(true);
		expect(isWithin("/a/b", "/a/b")).toBe(true);
		expect(isWithin("/a/bc", "/a/b")).toBe(false);
		expect(isWithin("/x", "/")).toBe(true);
		expect(isWithin("/A/B/c", "/a/b")).toBe(false);
		expect(isWithin("/A/B/c", "/a/b", true)).toBe(true);
	});
});

describe("tripwire in a session", () => {
	test("blocks @ and file:// reads of a protected file, an @ write to it, and a write to the Face ID store", async () => {
		const fixture = await makeFixture();
		process.env.PI_WEB_HOME = fixture.piWebHome;
		const session = await startFauxSession([], { cwd: fixture.repo, runtime: { listPiProcesses: async () => [], listForks: async () => null } });
		const { runtime, sessionId, clientId, events } = session;
		const faceIdPath = join(session.agentDir, "pi-web", "faceid-credentials.json");
		await writeFile(faceIdPath, DUMMY_FACEID, { mode: 0o600 });

		async function turn(id: string, toolName: string, input: Record<string, string>) {
			events.splice(0);
			session.faux.setResponses([fauxAssistantMessage(fauxToolCall(toolName, input, { id }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
			await runtime.handleCommand(sessionId, { type: "prompt", clientId, text: "look at the repo" });
			await waitFor(() => agentEventTypes(events).includes("agent_settled"), 10_000);
			const alerts = events.flatMap((event) => (event.type === "tripwire_alert" ? [[event.alert.category, event.alert.response]] : []));
			const results = events.flatMap((event) =>
				event.type === "agent_event" && event.event.type === "tool_execution_end" ? [JSON.stringify(event.event.result)] : [],
			);
			return { alerts, results };
		}

		try {
			const ordinary = await turn("ordinary", "read", { path: "@src/a.ts" });
			expect(ordinary.alerts).toEqual([]);
			expect(ordinary.results.join("")).toContain("export const a = 1;");

			for (const [id, path] of [
				["at-read", `@${fixture.keyPath}`],
				["url-read", pathToFileURL(fixture.keyPath).href],
				["alias-read", "state-alias/cookie-key"],
			] as const) {
				const { alerts, results } = await turn(id, "read", { path });
				expect(alerts).toEqual([["secret_access", "blocked"]]);
				expect(results.join("")).toContain("Blocked by the pi-web tripwire");
				expect(results.join("")).not.toContain(DUMMY_KEY);
			}

			const keyWrite = await turn("at-write", "write", { path: `@${fixture.keyPath}`, content: "dummy-replacement-signing-key-000000000000" });
			expect(keyWrite.alerts).toEqual([["secret_access", "blocked"]]);
			expect(await readFile(fixture.keyPath, "utf8")).toBe(DUMMY_KEY);

			const faceIdWrite = await turn("faceid-write", "write", { path: faceIdPath, content: JSON.stringify({ version: 2, rpCredentials: {} }) });
			expect(faceIdWrite.alerts).toEqual([["secret_access", "blocked"]]);
			expect(await readFile(faceIdPath, "utf8")).toBe(DUMMY_FACEID);
		} finally {
			await runtime.release(sessionId, { clientId });
			await runtime.shutdown();
		}
	});
});
