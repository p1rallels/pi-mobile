import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { PiWebRuntime, type SessionClient } from "./session-runtime.ts";
import { FaceIdService } from "./faceid.ts";
import type {
	ApiCommandRequest,
	ApiActiveSessionsResponse,
	ApiAddRepoRequest,
	ApiCreateSessionRequest,
	ApiErrorResponse,
	ApiListModelsResponse,
	ApiListReposResponse,
	ApiListSessionsResponse,
	ApiOkResponse,
	ApiReleaseRequest,
	ApiSessionState,
	ApiTakeoverRequest,
	SseEvent,
} from "./types.ts";

interface ServerArgs {
	host: string;
	port: number;
	token: string | null;
	tls: { certFile: string; keyFile: string } | null;
}

function stripBrackets(host: string): string {
	const trimmed = host.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
	return trimmed;
}

function parseIpv4(host: string): [number, number, number, number] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	const nums = parts.map((p) => Number.parseInt(p, 10));
	if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
	return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isTailnetHost(host: string): boolean {
	const normalized = stripBrackets(host).trim().toLowerCase();
	const base = normalized.split("%")[0] || normalized;
	const ip4 = parseIpv4(base);
	if (ip4) {
		const [a, b] = ip4;
		// Tailscale IPv4 addresses live in 100.64.0.0/10.
		return a === 100 && b >= 64 && b <= 127;
	}

	// Tailscale IPv6 ULA prefix is fd7a:115c:a1e0::/48.
	return base.startsWith("fd7a:115c:a1e0:");
}

function isAnyAddressHost(host: string): boolean {
	const normalized = stripBrackets(host).trim().toLowerCase();
	return (
		normalized === "0.0.0.0" ||
		normalized === "::" ||
		normalized === "0:0:0:0:0:0:0:0"
	);
}

function parseArgs(argv: string[]): ServerArgs {
	const args = argv.slice(2);
	let host = process.env.PI_WEB_HOST?.trim() || "localhost";
	let port = Number.parseInt(process.env.PI_WEB_PORT?.trim() || "4317", 10);
	let token = process.env.PI_WEB_TOKEN?.trim() || null;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--host" && i + 1 < args.length) {
			host = args[++i];
		} else if (arg === "--port" && i + 1 < args.length) {
			port = Number.parseInt(args[++i] ?? "", 10);
		} else if (arg === "--token" && i + 1 < args.length) {
			token = args[++i] ?? null;
		} else if (arg === "--help" || arg === "-h") {
			console.log(`pi-web

Usage:
  bun run dev [--host <host>] [--port <port>] [--token <token>]

Env:
  PI_WEB_HOST
  PI_WEB_PORT
  PI_WEB_TOKEN
`);
			process.exit(0);
		}
	}

	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid port: ${String(port)}`);
	}
	if (isAnyAddressHost(host)) {
		throw new Error(
			"Binding to 0.0.0.0/:: is disabled. Use localhost/127.0.0.1 (local) or your Tailscale IP (100.x or fd7a:115c:a1e0::/48).",
		);
	}

	let tls: ServerArgs["tls"] = null;
	if (isTailnetHost(host)) {
		const tlsDir = join(import.meta.dir, "..", ".tls");
		const certs = existsSync(tlsDir)
			? (Bun.spawnSync(["ls", tlsDir]).stdout.toString().trim().split("\n"))
			: [];
		const certFile = certs.find((f) => f.endsWith(".crt"));
		const keyFile = certs.find((f) => f.endsWith(".key"));
		if (certFile && keyFile) {
			tls = { certFile: join(tlsDir, certFile), keyFile: join(tlsDir, keyFile) };
		}
	}

	return { host, port, token, tls };
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	if (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized === "0:0:0:0:0:0:0:1"
	) {
		return true;
	}
	return normalized.startsWith("127.");
}

function resolveBearerToken(req: Request): string | null {
	const headerValue = req.headers.get("authorization");
	if (!headerValue) return null;
	const normalized = headerValue.trim();
	if (!normalized.toLowerCase().startsWith("bearer ")) return null;
	const token = normalized.slice(7).trim();
	return token.length > 0 ? token : null;
}

function resolveRequestToken(req: Request, url: URL): string | null {
	return url.searchParams.get("token")?.trim() || resolveBearerToken(req);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function ok(): Response {
	const body: ApiOkResponse = { ok: true };
	return json(body, 200);
}

function errorResponse(message: string, status: number): Response {
	const body: ApiErrorResponse = { error: message };
	return json(body, status);
}

function serveStatic(path: string, contentType?: string): Response {
	if (!existsSync(path)) {
		return new Response("Not found", { status: 404 });
	}
	const file = Bun.file(path);
	return new Response(file, {
		status: 200,
		headers: {
			"content-type": contentType ?? file.type ?? "application/octet-stream",
			"cache-control": "no-store",
		},
	});
}

function createSseStream(signal: AbortSignal) {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let keepAlive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			keepAlive = setInterval(() => {
				if (!controller) return;
				controller.enqueue(encoder.encode(`: ping\n\n`));
			}, 5_000);
		},
		cancel() {
			controller = null;
			if (keepAlive) clearInterval(keepAlive);
			keepAlive = null;
		},
	});

	const close = () => {
		if (!controller) return;
		try {
			controller.close();
		} catch {
			// ignore
		}
		controller = null;
		if (keepAlive) clearInterval(keepAlive);
		keepAlive = null;
	};

	const send = (event: SseEvent) => {
		if (!controller) return;
		controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	};

	signal.addEventListener("abort", close, { once: true });

	const response = new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
		},
	});

	return { response, send, close };
}

const runtime = new PiWebRuntime();
const faceId = new FaceIdService();
const { host, port, token, tls } = parseArgs(process.argv);
const requiresAuth = !isLoopbackHost(host) && !isTailnetHost(host);
const replayEnabled = process.env.PI_WEB_REPLAY?.trim() === "1";

if (requiresAuth && !token) {
	throw new Error(`Missing token. Provide --token <token> or set PI_WEB_TOKEN when binding to non-loopback host (${host}).`);
}

const publicDir = join(import.meta.dir, "..", "public");
const publicRoot = resolve(publicDir) + sep;
const simpleWebAuthnBrowserDir = join(import.meta.dir, "..", "node_modules", "@simplewebauthn", "browser", "esm");
const simpleWebAuthnBrowserRoot = resolve(simpleWebAuthnBrowserDir) + sep;
const simpleWebAuthnBrowserUrlPrefix = "/vendor/simplewebauthn/browser/esm/";

function requireJsonBody(req: Request): Promise<Record<string, unknown>> {
	return req.json().catch(() => ({}));
}

function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

function ensureApiAuth(req: Request, url: URL): Response | null {
	if (!requiresAuth) return null;
	if (!isApiPath(url.pathname)) return null;
	const provided = resolveRequestToken(req, url);
	if (provided !== token) {
		return errorResponse("Unauthorized. Provide ?token=... or Authorization: Bearer <token>.", 401);
	}
	return null;
}

function resolvePublicFile(url: URL): string | null {
	let relPath = url.pathname.replace(/^\/+/, "");
	if (!relPath) return null;

	// Disallow replay fixtures unless explicitly enabled.
	if (relPath.startsWith("fixtures/") && !replayEnabled) return null;

	try {
		relPath = decodeURIComponent(relPath);
	} catch {
		return null;
	}

	const full = resolve(publicDir, relPath);
	if (!full.startsWith(publicRoot)) return null;
	return full;
}

function resolveSimpleWebAuthnBrowserFile(url: URL): string | null {
	if (!url.pathname.startsWith(simpleWebAuthnBrowserUrlPrefix)) return null;
	let relPath = url.pathname.slice(simpleWebAuthnBrowserUrlPrefix.length).replace(/^\/+/, "");
	if (!relPath) return null;

	try {
		relPath = decodeURIComponent(relPath);
	} catch {
		return null;
	}

	const full = resolve(simpleWebAuthnBrowserDir, relPath);
	if (!full.startsWith(simpleWebAuthnBrowserRoot)) return null;
	return full;
}

function parseSessionRoute(pathname: string): { sessionId: string; action: string } | null {
	const parts = pathname.split("/").filter((p) => p.length > 0);
	if (parts.length !== 4) return null;
	if (parts[0] !== "api" || parts[1] !== "sessions") return null;
	return { sessionId: parts[2], action: parts[3] };
}

Bun.serve({
	hostname: host,
	port,
	...(tls ? { tls: { cert: Bun.file(tls.certFile), key: Bun.file(tls.keyFile) } } : {}),
	async fetch(req): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/health") {
			return json({ ok: true }, 200);
		}

		const authError = ensureApiAuth(req, url);
		if (authError) return authError;

		if (req.method === "GET" && url.pathname === "/") {
			return serveStatic(join(publicDir, "index.html"), "text/html; charset=utf-8");
		}
		if (req.method === "GET" && url.pathname === "/favicon.ico") {
			return new Response(null, { status: 204 });
		}

		if (req.method === "GET" && url.pathname.startsWith(simpleWebAuthnBrowserUrlPrefix)) {
			const filePath = resolveSimpleWebAuthnBrowserFile(url);
			if (filePath) return serveStatic(filePath);
			return new Response("Not found", { status: 404 });
		}

		if (req.method === "GET" && !isApiPath(url.pathname)) {
			const filePath = resolvePublicFile(url);
			if (filePath) return serveStatic(filePath);
		}

		if (req.method === "GET" && url.pathname === "/api/sessions") {
			const sessions = await runtime.listSessions();
			const cwdFilter = url.searchParams.get("cwd")?.trim();
			const filtered =
				cwdFilter && cwdFilter.length > 0 ? sessions.filter((s) => typeof s.cwd === "string" && s.cwd === cwdFilter) : sessions;
			const body: ApiListSessionsResponse = { sessions: filtered };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/models") {
			const models = await runtime.listModels();
			const body: ApiListModelsResponse = { models };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/active-sessions") {
			const sessions = runtime.listActiveSessions();
			const body: ApiActiveSessionsResponse = { sessions };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/repos") {
			const repos = await runtime.listRepos();
			const body: ApiListReposResponse = { repos };
			return json(body, 200);
		}

                if (req.method === "GET" && url.pathname === "/api/faceid/status") {
                        try {
                                const body = await faceId.status(url.hostname);
                                return json(body, 200);
                        } catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                return errorResponse(message, 400);
                        }
                }

		if (req.method === "POST" && url.pathname === "/api/repos") {
			const raw = (await requireJsonBody(req)) as ApiAddRepoRequest;
			if (!raw?.cwd || typeof raw.cwd !== "string") {
				return errorResponse("Missing cwd", 400);
			}
			try {
				await runtime.addRepo(raw.cwd);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

                if (req.method === "POST" && url.pathname === "/api/faceid/challenge") {
                        const raw = (await requireJsonBody(req)) as { kind?: unknown };
                        const kind = raw?.kind;
                        if (kind !== "register" && kind !== "authenticate") {
                                return errorResponse("Invalid faceid challenge kind", 400);
                        }
                        try {
                                const result = await faceId.createChallenge(kind, url.hostname, url.origin);
                                return json(result, 200);
                        } catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                return errorResponse(message, 400);
                        }
                }

                if (req.method === "POST" && url.pathname === "/api/faceid/verify") {
                        const raw = (await requireJsonBody(req)) as { challengeId?: unknown; credential?: unknown };
                        if (typeof raw?.challengeId !== "string" || raw.challengeId.length === 0) {
                                return errorResponse("Missing challengeId", 400);
                        }
                        try {
                                const result = await faceId.verify(raw.challengeId, raw.credential);
                                return json(result, 200);
                        } catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                return errorResponse(message, 400);
                        }
                }

		if (req.method === "POST" && url.pathname === "/api/sessions") {
			const raw = (await requireJsonBody(req)) as ApiCreateSessionRequest;
			try {
				const result = await runtime.startSession(raw);
				return json(result, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		const sessionRoute = parseSessionRoute(url.pathname);
		if (!sessionRoute) {
			return new Response("Not found", { status: 404 });
		}

		const { sessionId, action } = sessionRoute;

		if (req.method === "GET" && action === "state") {
			try {
				const state: ApiSessionState = runtime.getSessionState(sessionId);
				return json(state, 200);
			} catch {
				return errorResponse("Session not running", 404);
			}
		}

		if (req.method === "GET" && action === "events") {
			const clientId = url.searchParams.get("clientId")?.trim() || randomUUID();
			let state: ApiSessionState;
			try {
				state = runtime.getSessionState(sessionId);
			} catch {
				return errorResponse("Session not running", 404);
			}

			const stream = createSseStream(req.signal);
			const client: SessionClient = {
				clientId,
				send: stream.send,
				close: stream.close,
			};

			let role: ReturnType<typeof runtime.getSessionRole>["role"];
			let controllerClientId: string | null;
			try {
				runtime.addClient(sessionId, client);
				const resolved = runtime.getSessionRole(sessionId, clientId);
				role = resolved.role;
				controllerClientId = resolved.controllerClientId;
			} catch {
				stream.close();
				return errorResponse("Session not running", 404);
			}

			const init: SseEvent = {
				type: "init",
				state,
				yourClientId: clientId,
				controllerClientId,
				role,
			};
			stream.send(init);

			req.signal.addEventListener(
				"abort",
				() => {
					runtime.removeClient(sessionId, clientId);
				},
				{ once: true },
			);

			return stream.response;
		}

		if (req.method === "POST" && action === "command") {
			const raw = (await requireJsonBody(req)) as ApiCommandRequest;
			if (!raw || typeof raw !== "object" || typeof raw.type !== "string") {
				return errorResponse("Invalid command payload", 400);
			}
			try {
				await runtime.handleCommand(sessionId, raw);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "not_controller") return errorResponse("Not controller", 403);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "takeover") {
			const raw = (await requireJsonBody(req)) as ApiTakeoverRequest;
			if (!raw?.clientId || typeof raw.clientId !== "string") {
				return errorResponse("Missing clientId", 400);
			}
			try {
				runtime.takeover(sessionId, raw);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "cannot_takeover_while_streaming") return errorResponse("Cannot take over while streaming", 409);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "release") {
			const raw = (await requireJsonBody(req)) as ApiReleaseRequest;
			if (!raw?.clientId || typeof raw.clientId !== "string") {
				return errorResponse("Missing clientId", 400);
			}
			try {
				await runtime.release(sessionId, raw);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "not_controller") return errorResponse("Not controller", 403);
				return errorResponse(message, 400);
			}
		}

		return new Response("Not found", { status: 404 });
	},
});

const scheme = tls ? "https" : "http";
const baseUrl = `${scheme}://${host}:${port}`;
console.log(`pi-web listening on ${baseUrl}`);
if (tls) {
	console.log("TLS enabled with Tailscale certs.");
}
if (requiresAuth && token) {
	console.log(`Token required (non-loopback bind). Open: ${baseUrl}/?token=${token}`);
	console.log(`API scripts: Authorization: Bearer ${token}`);
} else if (isTailnetHost(host)) {
	console.log("Tailscale IP detected: token auth disabled; rely on tailnet ACLs.");
}
