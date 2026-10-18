import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { VERSION as PI_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CANVAS_LAYOUT_BODY_LIMIT, createCanvasLayoutStore } from "./canvas-layout.ts";
import { verifyClientCertificateRequest } from "./device-auth.ts";
import { isTypedPath, listDirectories } from "./directories.ts";
import { parseExtensionUiResponse } from "./extension-ui.ts";
import { FaceIdService } from "./faceid.ts";
import { isProjectTrustChoice, parseProjectTrustMode, ProjectTrustRequiredError } from "./project-trust.ts";
import { parseTripwireMode } from "./tripwire.ts";
import { loadHostRegistry } from "./host-registry.ts";
import { resolvePiWebPaths } from "./security-config.ts";
import { createCookieSigner, loadOrCreateCookieKey } from "./signed-cookies.ts";
import { AmbiguousWritersError, NeverSavedError, PiWebRuntime, RunningElsewhereError, type FollowClient, type SessionClient } from "./session-runtime.ts";
import { resolveResumeCursor, sseEventFrame, ssePingFrame, sseRetryFrame, SSE_PING_INTERVAL_MS } from "./sse.ts";
import { createTerminalManager, parseTerminalsMode } from "./terminals.ts";
import type {
	ApiActiveSessionsResponse,
	ApiAddRepoRequest,
	ApiAddRepoResponse,
	ApiCommandRequest,
	ApiCommandResponse,
	ApiCreateSessionRequest,
	ApiDirectoryListing,
	ApiErrorResponse,
	ApiListHostsResponse,
	ApiListModelsResponse,
	ApiListReposResponse,
	ApiListSessionsResponse,
	ApiOkResponse,
	ApiProjectTrustRequiredResponse,
	ApiRepoSuggestionsResponse,
	ApiReleaseRequest,
	ApiRunningElsewhereResponse,
	ApiSessionFileTranscriptResponse,
	ApiSessionMissingResponse,
	ApiSessionState,
	ApiStopElsewhereRequest,
	ApiStopElsewhereResponse,
	ApiTakeoverRequest,
	ApiTerminalLockedResponse,
	ApiTerminalMissingResponse,
	ApiTranscriptPageResponse,
	ApiTripwireAlertsResponse,
	FollowSseEvent,
	SseEvent,
} from "./types.ts";

interface ServerArgs {
	host: string;
	port: number;
	trustProxy: boolean;
	tls: { certFile: string; keyFile: string } | null;
	allowedOrigins: string[];
	maxRunningSessions: number;
	maxClientsPerSession: number;
	idleSessionMinutes: number;
	secureMode: boolean;
	deviceRegistryPath: string;
	hostRegistryPath: string;
	clientCertHeader: string;
}

interface CookieOptions {
	maxAge?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
	path?: string;
}

interface RateLimitResult {
	retryAfterSeconds: number;
}

/** What a terminal tile's websocket carries from its upgrade request. */
interface TerminalSocketData {
	terminalId: string;
	/** The browser it was opened from: locking that browser's terminals closes it. */
	clientId: string;
	/** When the Face ID check it was let in on passed, or null on hosts that don't check. */
	checkedAt: number | null;
	cols: string | null;
	rows: string | null;
}

const CLIENT_COOKIE = "pi_web_client";
const FACEID_COOKIE = "pi_web_faceid";
/** A page going away locks its browser's terminals here (POST, no body). */
const TERMINAL_LOCK_PATH = "/api/terminals/lock";

const CLIENT_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const FACEID_TTL_MS = 60_000 * parsePositiveInt(process.env.PI_WEB_FACEID_SESSION_MINUTES, 240, "PI_WEB_FACEID_SESSION_MINUTES");
/** Starting sessions, adding repos and releasing need a recent Face ID check; the browser asks again when you come back after this long. */
const FACEID_FRESH_TTL_MS = 60_000 * parsePositiveInt(process.env.PI_WEB_FACEID_FRESH_MINUTES, 15, "PI_WEB_FACEID_FRESH_MINUTES");
/** Prompts, aborts, settings and take over need a check within this window. */
const FACEID_COMMAND_TTL_MS = 60_000 * parsePositiveInt(process.env.PI_WEB_FACEID_COMMAND_MINUTES, 60, "PI_WEB_FACEID_COMMAND_MINUTES");
/** A terminal's shell ends this long after the last Face ID check on the host (every check pushes it back): the fresh window. */
const TERMINAL_TTL_MS = FACEID_FRESH_TTL_MS;

const DEFAULT_JSON_BODY_LIMIT = 256 * 1024;
const CANVAS_STATUS_THROTTLE_MS = 250;
const COMMAND_JSON_BODY_LIMIT = 64 * 1024;
const UI_RESPONSE_JSON_BODY_LIMIT = 1024 * 1024;
const MAX_PROMPT_CHARS = 32_000;

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
	if (!raw) return fallback;
	const value = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid ${name}: ${String(raw)}`);
	}
	return value;
}

function createRateLimiter(windowMs: number, maxHits: number) {
	const buckets = new Map<string, { count: number; resetAt: number }>();

	function prune(now = Date.now()): void {
		for (const [key, bucket] of buckets.entries()) {
			if (bucket.resetAt <= now) {
				buckets.delete(key);
			}
		}
	}

	return {
		check(key: string): RateLimitResult | null {
			const now = Date.now();
			prune(now);
			const bucket = buckets.get(key);
			if (!bucket || bucket.resetAt <= now) {
				buckets.set(key, { count: 1, resetAt: now + windowMs });
				return null;
			}
			if (bucket.count >= maxHits) {
				return { retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
			}
			bucket.count += 1;
			return null;
		},
	};
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
		return a === 100 && b >= 64 && b <= 127;
	}
	return base.startsWith("fd7a:115c:a1e0:");
}

function isAnyAddressHost(host: string): boolean {
	const normalized = stripBrackets(host).trim().toLowerCase();
	return normalized === "0.0.0.0" || normalized === "::" || normalized === "0:0:0:0:0:0:0:0";
}

function isLoopbackHost(host: string): boolean {
	const normalized = stripBrackets(host).trim().toLowerCase();
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

function defaultPortForProtocol(protocol: string): string {
	if (protocol === "https:") return "443";
	return "80";
}

function formatHostForUrl(host: string): string {
	const normalized = stripBrackets(host).trim();
	return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function normalizeOrigin(input: string): string {
	const parsed = new URL(input.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported origin protocol: ${parsed.protocol}`);
	}
	return parsed.origin;
}

function buildOrigin(protocol: string, host: string, port: number): string {
	return new URL(`${protocol}//${formatHostForUrl(host)}:${String(port)}`).origin;
}

function deriveAllowedOrigins(host: string, port: number, protocol: string, extraOrigins: string[]): string[] {
	const origins = new Set<string>([buildOrigin(protocol, host, port)]);
	if (isLoopbackHost(host)) {
		origins.add(buildOrigin(protocol, "localhost", port));
		origins.add(buildOrigin(protocol, "127.0.0.1", port));
		origins.add(buildOrigin(protocol, "::1", port));
	}
	for (const raw of extraOrigins) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		origins.add(normalizeOrigin(trimmed));
	}
	return [...origins];
}

function canonicalHostPort(hostname: string, port: string, protocol: string): string {
	const normalizedHost = stripBrackets(hostname).trim().toLowerCase().replace(/\.$/, "");
	const resolvedPort = port || defaultPortForProtocol(protocol);
	return `${normalizedHost}:${resolvedPort}`;
}

function normalizeHostHeader(hostHeader: string | null, protocol: string): string | null {
	if (!hostHeader) return null;
	try {
		const parsed = new URL(`${protocol}//${hostHeader.trim()}`);
		return canonicalHostPort(parsed.hostname, parsed.port, protocol);
	} catch {
		return null;
	}
}

function collectAllowedHostPorts(origins: string[]): Set<string> {
	const allowed = new Set<string>();
	for (const origin of origins) {
		const parsed = new URL(origin);
		allowed.add(canonicalHostPort(parsed.hostname, parsed.port, parsed.protocol));
	}
	return allowed;
}

function collectAllowedHostNames(origins: string[]): Set<string> {
	const allowed = new Set<string>();
	for (const origin of origins) {
		const parsed = new URL(origin);
		allowed.add(stripBrackets(parsed.hostname).trim().toLowerCase().replace(/\.$/, ""));
	}
	return allowed;
}

function resolveRequestOrigin(req: Request): string | null {
	const directOrigin = req.headers.get("origin");
	if (directOrigin) {
		try {
			return normalizeOrigin(directOrigin);
		} catch {
			return "__invalid_origin__";
		}
	}

	const referer = req.headers.get("referer");
	if (!referer) return null;
	try {
		return new URL(referer).origin;
	} catch {
		return "__invalid_origin__";
	}
}

function parseArgs(argv: string[]): ServerArgs {
	const args = argv.slice(2);
	let host = process.env.PI_WEB_HOST?.trim() || "localhost";
	let port = Number.parseInt(process.env.PI_WEB_PORT?.trim() || "4317", 10);
	if (process.env.PI_WEB_TOKEN?.trim()) {
		throw new Error("PI_WEB_TOKEN has been removed. Use secure mode with mTLS device certificates instead.");
	}
	const trustProxy = process.env.PI_WEB_TRUST_PROXY?.trim() === "1";
	const allowDirectTailnet = process.env.PI_WEB_ALLOW_DIRECT_TAILSCALE?.trim() === "1";
	let secureMode = process.env.PI_WEB_SECURE_MODE?.trim() === "1";
	const piWebPaths = resolvePiWebPaths();
	const deviceRegistryPath = process.env.PI_WEB_DEVICE_REGISTRY?.trim() || piWebPaths.devicesPath;
	const hostRegistryPath = process.env.PI_WEB_HOST_REGISTRY?.trim() || piWebPaths.hostsPath;
	const clientCertHeader = process.env.PI_WEB_CLIENT_CERT_HEADER?.trim() || "x-pi-web-client-cert-fingerprint";
	const maxRunningSessions = parsePositiveInt(process.env.PI_WEB_MAX_RUNNING_SESSIONS, 24, "PI_WEB_MAX_RUNNING_SESSIONS");
	const maxClientsPerSession = parsePositiveInt(process.env.PI_WEB_MAX_CLIENTS_PER_SESSION, 8, "PI_WEB_MAX_CLIENTS_PER_SESSION");
	const idleSessionMinutes = parsePositiveInt(process.env.PI_WEB_IDLE_SESSION_MINUTES, 15, "PI_WEB_IDLE_SESSION_MINUTES");

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--host" && i + 1 < args.length) {
			host = args[++i];
		} else if (arg === "--port" && i + 1 < args.length) {
			port = Number.parseInt(args[++i] ?? "", 10);
		} else if (arg === "--token") {
			throw new Error("--token has been removed. Use secure mode with mTLS device certificates instead.");
		} else if (arg === "--secure-mode") {
			secureMode = true;
		} else if (arg === "--help" || arg === "-h") {
			console.log(`pi-web

Usage:
  bun run dev [--host <host>] [--port <port>] [--secure-mode]

Env:
  PI_WEB_HOST
  PI_WEB_PORT
  PI_WEB_PUBLIC_ORIGIN
  PI_WEB_ALLOWED_ORIGINS
  PI_WEB_TRUST_PROXY=1
  PI_WEB_MAX_RUNNING_SESSIONS
  PI_WEB_MAX_CLIENTS_PER_SESSION
  PI_WEB_IDLE_SESSION_MINUTES (dispose unwatched idle sessions after this long, default 15)
  PI_WEB_TRIPWIRE=on|off (block critical tool calls, default on)
  PI_WEB_PROJECT_TRUST=always|ask|never (projects without a trust.json decision, default always)
  PI_WEB_TERMINALS=on|off (terminal tiles on the canvas, default on)
  PI_WEB_CLIENT_SESSIONS_PER_MINUTE (browser session handshakes per client IP, default 20)
  PI_WEB_FACEID_SESSION_MINUTES (Face ID session length, default 240)
  PI_WEB_FACEID_COMMAND_MINUTES (Face ID age allowed for prompts and take over, default 60)
  PI_WEB_FACEID_FRESH_MINUTES (Face ID age allowed for new sessions, repos and release, and before the page asks again; terminals close this long after the last check; default 15)
  PI_WEB_SECURE_MODE=1
  PI_WEB_DEVICE_REGISTRY
  PI_WEB_HOST_REGISTRY
  PI_WEB_CLIENT_CERT_HEADER
  PI_WEB_ALLOW_DIRECT_TAILSCALE=1 (insecure escape hatch)
`);
			process.exit(0);
		}
	}

	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid port: ${String(port)}`);
	}
	if (secureMode && !isLoopbackHost(host)) {
		throw new Error("Secure mode requires pi-web to bind to localhost/127.0.0.1 behind a trusted local mTLS proxy.");
	}
	if (!isLoopbackHost(host) && !allowDirectTailnet) {
		throw new Error("Direct non-loopback binding is disabled. Run secure mode behind Caddy mTLS, or set PI_WEB_ALLOW_DIRECT_TAILSCALE=1 for private testing on a Tailscale IP.");
	}
	if (!isLoopbackHost(host) && allowDirectTailnet && !isTailnetHost(host)) {
		throw new Error(`Direct non-loopback binding is only allowed on Tailscale addresses (${host}).`);
	}
	if (isAnyAddressHost(host)) {
		throw new Error(
			"Binding to 0.0.0.0/:: is disabled. Use localhost/127.0.0.1 (local) or your Tailscale IP (100.x or fd7a:115c:a1e0::/48).",
		);
	}

	let tls: ServerArgs["tls"] = null;
	if (isTailnetHost(host)) {
		const tlsDir = join(import.meta.dir, "..", ".tls");
		const certs = existsSync(tlsDir) ? Bun.spawnSync(["ls", tlsDir]).stdout.toString().trim().split("\n") : [];
		const certFile = certs.find((f) => f.endsWith(".crt"));
		const keyFile = certs.find((f) => f.endsWith(".key"));
		if (certFile && keyFile) {
			tls = { certFile: join(tlsDir, certFile), keyFile: join(tlsDir, keyFile) };
		}
	}

	const scheme = tls ? "https:" : "http:";
	const extraOrigins = [
		process.env.PI_WEB_PUBLIC_ORIGIN?.trim() || "",
		...(process.env.PI_WEB_ALLOWED_ORIGINS?.split(",") ?? []),
	];
	const allowedOrigins = deriveAllowedOrigins(host, port, scheme, extraOrigins);

	return {
		host,
		port,
		trustProxy,
		tls,
		allowedOrigins,
		maxRunningSessions,
		maxClientsPerSession,
		idleSessionMinutes,
		secureMode,
		deviceRegistryPath,
		hostRegistryPath,
		clientCertHeader,
	};
}

function parseCookies(req: Request): Map<string, string> {
	const cookies = new Map<string, string>();
	const headerValue = req.headers.get("cookie");
	if (!headerValue) return cookies;

	for (const part of headerValue.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex <= 0) continue;
		const name = trimmed.slice(0, eqIndex).trim();
		const value = trimmed.slice(eqIndex + 1).trim();
		try {
			cookies.set(name, decodeURIComponent(value));
		} catch {
			cookies.set(name, value);
		}
	}

	return cookies;
}

function buildSetCookie(name: string, value: string, options: CookieOptions = {}): string {
	const parts = [`${name}=${encodeURIComponent(value)}`];
	parts.push(`Path=${options.path ?? "/"}`);
	parts.push(`SameSite=${options.sameSite ?? "Strict"}`);
	if (typeof options.maxAge === "number" && Number.isFinite(options.maxAge)) {
		parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
	}
	if (options.httpOnly !== false) parts.push("HttpOnly");
	if (options.secure) parts.push("Secure");
	return parts.join("; ");
}

function clearCookie(name: string, secure: boolean): string {
	return buildSetCookie(name, "", { maxAge: 0, httpOnly: true, secure });
}

function isSecureRequest(req: Request, url: URL, trustProxy: boolean): boolean {
	if (url.protocol === "https:") return true;
	if (!trustProxy) return false;
	return req.headers.get("x-forwarded-proto")?.toLowerCase() === "https";
}

function parseContentLength(req: Request): number | null {
	const raw = req.headers.get("content-length");
	if (!raw) return null;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value < 0) return null;
	return value;
}

function applySecurityHeaders(headers: Headers): void {
	headers.set("x-content-type-options", "nosniff");
	headers.set("referrer-policy", "no-referrer");
	headers.set("cross-origin-resource-policy", "same-origin");
	headers.set("x-frame-options", "DENY");
	headers.set(
		"content-security-policy",
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
	);
	headers.set(
		"permissions-policy",
		"accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
	);
	if (enableHsts) {
		headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
	}
}

function json(body: unknown, status = 200, extraHeaders?: Bun.HeadersInit): Response {
	const headers = new Headers(extraHeaders);
	applySecurityHeaders(headers);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.set("cache-control", "no-store");
	return new Response(JSON.stringify(body), { status, headers });
}

function ok(extraHeaders?: Bun.HeadersInit): Response {
	const body: ApiOkResponse = { ok: true };
	return json(body, 200, extraHeaders);
}

function errorResponse(message: string, status: number, extraHeaders?: Bun.HeadersInit): Response {
	const body: ApiErrorResponse = { error: message };
	return json(body, status, extraHeaders);
}

function plainText(body: string | null, status = 200, extraHeaders?: Bun.HeadersInit): Response {
	const headers = new Headers(extraHeaders);
	applySecurityHeaders(headers);
	headers.set("cache-control", "no-store");
	if (body !== null) {
		headers.set("content-type", "text/plain; charset=utf-8");
	}
	return new Response(body, { status, headers });
}

function serveStatic(path: string, contentType?: string): Response {
	if (!existsSync(path)) {
		return plainText("Not found", 404);
	}
	const file = Bun.file(path);
	const headers = new Headers();
	applySecurityHeaders(headers);
	headers.set("content-type", contentType ?? file.type ?? "application/octet-stream");
	headers.set("cache-control", "no-store");
	return new Response(file, { status: 200, headers });
}

function createSseStream(signal: AbortSignal) {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let keepAlive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			controller.enqueue(encoder.encode(sseRetryFrame()));
			keepAlive = setInterval(() => {
				if (!controller) return;
				controller.enqueue(encoder.encode(ssePingFrame()));
			}, SSE_PING_INTERVAL_MS);
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

	const send = (event: SseEvent | FollowSseEvent, id?: string) => {
		if (!controller) return;
		controller.enqueue(encoder.encode(sseEventFrame(event, id)));
	};

	signal.addEventListener("abort", close, { once: true });

	const headers = new Headers({
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
	});
	applySecurityHeaders(headers);

	const response = new Response(stream, {
		status: 200,
		headers,
	});

	return { response, send, close };
}

async function requireJsonBody(req: Request, maxBytes = DEFAULT_JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
	const declaredLength = parseContentLength(req);
	if (declaredLength !== null && declaredLength > maxBytes) {
		throw new Error(`Request body too large (${declaredLength} > ${maxBytes} bytes).`);
	}

	const raw = await req.text();
	if (!raw) return {};
	const byteLength = Buffer.byteLength(raw, "utf8");
	if (byteLength > maxBytes) {
		throw new Error(`Request body too large (${byteLength} > ${maxBytes} bytes).`);
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		throw new Error("Invalid JSON body.");
	}
}

function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

function isFaceIdExemptPath(pathname: string): boolean {
	return (
		pathname === "/api/client" ||
		pathname === "/api/faceid/status" ||
		pathname === "/api/faceid/challenge" ||
		pathname === "/api/faceid/verify" ||
		pathname === "/api/faceid/logout" ||
		// locking only ever takes access away, so a page whose check ran out can still lock
		pathname === TERMINAL_LOCK_PATH
	);
}

function parseSessionRoute(pathname: string): { sessionId: string; action: string } | null {
	const parts = pathname.split("/").filter((p) => p.length > 0);
	if (parts.length !== 4) return null;
	if (parts[0] !== "api" || parts[1] !== "sessions") return null;
	return { sessionId: parts[2], action: parts[3] };
}

/** /api/terminals (list, open) and /api/terminals/<id>[/<action>]. */
function parseTerminalRoute(pathname: string): { id: string | null; action: string | null } | null {
	const parts = pathname.split("/").filter((p) => p.length > 0);
	if (parts[0] !== "api" || parts[1] !== "terminals" || parts.length > 4) return null;
	return { id: parts[2] ?? null, action: parts[3] ?? null };
}

/** How recent the Face ID check must be for a route, or null when any live Face ID session will do. */
function faceIdFreshnessFor(method: string, pathname: string): number | null {
	if (method !== "POST") return null;
	if (pathname === "/api/repos" || pathname === "/api/sessions") return FACEID_FRESH_TTL_MS;
	const sessionRoute = parseSessionRoute(pathname);
	if (!sessionRoute) return null;
	if (sessionRoute.action === "release") return FACEID_FRESH_TTL_MS;
	if (
		sessionRoute.action === "command" ||
		sessionRoute.action === "takeover" ||
		sessionRoute.action === "ui-response" ||
		sessionRoute.action === "stop-elsewhere"
	) {
		return FACEID_COMMAND_TTL_MS;
	}
	return null;
}

/** In secure mode cookies are bound to the mTLS device that received them. */
const requestDevices = new WeakMap<Request, string | null>();

function payloadMatchesRequest(req: Request, payload: Record<string, unknown>): boolean {
	const device = requestDevices.get(req) ?? null;
	return typeof payload.exp === "number" && payload.exp > Date.now() && (payload.dev ?? null) === device;
}

function resolveClientCookie(req: Request): { clientId: string } | null {
	const payload = cookieSigner.verify(parseCookies(req).get(CLIENT_COOKIE));
	if (!payload || payload.kind !== "client" || typeof payload.clientId !== "string" || !payloadMatchesRequest(req, payload)) return null;
	return { clientId: payload.clientId };
}

function resolveFaceIdCookie(req: Request): { rpId: string; clientId: string; verifiedAt: number; jti: string; exp: number } | null {
	const payload = cookieSigner.verify(parseCookies(req).get(FACEID_COOKIE));
	if (!payload || payload.kind !== "faceid" || !payloadMatchesRequest(req, payload)) return null;
	const { rpId, clientId, verifiedAt, jti, exp } = payload;
	if (typeof rpId !== "string" || typeof clientId !== "string" || typeof verifiedAt !== "number" || typeof jti !== "string" || typeof exp !== "number") return null;
	if (revokedFaceIdTokens.has(jti)) return null;
	return { rpId, clientId, verifiedAt, jti, exp };
}

function issueClientCookie(req: Request, clientId: string, secure: boolean): string {
	const token = cookieSigner.sign({ kind: "client", clientId, exp: Date.now() + CLIENT_TTL_MS, dev: requestDevices.get(req) ?? null });
	return buildSetCookie(CLIENT_COOKIE, token, { maxAge: CLIENT_TTL_MS / 1000, httpOnly: true, secure });
}

function issueFaceIdCookie(req: Request, clientId: string, rpId: string, secure: boolean): string {
	const verifiedAt = Date.now();
	const token = cookieSigner.sign({
		kind: "faceid",
		clientId,
		rpId,
		verifiedAt,
		exp: verifiedAt + FACEID_TTL_MS,
		jti: randomUUID(),
		dev: requestDevices.get(req) ?? null,
	});
	return buildSetCookie(FACEID_COOKIE, token, { maxAge: FACEID_TTL_MS / 1000, httpOnly: true, secure });
}

function revokeFaceIdCookie(req: Request): void {
	const now = Date.now();
	for (const [jti, exp] of revokedFaceIdTokens) {
		if (exp <= now) revokedFaceIdTokens.delete(jti);
	}
	const session = resolveFaceIdCookie(req);
	if (session) revokedFaceIdTokens.set(session.jti, session.exp);
}

function canRegisterFaceId(url: URL, credentialCount: number): boolean {
	if (credentialCount !== 0) return false;
	if (isLoopbackHost(url.hostname)) return true;
	return secureMode;
}

function ensureTrustedRequest(req: Request, url: URL, requestProtocol: string): Response | null {
	const requestHost = normalizeHostHeader(req.headers.get("host"), requestProtocol);
	const requestHostname = stripBrackets(url.hostname).trim().toLowerCase().replace(/\.$/, "");
	const exactHostAllowed = requestHost ? allowedHostPorts.has(requestHost) : false;
	const trustedProxyHostnameAllowed = trustProxy && allowedHostNames.has(requestHostname);
	if (!exactHostAllowed && !trustedProxyHostnameAllowed) {
		return errorResponse(
			"Untrusted host header. If you are accessing pi-web through a proxy or tunnel, configure PI_WEB_PUBLIC_ORIGIN or PI_WEB_ALLOWED_ORIGINS.",
			403,
		);
	}

	const requestOrigin = resolveRequestOrigin(req);
	if (requestOrigin && !allowedOriginsSet.has(requestOrigin)) {
		return errorResponse(
			"Untrusted origin. If you are accessing pi-web through a proxy or tunnel, configure PI_WEB_PUBLIC_ORIGIN or PI_WEB_ALLOWED_ORIGINS.",
			403,
		);
	}

	return null;
}

/** The Face ID check this browser passed for this host, if its cookie is live and was issued to this browser session. */
function resolveBrowserFaceIdCheck(req: Request, url: URL, client: { clientId: string } | null): { verifiedAt: number } | null {
	const session = resolveFaceIdCookie(req);
	if (!client || !session || session.rpId !== url.hostname || session.clientId !== client.clientId) return null;
	return session;
}

/**
 * Shells lock apart from the rest of the page. Opening one needs a check from the fresh window and attaching to one (its
 * info, then its socket) a check from the command window, like starting a session and typing a prompt; both also need
 * the check to be newer than the last time this browser locked its terminals, which its pages do whenever they go away.
 * Listing and closing shells need neither. The refusal says terminalLocked so the page locks its terminals, not itself.
 */
function terminalLockError(method: string, route: { id: string | null }, clientId: string, verifiedAt: number): Response | null {
	const maxAge = method === "POST" && !route.id ? FACEID_FRESH_TTL_MS : method === "GET" && route.id ? FACEID_COMMAND_TTL_MS : null;
	if (maxAge === null) return null;
	if (verifiedAt > (terminalLocks.get(clientId) ?? 0) && Date.now() - verifiedAt <= maxAge) return null;
	const body: ApiTerminalLockedResponse = { error: "Terminals are locked: unlock them with Face ID.", terminalLocked: true };
	return json(body, 401);
}

/** A page went away (another tab or app, a locked screen, the phone's terminal closing): its browser's shells lock. */
function lockTerminals(clientId: string): void {
	const now = Date.now();
	// a check older than a lock this old ran out with its Face ID session, so forgetting the lock lets nothing through
	for (const [id, at] of terminalLocks) {
		if (now - at > FACEID_TTL_MS) terminalLocks.delete(id);
	}
	terminalLocks.set(clientId, now);
	for (const socket of [...terminalSockets]) {
		if (socket.data.clientId === clientId) socket.close(4401, "locked");
	}
}

function ensureFaceIdAuth(req: Request, url: URL): Response | null {
	if (!isApiPath(url.pathname)) return null;
	if (isFaceIdExemptPath(url.pathname)) return null;
	const terminalRoute = parseTerminalRoute(url.pathname);
	// in secure mode browsers come through the proxy, so a loopback request is a process on this host: it gets no shell
	if (isLoopbackHost(url.hostname) && !(secureMode && terminalRoute)) return null;

	const client = resolveClientCookie(req);
	if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
	const session = resolveBrowserFaceIdCheck(req, url, client);
	if (!session) return errorResponse("Face ID verification required.", 401);
	if (terminalRoute) return terminalLockError(req.method, terminalRoute, client.clientId, session.verifiedAt);
	const freshness = faceIdFreshnessFor(req.method, url.pathname);
	if (freshness !== null && Date.now() - session.verifiedAt > freshness) {
		return errorResponse("Fresh Face ID verification required.", 401);
	}
	return null;
}

function resolvePublicFile(url: URL): string | null {
	let relPath = url.pathname.replace(/^\/+/, "");
	if (!relPath) return null;
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

/** Resumes a session pi-web disposed for idling when the client names its file via ?path=. */
async function attachIfNeeded(req: Request, url: URL, sessionId: string, requesterId: string): Promise<Response | null> {
	if (runtime.isRunning(sessionId)) return null;
	const path = url.searchParams.get("path")?.trim();
	if (!path) return errorResponse("Session not running", 404);
	const client = resolveClientCookie(req);
	if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
	const limited = sessionCreateLimiter.check(`sessions:${requesterId}`);
	if (limited) return rateLimitResponse(limited);
	try {
		await runtime.attachSession(sessionId, path, client.clientId);
		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "too_many_active_sessions") return errorResponse("Too many active sessions", 429);
		return sessionMissing("Session not running", path, sessionId);
	}
}

/** 404 for a session that isn't there to run or read; one nobody ever sent a message to says so, with its folder. */
async function sessionMissing(message: string, path: string, sessionId?: string): Promise<Response> {
	const neverSaved = await runtime.neverSaved(path, sessionId);
	const body: ApiSessionMissingResponse = { error: message, ...neverSaved };
	return json(body, 404);
}

const isModelRef = (value: unknown): value is { provider: string; id: string } =>
	Boolean(value) && typeof value === "object" && typeof (value as { provider?: unknown }).provider === "string" && typeof (value as { id?: unknown }).id === "string";

function createCookieResponse(body: unknown, status: number, cookieHeader: string): Response {
	return json(body, status, { "set-cookie": cookieHeader });
}

function rateLimitResponse(result: RateLimitResult): Response {
	return errorResponse("Too many requests. Try again shortly.", 429, { "retry-after": String(result.retryAfterSeconds) });
}

function forwardedClientIp(req: Request): string | null {
	const cfConnectingIp = req.headers.get("cf-connecting-ip")?.trim();
	if (cfConnectingIp) return cfConnectingIp;
	const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
	return forwardedFor || null;
}

function resolveRequesterId(req: Request, server: Bun.Server<TerminalSocketData>): string {
	if (trustProxy) {
		const forwarded = forwardedClientIp(req);
		if (forwarded) return forwarded;
	}
	const direct = server.requestIP(req)?.address;
	return typeof direct === "string" && direct.length > 0 ? direct : "__unknown__";
}

const {
	host,
	port,
	trustProxy,
	tls,
	allowedOrigins,
	maxRunningSessions,
	maxClientsPerSession,
	idleSessionMinutes,
	secureMode,
	deviceRegistryPath,
	hostRegistryPath,
	clientCertHeader,
} = parseArgs(process.argv);
const replayEnabled = process.env.PI_WEB_REPLAY?.trim() === "1";
const enableHsts = !isLoopbackHost(host) && (Boolean(tls) || trustProxy);
const allowedOriginsSet = new Set(allowedOrigins);
const allowedHostPorts = collectAllowedHostPorts(allowedOrigins);
const allowedHostNames = collectAllowedHostNames(allowedOrigins);

const clientSessionLimiter = createRateLimiter(
	60_000,
	parsePositiveInt(process.env.PI_WEB_CLIENT_SESSIONS_PER_MINUTE, 20, "PI_WEB_CLIENT_SESSIONS_PER_MINUTE"),
);
const repoMutationLimiter = createRateLimiter(60_000, 12);
// layout saves are debounced drag/resize ends; this only stops a runaway client
const canvasLayoutLimiter = createRateLimiter(60_000, 240);
const canvasLayouts = createCanvasLayoutStore(join(getAgentDir(), "pi-web", "canvas.json"));
const sessionCreateLimiter = createRateLimiter(60_000, 12);
const commandLimiter = createRateLimiter(60_000, 90);
const faceIdChallengeLimiter = createRateLimiter(60_000, 12);
const faceIdVerifyLimiter = createRateLimiter(60_000, 12);
const terminalCreateLimiter = createRateLimiter(60_000, 12);

const projectTrustMode = parseProjectTrustMode(process.env.PI_WEB_PROJECT_TRUST);
const tripwireMode = parseTripwireMode(process.env.PI_WEB_TRIPWIRE);
const terminalsMode = parseTerminalsMode(process.env.PI_WEB_TERMINALS);
const terminals = terminalsMode === "on" ? createTerminalManager() : null;
const runtime = new PiWebRuntime({
	maxRunningSessions,
	maxClientsPerSession,
	idleSessionTtlMs: idleSessionMinutes * 60_000,
	projectTrustMode,
	tripwire: tripwireMode,
});
runtime.startIdleSweep();
const restoredSessions = await runtime.loadDetachedSessions();
const faceId = new FaceIdService(join(getAgentDir(), "pi-web", "faceid-credentials.json"));
const cookieSigner = createCookieSigner(await loadOrCreateCookieKey(join(resolvePiWebPaths().home, "cookie-key")));
const revokedFaceIdTokens = new Map<string, number>();
/** When each browser (client id) last locked its terminals; a shell needs a Face ID check made after that. */
const terminalLocks = new Map<string, number>();
const terminalSockets = new Set<Bun.ServerWebSocket<TerminalSocketData>>();

const publicDir = join(import.meta.dir, "..", "public");
const publicRoot = resolve(publicDir) + sep;
const simpleWebAuthnBrowserDir = join(import.meta.dir, "..", "node_modules", "@simplewebauthn", "browser", "esm");
const simpleWebAuthnBrowserRoot = resolve(simpleWebAuthnBrowserDir) + sep;
const simpleWebAuthnBrowserUrlPrefix = "/vendor/simplewebauthn/browser/esm/";
/** The terminal tiles' browser files, served straight from node_modules (no build step). */
const xtermDir = join(import.meta.dir, "..", "node_modules", "@xterm");
const xtermBrowserFiles = new Map([
	["/vendor/xterm/xterm.mjs", join(xtermDir, "xterm", "lib", "xterm.mjs")],
	["/vendor/xterm/xterm.css", join(xtermDir, "xterm", "css", "xterm.css")],
	["/vendor/xterm/addon-fit.mjs", join(xtermDir, "addon-fit", "lib", "addon-fit.mjs")],
]);

function appendVary(headers: Headers, value: string): void {
	const existing = headers.get("vary");
	if (!existing) {
		headers.set("vary", value);
		return;
	}
	const parts = existing.split(",").map((part) => part.trim().toLowerCase());
	if (!parts.includes(value.toLowerCase())) {
		headers.set("vary", `${existing}, ${value}`);
	}
}

function resolveCorsOrigin(req: Request): string | null {
	const origin = req.headers.get("origin");
	if (!origin) return null;
	try {
		const normalized = normalizeOrigin(origin);
		return allowedOriginsSet.has(normalized) ? normalized : null;
	} catch {
		return null;
	}
}

function applyCorsHeaders(req: Request, headers: Headers): void {
	const origin = resolveCorsOrigin(req);
	if (!origin) return;
	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-allow-credentials", "true");
	appendVary(headers, "Origin");
}

function corsPreflightResponse(req: Request): Response | null {
	const origin = resolveCorsOrigin(req);
	if (!origin) return null;
	const headers = new Headers();
	applySecurityHeaders(headers);
	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-allow-credentials", "true");
	headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
	headers.set("access-control-allow-headers", "content-type, last-event-id");
	headers.set("access-control-max-age", "600");
	appendVary(headers, "Origin");
	return new Response(null, { status: 204, headers });
}

/** Terminal tiles: list and open (/api/terminals), then per terminal its info, its websocket and close. */
async function handleTerminalRoute(
	req: Request,
	url: URL,
	route: { id: string | null; action: string | null },
	server: Bun.Server<TerminalSocketData>,
	requesterId: string,
): Promise<Response | undefined> {
	if (!terminals) return errorResponse("Terminals are off on this host (PI_WEB_TERMINALS).", 404);
	const { id, action } = route;
	if (!id) {
		if (req.method === "GET") return json({ terminals: terminals.list() }, 200);
		if (req.method !== "POST") return plainText("Not found", 404);
		const limited = terminalCreateLimiter.check(`terminals:${requesterId}`);
		if (limited) return rateLimitResponse(limited);
		const client = resolveClientCookie(req);
		if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
		// the shell ends the fresh window after the check it opens under, unless a newer check pushes that back; hosts that
		// don't check (loopback dev) never end it
		const check = resolveBrowserFaceIdCheck(req, url, client);
		const device = requestDevices.get(req);
		try {
			const raw = await requireJsonBody(req, COMMAND_JSON_BODY_LIMIT);
			const info = terminals.create({
				cwd: raw.cwd,
				cols: raw.cols,
				rows: raw.rows,
				expiresAt: check ? check.verifiedAt + TERMINAL_TTL_MS : null,
				openedBy: device ? `device ${device.slice(0, 16)}` : `client ${client.clientId.slice(0, 8)}`,
			});
			return json(info, 200);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "too_many_terminals") return errorResponse("Too many terminals open on this host.", 429);
			return errorResponse(message, 400);
		}
	}
	if (req.method === "GET" && action === null) {
		const info = terminals.get(id);
		if (info) return json(info, 200);
		// a tile that wasn't watching (locked, reloaded) learns why, rather than opening a new shell in its place
		const body: ApiTerminalMissingResponse = { error: "Terminal not running", ended: terminals.endedReason(id) };
		return json(body, 404);
	}
	if (req.method === "GET" && action === "socket") {
		if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return errorResponse("Expected a websocket upgrade", 426);
		if (!terminals.get(id)) return errorResponse("Terminal not running", 404);
		const client = resolveClientCookie(req);
		const data: TerminalSocketData = {
			terminalId: id,
			clientId: client?.clientId ?? "",
			checkedAt: resolveBrowserFaceIdCheck(req, url, client)?.verifiedAt ?? null,
			cols: url.searchParams.get("cols"),
			rows: url.searchParams.get("rows"),
		};
		return server.upgrade(req, { data }) ? undefined : errorResponse("Websocket upgrade failed", 400);
	}
	if (req.method === "POST" && action === "close") {
		const limited = commandLimiter.check(`command:${requesterId}`);
		if (limited) return rateLimitResponse(limited);
		if (!resolveClientCookie(req)) return errorResponse("Missing browser session. Reload the page.", 401);
		const raw: Record<string, unknown> = await requireJsonBody(req, COMMAND_JSON_BODY_LIMIT).catch(() => ({}));
		// a shell running vim or ssh asks first; one waiting at its prompt just closes
		if (raw.force !== true) {
			const busy = await terminals.foreground(id);
			if (busy) return json({ error: `${busy} is running in this terminal`, busy }, 409);
		}
		return terminals.close(id, "closed") ? ok() : errorResponse("Terminal not running", 404);
	}
	return plainText("Not found", 404);
}

async function handleFetch(req: Request, server: Bun.Server<TerminalSocketData>): Promise<Response | undefined> {
		const url = new URL(req.url);
		const secure = isSecureRequest(req, url, trustProxy);
		const requestProtocol = secure ? "https:" : url.protocol;
		const directAddress = server.requestIP(req)?.address;
		const requesterId = resolveRequesterId(req, server);
		const trustError = ensureTrustedRequest(req, url, requestProtocol);
		if (trustError) return trustError;

		if (url.pathname === "/health") {
			const memory = process.memoryUsage();
			return json(
				{
					ok: true,
					piVersion: PI_VERSION,
					pid: process.pid,
					uptimeSeconds: Math.round(process.uptime()),
					rssMb: Math.round(memory.rss / 1_048_576),
					heapUsedMb: Math.round(memory.heapUsed / 1_048_576),
					...runtime.getHealth(),
					terminals: terminals?.count() ?? 0,
				},
				200,
			);
		}

		if (secureMode) {
			const deviceAuth = await verifyClientCertificateRequest(req, directAddress, {
				registryPath: deviceRegistryPath,
				headerName: clientCertHeader,
			});
			if (!deviceAuth.ok) return errorResponse(deviceAuth.message, deviceAuth.status);
			requestDevices.set(req, deviceAuth.device?.fingerprintSha256 ?? null);
		}

		if (req.method === "OPTIONS" && isApiPath(url.pathname)) {
			return corsPreflightResponse(req) ?? errorResponse("Untrusted origin.", 403);
		}

		const faceIdError = ensureFaceIdAuth(req, url);
		if (faceIdError) return faceIdError;

		if (req.method === "GET" && url.pathname === "/") {
			return serveStatic(join(publicDir, "index.html"), "text/html; charset=utf-8");
		}
		if (req.method === "GET" && url.pathname === "/favicon.ico") {
			return plainText(null, 204);
		}

		if (req.method === "GET" && url.pathname.startsWith(simpleWebAuthnBrowserUrlPrefix)) {
			const filePath = resolveSimpleWebAuthnBrowserFile(url);
			if (filePath) return serveStatic(filePath);
			return plainText("Not found", 404);
		}

		const xtermFile = req.method === "GET" ? xtermBrowserFiles.get(url.pathname) : undefined;
		if (xtermFile) return serveStatic(xtermFile);

		if (req.method === "GET" && !isApiPath(url.pathname)) {
			const filePath = resolvePublicFile(url);
			if (filePath) return serveStatic(filePath);
		}

		if (req.method === "POST" && url.pathname === "/api/client") {
			const limited = clientSessionLimiter.check(`client:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			const clientId = resolveClientCookie(req)?.clientId ?? randomUUID();
			return createCookieResponse({ clientId }, 200, issueClientCookie(req, clientId, secure));
		}

		if (req.method === "POST" && url.pathname === "/api/faceid/logout") {
			revokeFaceIdCookie(req);
			return ok({ "set-cookie": clearCookie(FACEID_COOKIE, secure) });
		}

		if (req.method === "GET" && url.pathname === "/api/sessions") {
			const cwd = url.searchParams.get("cwd")?.trim() || undefined;
			const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
			const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
			const body: ApiListSessionsResponse = await runtime.listSessions({
				cwd,
				limit: Number.isFinite(limit) ? Math.min(limit, 500) : 200,
				offset: Number.isFinite(offset) ? offset : 0,
			});
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/session-transcript") {
			const path = url.searchParams.get("path")?.trim();
			if (!path) return errorResponse("Missing session path", 400);
			const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
			try {
				const body: ApiSessionFileTranscriptResponse = await runtime.readTranscriptFile(path, {
					before: url.searchParams.get("before")?.trim() || undefined,
					limit: Number.isFinite(limit) ? limit : undefined,
				});
				return json(body, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("session_path_not_allowed")) return errorResponse("Session path not allowed", 403);
				if (message === "unknown_entry") return errorResponse("Unknown transcript entry", 404);
				return sessionMissing("Session file not found", path);
			}
		}

		if (req.method === "GET" && url.pathname === "/api/models") {
			const models = await runtime.listModels();
			const body: ApiListModelsResponse = { models };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/active-sessions") {
			const sessions = await runtime.listActiveSessions();
			const body: ApiActiveSessionsResponse = { sessions };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/repos") {
			const repos = await runtime.listRepos();
			const body: ApiListReposResponse = { repos };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/repos/suggestions") {
			const body: ApiRepoSuggestionsResponse = { suggestions: await runtime.listRepoSuggestions() };
			return json(body, 200);
		}

		// folder completion for the launcher; read-only, so any live Face ID session will do
		if (req.method === "GET" && url.pathname === "/api/dirs") {
			const typed = url.searchParams.get("path") ?? "";
			if (!isTypedPath(typed)) return errorResponse("path must start with / or ~/", 400);
			const body: ApiDirectoryListing = await listDirectories(typed);
			return json(body, 200);
		}

		// one stream for the whole canvas: which sessions run, work or wait, so idle tiles can let go of theirs
		if (req.method === "GET" && url.pathname === "/api/canvas/status") {
			const stream = createSseStream(req.signal);
			let timer: ReturnType<typeof setTimeout> | null = null;
			const send = () => {
				timer = null;
				stream.send({ type: "canvas_status", sessions: runtime.canvasStatus() });
			};
			const unsubscribe = runtime.onStatusChange(() => {
				timer ??= setTimeout(send, CANVAS_STATUS_THROTTLE_MS);
			});
			req.signal.addEventListener(
				"abort",
				() => {
					unsubscribe();
					if (timer) clearTimeout(timer);
				},
				{ once: true },
			);
			send();
			return stream.response;
		}

		if (req.method === "GET" && url.pathname === "/api/canvas") {
			try {
				return json(await canvasLayouts.load(), 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(`Couldn't read the canvas layout: ${message}`, 500);
			}
		}

		if (req.method === "PUT" && url.pathname === "/api/canvas") {
			const limited = canvasLayoutLimiter.check(`canvas:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			try {
				return json(await canvasLayouts.save(await requireJsonBody(req, CANVAS_LAYOUT_BODY_LIMIT)), 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "GET" && url.pathname === "/api/hosts") {
			const registry = await loadHostRegistry(hostRegistryPath);
			const body: ApiListHostsResponse = { hosts: registry.hosts.filter((host) => host.enabled) };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/faceid/status") {
			try {
				const status = await faceId.status(url.hostname);
				const check = resolveBrowserFaceIdCheck(req, url, resolveClientCookie(req));
				const body = {
					...status,
					canRegister: canRegisterFaceId(url, status.credentialCount),
					freshForSeconds: Math.floor(FACEID_FRESH_TTL_MS / 1000),
					commandFreshForSeconds: Math.floor(FACEID_COMMAND_TTL_MS / 1000),
					sessionForSeconds: Math.floor(FACEID_TTL_MS / 1000),
					verifiedSecondsAgo: check ? Math.max(0, Math.floor((Date.now() - check.verifiedAt) / 1000)) : null,
				};
				return json(body, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/repos") {
			const limited = repoMutationLimiter.check(`repos:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			try {
				const raw: Partial<ApiAddRepoRequest> = await requireJsonBody(req);
				if (!raw.cwd || typeof raw.cwd !== "string") {
					return errorResponse("Missing cwd", 400);
				}
				const body: ApiAddRepoResponse = { ok: true, cwd: await runtime.addRepo(raw.cwd, { create: raw.create === true }) };
				return json(body, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/faceid/challenge") {
			const limited = faceIdChallengeLimiter.check(`faceid-challenge:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			try {
				const raw = (await requireJsonBody(req)) as { kind?: unknown };
				const kind = raw?.kind;
				if (kind !== "register" && kind !== "authenticate") {
					return errorResponse("Invalid faceid challenge kind", 400);
				}
				const requestOrigin = resolveRequestOrigin(req);
				if (!requestOrigin || !allowedOriginsSet.has(requestOrigin)) {
					return errorResponse("Face ID challenge requires a trusted browser origin.", 400);
				}
				if (kind === "register") {
					const status = await faceId.status(url.hostname);
					if (!canRegisterFaceId(url, status.credentialCount)) {
						return errorResponse(
							"First remote Face ID enrollment requires secure mode with an enrolled mTLS device certificate, or enrollment from a trusted local browser.",
							403,
						);
					}
				}
				const result = await faceId.createChallenge(kind, url.hostname, requestOrigin);
				return json(result, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/faceid/verify") {
			const limited = faceIdVerifyLimiter.check(`faceid-verify:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			try {
				const client = resolveClientCookie(req);
				if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
				const raw = (await requireJsonBody(req)) as { challengeId?: unknown; credential?: unknown };
				if (typeof raw?.challengeId !== "string" || raw.challengeId.length === 0) {
					return errorResponse("Missing challengeId", 400);
				}
				const result = await faceId.verify(raw.challengeId, raw.credential);
				if (result.kind !== "authenticate") {
					return json(result, 200);
				}
				// a check on this host keeps its terminals open for another fresh window
				terminals?.extend(Date.now() + TERMINAL_TTL_MS);
				return createCookieResponse(result, 200, issueFaceIdCookie(req, client.clientId, url.hostname, secure));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/sessions") {
			const limited = sessionCreateLimiter.check(`sessions:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			const client = resolveClientCookie(req);
			if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
			try {
				const raw = (await requireJsonBody(req)) as ApiCreateSessionRequest;
				if (raw.projectTrust !== undefined && !isProjectTrustChoice(raw.projectTrust)) return errorResponse("Invalid project trust choice", 400);
				if (raw.model !== undefined && !isModelRef(raw.model)) return errorResponse("Invalid model", 400);
				if (raw.thinkingLevel !== undefined && typeof raw.thinkingLevel !== "string") return errorResponse("Invalid thinking level", 400);
				const result = await runtime.startSession({ ...raw, clientId: client.clientId });
				return json(result, 200);
			} catch (error) {
				if (error instanceof NeverSavedError) {
					const body: ApiSessionMissingResponse = { error: "Nothing was ever sent to this session, so there is no file to resume", neverSaved: true, cwd: error.cwd };
					return json(body, 404);
				}
				if (error instanceof ProjectTrustRequiredError) {
					const body: ApiProjectTrustRequiredResponse = { error: "Project trust required", projectTrust: error.prompt };
					return json(body, 409);
				}
				if (error instanceof RunningElsewhereError) {
					const body: ApiRunningElsewhereResponse = { error: "Another pi is still writing this session", elsewhere: error.elsewhere };
					return json(body, 409);
				}
				const message = error instanceof Error ? error.message : String(error);
				if (message === "too_many_active_sessions") return errorResponse("Too many active sessions", 429);
				if (message === "session_already_running") return errorResponse("Session already running", 409);
				return errorResponse(message, 400);
			}
		}

		if (url.pathname === TERMINAL_LOCK_PATH) {
			if (req.method !== "POST") return plainText("Not found", 404);
			const client = resolveClientCookie(req);
			if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
			lockTerminals(client.clientId);
			return ok();
		}

		const terminalRoute = parseTerminalRoute(url.pathname);
		if (terminalRoute) return handleTerminalRoute(req, url, terminalRoute, server, requesterId);

		const sessionRoute = parseSessionRoute(url.pathname);
		if (!sessionRoute) {
			return plainText("Not found", 404);
		}

		const { sessionId, action } = sessionRoute;

		if (req.method === "GET" && (action === "state" || action === "events")) {
			const attachError = await attachIfNeeded(req, url, sessionId, requesterId);
			if (attachError) return attachError;
		}

		if (req.method === "GET" && action === "state") {
			try {
				const state: ApiSessionState = runtime.getSessionState(sessionId);
				return json(state, 200);
			} catch {
				return errorResponse("Session not running", 404);
			}
		}

		if (req.method === "GET" && action === "transcript") {
			const before = url.searchParams.get("before")?.trim() || undefined;
			const limitParam = url.searchParams.get("limit");
			const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
			const request = { before, limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined };
			const path = url.searchParams.get("path")?.trim();
			try {
				const body: ApiTranscriptPageResponse =
					!runtime.isRunning(sessionId) && path ? await runtime.readTranscriptFile(path, { ...request, sessionId }) : runtime.getTranscriptPage(sessionId, request);
				return json(body, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "unknown_entry") return errorResponse("Unknown transcript entry", 404);
				if (message.startsWith("session_path_not_allowed")) return errorResponse("Session path not allowed", 403);
				return errorResponse("Session not running", 404);
			}
		}

		if (req.method === "GET" && action === "follow") {
			if (!resolveClientCookie(req)) return errorResponse("Missing browser session. Reload the page.", 401);
			const path = url.searchParams.get("path")?.trim();
			if (!path) return errorResponse("Missing session path", 400);
			const stream = createSseStream(req.signal);
			const follower: FollowClient = { send: stream.send, close: stream.close };
			const since = resolveResumeCursor(req.headers.get("last-event-id"), url.searchParams.get("since"));
			const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
			try {
				const { init, cursor, stop } = await runtime.followSession(sessionId, path, follower, since, {
					limit: Number.isFinite(limitParam) ? limitParam : undefined,
				});
				if (req.signal.aborted) {
					stop();
				} else {
					req.signal.addEventListener("abort", stop, { once: true });
				}
				stream.send(init, cursor);
			} catch (error) {
				stream.close();
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("session_path_not_allowed")) return errorResponse("Session path not allowed", 403);
				return errorResponse("Session file not found", 404);
			}
			return stream.response;
		}

		if (req.method === "POST" && action === "stop-elsewhere") {
			const limited = commandLimiter.check(`command:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			if (!resolveClientCookie(req)) return errorResponse("Missing browser session. Reload the page.", 401);
			try {
				const raw = (await requireJsonBody(req, COMMAND_JSON_BODY_LIMIT)) as Partial<ApiStopElsewhereRequest>;
				if (typeof raw.path !== "string" || !raw.path.trim()) return errorResponse("Missing session path", 400);
				const { stopped } = await runtime.stopElsewhere(sessionId, raw.path);
				const body: ApiStopElsewhereResponse = { ok: true, stopped };
				return json(body, 200);
			} catch (error) {
				if (error instanceof AmbiguousWritersError) {
					return errorResponse(`Several pi processes work in that folder (pids ${error.pids.join(", ")}); stop the one writing this session yourself.`, 409);
				}
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("session_path_not_allowed")) return errorResponse("Session path not allowed", 403);
				if (message === "session_hosted_here") return errorResponse("pi-web hosts this session; abort it instead", 409);
				if (message === "writer_still_running") return errorResponse("The pi writing this session didn't stop", 409);
				if (message === "processes_unavailable") return errorResponse("Can't list processes on this host", 409);
				if (message === "session_file_missing" || message === "session_path_mismatch") return errorResponse("Session file not found", 404);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "GET" && action === "tripwire-alerts") {
			const client = resolveClientCookie(req);
			if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
			try {
				const body: ApiTripwireAlertsResponse = await runtime.getTripwireAlerts(sessionId, client.clientId);
				return json(body, 200);
			} catch {
				return errorResponse("Session not running", 404);
			}
		}

		if (req.method === "GET" && action === "events") {
			const client = resolveClientCookie(req);
			if (!client) return errorResponse("Missing browser session. Reload the page.", 401);

			const stream = createSseStream(req.signal);
			const clientSession: SessionClient = {
				connectionId: randomUUID(),
				clientId: client.clientId,
				send: stream.send,
				close: stream.close,
			};

			const since = resolveResumeCursor(req.headers.get("last-event-id"), url.searchParams.get("since"));
			const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
			try {
				const { init, cursor } = runtime.connectClient(sessionId, clientSession, since, {
					limit: Number.isFinite(limitParam) ? limitParam : undefined,
				});
				stream.send(init, cursor);
			} catch (error) {
				stream.close();
				const message = error instanceof Error ? error.message : String(error);
				if (message === "too_many_clients") return errorResponse("Too many live viewers for this session", 429);
				return errorResponse("Session not running", 404);
			}

			req.signal.addEventListener(
				"abort",
				() => {
					runtime.removeClient(sessionId, clientSession.connectionId);
				},
				{ once: true },
			);

			return stream.response;
		}

		if (req.method === "POST" && action === "command") {
			const limited = commandLimiter.check(`command:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			const client = resolveClientCookie(req);
			if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
			try {
				const raw = (await requireJsonBody(req, COMMAND_JSON_BODY_LIMIT)) as ApiCommandRequest;
				if (!raw || typeof raw !== "object" || typeof raw.type !== "string") {
					return errorResponse("Invalid command payload", 400);
				}
				if (raw.type === "prompt" && typeof raw.text === "string" && raw.text.length > MAX_PROMPT_CHARS) {
					return errorResponse(`Prompt too large (max ${String(MAX_PROMPT_CHARS)} chars).`, 400);
				}
				const command = { ...raw, clientId: client.clientId } as ApiCommandRequest;
				const body: ApiCommandResponse = await runtime.handleCommand(sessionId, command);
				return json(body, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "not_controller") return errorResponse("Not controller", 403);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "ui-response") {
			const limited = commandLimiter.check(`command:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			const client = resolveClientCookie(req);
			if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
			try {
				const response = parseExtensionUiResponse(await requireJsonBody(req, UI_RESPONSE_JSON_BODY_LIMIT));
				if (!response) return errorResponse("Invalid dialog answer", 400);
				runtime.answerExtensionUi(sessionId, response);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "unknown_dialog") return errorResponse("Dialog already closed", 410);
				if (message === "invalid_dialog_answer") return errorResponse("Invalid dialog answer", 400);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "takeover") {
			const client = resolveClientCookie(req);
			if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
			try {
				const request: ApiTakeoverRequest = { clientId: client.clientId };
				runtime.takeover(sessionId, request);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "release") {
			const client = resolveClientCookie(req);
			if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
			try {
				const request: ApiReleaseRequest = { clientId: client.clientId };
				await runtime.release(sessionId, request);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "not_controller") return errorResponse("Not controller", 403);
				return errorResponse(message, 400);
			}
		}

		return plainText("Not found", 404);
}

const server = Bun.serve({
	hostname: host,
	port,
	...(tls ? { tls: { cert: Bun.file(tls.certFile), key: Bun.file(tls.keyFile) } } : {}),
	async fetch(req, server): Promise<Response | undefined> {
		const response = await handleFetch(req, server);
		// undefined: the request became a terminal's websocket
		if (!response) return undefined;
		applyCorsHeaders(req, response.headers);
		return response;
	},
	websocket: {
		data: {} as TerminalSocketData,
		open(ws) {
			// the browser locked its terminals between the upgrade and now
			const lockedAt = terminalLocks.get(ws.data.clientId);
			if (ws.data.checkedAt !== null && lockedAt !== undefined && lockedAt >= ws.data.checkedAt) {
				ws.close(4401, "locked");
				return;
			}
			const size = { cols: ws.data.cols ?? undefined, rows: ws.data.rows ?? undefined };
			if (!terminals?.attach(ws.data.terminalId, ws, size)) {
				ws.close(4404, "terminal not running");
				return;
			}
			terminalSockets.add(ws);
		},
		message(ws, message) {
			if (typeof message === "string") terminals?.handleMessage(ws.data.terminalId, message);
		},
		drain(ws) {
			terminals?.drain(ws.data.terminalId, ws);
		},
		close(ws) {
			terminalSockets.delete(ws);
			terminals?.detach(ws.data.terminalId, ws);
		},
	},
});

const scheme = tls ? "https" : "http";
const baseUrl = `${scheme}://${host}:${port}`;
console.log(`pi-web listening on ${baseUrl}`);
console.log(`Allowed browser origins: ${allowedOrigins.join(", ")}`);
if (tls) {
	console.log("TLS enabled with Tailscale certs.");
}
if (trustProxy) {
	console.log("Trusted proxy mode enabled: honoring X-Forwarded-Proto and forwarded client IP headers.");
}
console.log(`Response security headers enabled${enableHsts ? " (including HSTS)." : "."}`);
console.log(
	`Face ID remote session window: ${String(FACEID_TTL_MS / 60_000)}m total, ${String(FACEID_COMMAND_TTL_MS / 60_000)}m for prompts and take over, ${String(FACEID_FRESH_TTL_MS / 60_000)}m for new sessions, repos and release; terminals close ${String(TERMINAL_TTL_MS / 60_000)}m after the last check.`,
);
console.log(
	`Runtime caps: ${String(maxRunningSessions)} active sessions, ${String(maxClientsPerSession)} viewers per session, idle sessions disposed after ${String(idleSessionMinutes)}m.`,
);
if (secureMode) {
	console.log(`Secure mode enabled: client certificate fingerprints must be allowed in ${deviceRegistryPath}.`);
	console.log(`Trusted client certificate header: ${clientCertHeader}.`);
}
console.log(`SDK extension auto-loading is enabled. Projects without a trust.json decision: ${projectTrustMode} (PI_WEB_PROJECT_TRUST).`);
console.log(`Tripwire: ${tripwireMode === "on" ? "on, critical tool calls are blocked" : "off"} (PI_WEB_TRIPWIRE).`);
console.log(`Terminal tiles: ${terminalsMode} (PI_WEB_TERMINALS).`);
if (restoredSessions > 0) console.log(`${String(restoredSessions)} session(s) from before the restart can re-attach.`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[pi-web] ${signal}: stopping runs and saving sessions for re-attach`);
	terminals?.shutdown();
	void server.stop();
	try {
		await runtime.shutdown();
	} finally {
		process.exit(0);
	}
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
if (isTailnetHost(host) && !secureMode) {
	console.log("Direct Tailscale binding enabled by explicit opt-in. Prefer secure mode behind Caddy mTLS.");
	console.log("First remote Face ID enrollment requires secure mode with mTLS, or enrollment from a trusted local browser.");
}
