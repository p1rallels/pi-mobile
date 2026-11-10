import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRequestUrl } from "../src/request-url.ts";
import { createCookieSigner } from "../src/signed-cookies.ts";
import { sandboxServerEnv } from "./support/sandbox_env.js";

const REMOTE_HOST = "allowed.example";
const CHECKOUT = resolve(import.meta.dir, "..");

describe("parseRequestUrl", () => {
	test("takes a well-formed URL, a trailing slash included", () => {
		expect(parseRequestUrl("http://h/")?.pathname).toBe("/");
		expect(parseRequestUrl("http://h/api/sessions/x/takeover?path=/a//b")?.pathname).toBe("/api/sessions/x/takeover");
		expect(parseRequestUrl("http://h/api/sessions/")?.pathname).toBe("/api/sessions/");
		expect(parseRequestUrl("http://h/./api/x/../sessions")?.pathname).toBe("/api/sessions");
	});

	test("refuses a path with an empty segment, wherever it is and however it's spelled", () => {
		for (const path of ["//api/sessions", "///api/terminals", "/\\api/sessions", "/api//sessions/x/release", "/api/sessions/x//", "/app//main.js"]) {
			expect(parseRequestUrl(`http://h${path}`)).toBeNull();
		}
	});

	test("refuses a URL that doesn't parse", () => {
		expect(parseRequestUrl("http://h:99999/")).toBeNull();
		expect(parseRequestUrl("not a url")).toBeNull();
	});
});

type RawResponse = { status: number; head: string; body: string };

/** Sends the request-target byte for byte: fetch() would normalize `//api` and `/\api` before they reach the server. */
function rawRequest(
	port: number,
	request: { method: string; target: string; host: string; cookie?: string; body?: string },
): Promise<RawResponse> {
	const body = request.body ?? "";
	const head = [
		`${request.method} ${request.target} HTTP/1.1`,
		`Host: ${request.host}`,
		...(request.cookie ? [`Cookie: ${request.cookie}`] : []),
		...(request.method === "POST" ? ["Content-Type: application/json", `Content-Length: ${String(Buffer.byteLength(body))}`] : []),
		"Connection: close",
		"",
		"",
	].join("\r\n");
	return new Promise((resolvePromise, reject) => {
		const socket = connect(port, "127.0.0.1");
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`no answer to ${request.method} ${request.target}`));
		}, 5_000);
		socket.on("connect", () => socket.write(head + body));
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			const raw = Buffer.concat(chunks).toString("utf8");
			const split = raw.indexOf("\r\n\r\n");
			const responseHead = split < 0 ? raw : raw.slice(0, split);
			const status = Number.parseInt(responseHead.split(" ")[1] ?? "", 10);
			resolvePromise({ status, head: responseHead, body: split < 0 ? "" : raw.slice(split + 4) });
		});
	});
}

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to allocate a port");
	return port;
}

function expectNothingAboutTheCheckout(response: RawResponse): void {
	expect(response.body).not.toContain(CHECKOUT);
	expect(response.body).not.toContain("server.ts");
	expect(response.body).not.toContain("__bunfallback");
}

describe("request paths on a running server", () => {
	let home = "";
	let port = 0;
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
	let serverLog = "";
	let clientCookie = "";
	let checkCookie: (minutesAgo: number) => string = () => "";

	beforeAll(async () => {
		home = await mkdtemp(join(await realpath(tmpdir()), "pi-web-paths-"));
		port = await freePort();
		const hostRegistry = join(home, "broken-hosts.json");
		await writeFile(hostRegistry, "{ not json", { mode: 0o600 });
		proc = Bun.spawn({
			cmd: [process.execPath, "src/server.ts"],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...sandboxServerEnv(home, {
					PI_WEB_PORT: String(port),
					PI_WEB_ALLOWED_ORIGINS: `http://${REMOTE_HOST}`,
					PI_WEB_TERMINALS: "off",
					PI_WEB_HOST_REGISTRY: hostRegistry,
				}),
				PI_WEB_HOME: home,
			},
		});
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr) serverLog += decoder.decode(chunk, { stream: true });
		})();
		const deadline = Date.now() + 5_000;
		let healthy = false;
		while (!healthy && Date.now() < deadline) {
			healthy = await fetch(`http://127.0.0.1:${String(port)}/health`).then(
				(res) => res.ok,
				() => false,
			);
			if (!healthy) await Bun.sleep(50);
		}
		if (!healthy) throw new Error("server did not become healthy");

		const signer = createCookieSigner(await readFile(join(home, "cookie-key")));
		const clientId = crypto.randomUUID();
		clientCookie = `pi_web_client=${signer.sign({ kind: "client", clientId, exp: Date.now() + 3_600_000, dev: null })}`;
		checkCookie = (minutesAgo) => {
			const verifiedAt = Date.now() - minutesAgo * 60_000;
			const token = signer.sign({ kind: "faceid", clientId, rpId: REMOTE_HOST, verifiedAt, exp: verifiedAt + 4 * 3_600_000, jti: crypto.randomUUID(), dev: null });
			return `${clientCookie}; pi_web_faceid=${token}`;
		};
	});

	afterAll(async () => {
		proc?.kill();
		await proc?.exited.catch(() => undefined);
		await rm(home, { recursive: true, force: true });
	});

	const remote = (method: string, target: string, cookie: string, body?: string) => rawRequest(port, { method, target, host: REMOTE_HOST, cookie, body });

	const gatedRoutes = [
		{ name: "takeover", target: "api/sessions/x/takeover", body: "{}", dispatched: "Session not running" },
		{ name: "command", target: "api/sessions/x/command", body: JSON.stringify({ type: "abort" }), dispatched: "Session not running" },
		{ name: "terminals", target: "api/terminals", body: "{}", dispatched: "Terminals are off" },
	];

	for (const route of gatedRoutes) {
		test(`canonical ${route.name} needs Face ID, and reaches its handler with a check`, async () => {
			const unchecked = await remote("POST", `/${route.target}`, clientCookie, route.body);
			expect(unchecked.status).toBe(401);
			expect(unchecked.body).toContain("Face ID verification required.");
			const checked = await remote("POST", `/${route.target}`, checkCookie(1), route.body);
			expect(checked.status).toBe(404);
			expect(checked.body).toContain(route.dispatched);
		});

		for (const prefix of ["//", "///", "/\\"]) {
			test(`${prefix}${route.target} is a bad request, never its handler`, async () => {
				const response = await remote("POST", `${prefix}${route.target}`, clientCookie, route.body);
				expect(response.status).toBe(400);
				expect(response.body).toBe("Bad request");
			});
		}
	}

	test("an empty segment inside an api path is a bad request too", async () => {
		const response = await remote("POST", "/api//sessions/x/release", checkCookie(20), "{}");
		expect(response.status).toBe(400);
		expect(response.body).toBe("Bad request");
	});

	test("a trailing slash gets its canonical path's gate and freshness, or a 404", async () => {
		const stale = checkCookie(20);
		const answer = async (target: string, cookie = stale) => {
			const response = await remote("POST", target, cookie, "{}");
			return [response.status, response.body.includes("Fresh Face ID") ? "fresh" : response.body.includes("Session not running") ? "dispatched" : response.body];
		};
		expect(await answer("/api/sessions")).toEqual([401, "fresh"]);
		expect(await answer("/api/sessions/")).toEqual([404, "Not found"]);
		expect(await answer("/api/repos")).toEqual([401, "fresh"]);
		expect(await answer("/api/repos/")).toEqual([404, "Not found"]);
		expect(await answer("/api/sessions/x/release")).toEqual([401, "fresh"]);
		expect(await answer("/api/sessions/x/release/")).toEqual([401, "fresh"]);
		expect(await answer("/api/sessions/x/takeover")).toEqual([404, "dispatched"]);
		expect(await answer("/api/sessions/x/takeover/")).toEqual([404, "dispatched"]);
		expect((await remote("POST", "/api/terminals/", clientCookie, "{}")).status).toBe(401);
	});

	test("static files still serve", async () => {
		const index = await remote("GET", "/", "");
		expect(index.status).toBe(200);
		expect(index.head.toLowerCase()).toContain("content-type: text/html");
		const main = await remote("GET", "/app/main.js", "");
		expect(main.status).toBe(200);
		expect(main.head.toLowerCase()).toContain("javascript");
	});

	test("a directory, or a path through a file, is a 404 with nothing about the checkout", async () => {
		for (const target of ["/app", "/app/", "/index.html/x"]) {
			const response = await remote("GET", target, "");
			expect(response.status).toBe(404);
			expectNothingAboutTheCheckout(response);
		}
	});

	test("a malformed Host is a 400 with nothing about the checkout, allowed host or not", async () => {
		for (const host of [`${REMOTE_HOST}:99999`, "evil.example:99999"]) {
			const response = await rawRequest(port, { method: "GET", target: "/", host });
			expect(response.status).toBe(400);
			expect(response.body).toBe("Bad request");
			expectNothingAboutTheCheckout(response);
		}
	});

	test("an error a handler throws is a plain 500 with nothing about the checkout", async () => {
		const response = await rawRequest(port, { method: "GET", target: "/api/hosts", host: `127.0.0.1:${String(port)}` });
		expect(response.status).toBe(500);
		expect(response.body).toBe("Internal server error");
		expect(response.body).not.toContain(home);
		expectNothingAboutTheCheckout(response);
		const deadline = Date.now() + 2_000;
		while (!serverLog.includes("[pi-web] request failed") && Date.now() < deadline) await Bun.sleep(20);
		expect(serverLog).toContain("[pi-web] request failed");
		expect(serverLog).toContain("JSON Parse error");
	});
});
