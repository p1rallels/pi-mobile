import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { verifyClientCertificateRequest } from "./device-auth.ts";
import { FaceIdService } from "./faceid.ts";
import { loadHostRegistry } from "./host-registry.ts";
import { resolvePiWebPaths } from "./security-config.ts";
import { PiWebRuntime, type SessionClient } from "./session-runtime.ts";
import type {
	ApiActiveSessionsResponse,
	ApiAddRepoRequest,
	ApiCommandRequest,
	ApiCommandResponse,
	ApiCreateSessionRequest,
	ApiErrorResponse,
	ApiListHostsResponse,
	ApiListModelsResponse,
	ApiListReposResponse,
	ApiListSessionsResponse,
	ApiOkResponse,
	ApiReleaseRequest,
	ApiSessionState,
	ApiTakeoverRequest,
	ApiTranscriptPageResponse,
	ApiTripwireAlertsResponse,
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

interface SessionStore<T> {
	create(value: T, ttlMs: number): string;
	get(token: string | null | undefined): T | null;
	delete(token: string | null | undefined): void;
}

interface RateLimitResult {
	retryAfterSeconds: number;
}

const CLIENT_COOKIE = "pi_web_client";
const FACEID_COOKIE = "pi_web_faceid";

const CLIENT_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const FACEID_TTL_MS = 1000 * 60 * 60 * 4;
const FACEID_FRESH_TTL_MS = 1000 * 60 * 10;

const DEFAULT_JSON_BODY_LIMIT = 256 * 1024;
const COMMAND_JSON_BODY_LIMIT = 64 * 1024;
const MAX_PROMPT_CHARS = 32_000;
const SESSION_STORE_MAX_ENTRIES = 4_096;

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
	if (!raw) return fallback;
	const value = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid ${name}: ${String(raw)}`);
	}
	return value;
}

function createSessionStore<T>(maxEntries = SESSION_STORE_MAX_ENTRIES): SessionStore<T> {
	const sessions = new Map<string, { value: T; expiresAt: number }>();

	function prune(now = Date.now()): void {
		for (const [token, entry] of sessions.entries()) {
			if (entry.expiresAt <= now) {
				sessions.delete(token);
			}
		}
	}

	function enforceCapacity(): void {
		while (sessions.size > maxEntries) {
			const oldest = sessions.keys().next().value;
			if (!oldest) return;
			sessions.delete(oldest);
		}
	}

	return {
		create(value: T, ttlMs: number): string {
			prune();
			const token = randomUUID();
			sessions.set(token, { value, expiresAt: Date.now() + ttlMs });
			enforceCapacity();
			return token;
		},
		get(token: string | null | undefined): T | null {
			if (!token) return null;
			prune();
			const entry = sessions.get(token);
			if (!entry) return null;
			if (entry.expiresAt <= Date.now()) {
				sessions.delete(token);
				return null;
			}
			return entry.value;
		},
		delete(token: string | null | undefined): void {
			if (!token) return;
			sessions.delete(token);
		},
	};
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

	return { host, port, trustProxy, tls, allowedOrigins, maxRunningSessions, maxClientsPerSession, secureMode, deviceRegistryPath, hostRegistryPath, clientCertHeader };
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
		pathname === "/api/faceid/logout"
	);
}

function parseSessionRoute(pathname: string): { sessionId: string; action: string } | null {
	const parts = pathname.split("/").filter((p) => p.length > 0);
	if (parts.length !== 4) return null;
	if (parts[0] !== "api" || parts[1] !== "sessions") return null;
	return { sessionId: parts[2], action: parts[3] };
}

function isFaceIdControlRoute(method: string, pathname: string): boolean {
	if (method !== "POST") return false;
	if (pathname === "/api/repos" || pathname === "/api/sessions") return true;
	const sessionRoute = parseSessionRoute(pathname);
	if (!sessionRoute) return false;
	return sessionRoute.action === "command" || sessionRoute.action === "takeover" || sessionRoute.action === "release";
}

function resolveClientCookie(req: Request): { clientId: string } | null {
	return clientSessions.get(parseCookies(req).get(CLIENT_COOKIE));
}

function resolveFaceIdCookie(req: Request): { rpId: string; clientId: string; verifiedAt: number } | null {
	return faceIdSessions.get(parseCookies(req).get(FACEID_COOKIE));
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

function ensureFaceIdAuth(req: Request, url: URL): Response | null {
	if (!isApiPath(url.pathname)) return null;
	if (isFaceIdExemptPath(url.pathname)) return null;
	if (isLoopbackHost(url.hostname)) return null;

	const client = resolveClientCookie(req);
	if (!client) return errorResponse("Missing browser session. Reload the page.", 401);
	const session = resolveFaceIdCookie(req);
	if (!session || session.rpId !== url.hostname || session.clientId !== client.clientId) {
		return errorResponse("Face ID verification required.", 401);
	}
	if (isFaceIdControlRoute(req.method, url.pathname) && Date.now() - session.verifiedAt > FACEID_FRESH_TTL_MS) {
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

function resolveRequesterId(req: Request, server: Bun.Server<undefined>): string {
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

const clientSessionLimiter = createRateLimiter(60_000, 20);
const repoMutationLimiter = createRateLimiter(60_000, 12);
const sessionCreateLimiter = createRateLimiter(60_000, 12);
const commandLimiter = createRateLimiter(60_000, 90);
const faceIdChallengeLimiter = createRateLimiter(60_000, 12);
const faceIdVerifyLimiter = createRateLimiter(60_000, 12);

const runtime = new PiWebRuntime({ maxRunningSessions, maxClientsPerSession });
const faceId = new FaceIdService();
const clientSessions = createSessionStore<{ clientId: string }>();
const faceIdSessions = createSessionStore<{ rpId: string; clientId: string; verifiedAt: number }>();

const publicDir = join(import.meta.dir, "..", "public");
const publicRoot = resolve(publicDir) + sep;
const simpleWebAuthnBrowserDir = join(import.meta.dir, "..", "node_modules", "@simplewebauthn", "browser", "esm");
const simpleWebAuthnBrowserRoot = resolve(simpleWebAuthnBrowserDir) + sep;
const simpleWebAuthnBrowserUrlPrefix = "/vendor/simplewebauthn/browser/esm/";

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
	headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
	headers.set("access-control-allow-headers", "content-type");
	headers.set("access-control-max-age", "600");
	appendVary(headers, "Origin");
	return new Response(null, { status: 204, headers });
}

async function handleFetch(req: Request, server: Bun.Server<undefined>): Promise<Response> {
		const url = new URL(req.url);
		const secure = isSecureRequest(req, url, trustProxy);
		const requestProtocol = secure ? "https:" : url.protocol;
		const directAddress = server.requestIP(req)?.address;
		const requesterId = resolveRequesterId(req, server);
		const trustError = ensureTrustedRequest(req, url, requestProtocol);
		if (trustError) return trustError;

		if (url.pathname === "/health") {
			return json({ ok: true }, 200);
		}

		if (secureMode) {
			const deviceAuth = await verifyClientCertificateRequest(req, directAddress, {
				registryPath: deviceRegistryPath,
				headerName: clientCertHeader,
			});
			if (!deviceAuth.ok) return errorResponse(deviceAuth.message, deviceAuth.status);
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

		if (req.method === "GET" && !isApiPath(url.pathname)) {
			const filePath = resolvePublicFile(url);
			if (filePath) return serveStatic(filePath);
		}

		if (req.method === "POST" && url.pathname === "/api/client") {
			const limited = clientSessionLimiter.check(`client:${requesterId}`);
			if (limited) return rateLimitResponse(limited);
			const existing = resolveClientCookie(req);
			if (existing) {
				return json({ clientId: existing.clientId }, 200);
			}
			const clientId = randomUUID();
			const sessionToken = clientSessions.create({ clientId }, CLIENT_TTL_MS);
			return createCookieResponse(
				{ clientId },
				200,
				buildSetCookie(CLIENT_COOKIE, sessionToken, {
					maxAge: CLIENT_TTL_MS / 1000,
					httpOnly: true,
					secure,
				}),
			);
		}

		if (req.method === "POST" && url.pathname === "/api/faceid/logout") {
			faceIdSessions.delete(parseCookies(req).get(FACEID_COOKIE));
			return ok({ "set-cookie": clearCookie(FACEID_COOKIE, secure) });
		}

		if (req.method === "GET" && url.pathname === "/api/sessions") {
			const sessions = await runtime.listSessions();
			const cwdFilter = url.searchParams.get("cwd")?.trim();
			const filtered = cwdFilter ? sessions.filter((session) => session.cwd === cwdFilter) : sessions;
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

		if (req.method === "GET" && url.pathname === "/api/hosts") {
			const registry = await loadHostRegistry(hostRegistryPath);
			const body: ApiListHostsResponse = { hosts: registry.hosts.filter((host) => host.enabled) };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/faceid/status") {
			try {
				const status = await faceId.status(url.hostname);
				const body = {
					...status,
					canRegister: canRegisterFaceId(url, status.credentialCount),
					freshForSeconds: Math.floor(FACEID_FRESH_TTL_MS / 1000),
					sessionForSeconds: Math.floor(FACEID_TTL_MS / 1000),
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
				await runtime.addRepo(raw.cwd);
				return ok();
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
				const sessionToken = faceIdSessions.create(
					{ rpId: url.hostname, clientId: client.clientId, verifiedAt: Date.now() },
					FACEID_TTL_MS,
				);
				return createCookieResponse(
					result,
					200,
					buildSetCookie(FACEID_COOKIE, sessionToken, {
						maxAge: FACEID_TTL_MS / 1000,
						httpOnly: true,
						secure,
					}),
				);
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
				const result = await runtime.startSession({ ...raw, clientId: client.clientId });
				return json(result, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "too_many_active_sessions") return errorResponse("Too many active sessions", 429);
				if (message === "session_already_running") return errorResponse("Session already running", 409);
				return errorResponse(message, 400);
			}
		}

		const sessionRoute = parseSessionRoute(url.pathname);
		if (!sessionRoute) {
			return plainText("Not found", 404);
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

		if (req.method === "GET" && action === "transcript") {
			const before = url.searchParams.get("before")?.trim() || undefined;
			const limitParam = url.searchParams.get("limit");
			const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
			try {
				const body: ApiTranscriptPageResponse = runtime.getTranscriptPage(sessionId, {
					before,
					limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
				});
				return json(body, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "unknown_entry") return errorResponse("Unknown transcript entry", 404);
				return errorResponse("Session not running", 404);
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
			let state: ApiSessionState;
			try {
				state = runtime.getSessionState(sessionId);
			} catch {
				return errorResponse("Session not running", 404);
			}

			const stream = createSseStream(req.signal);
			const clientSession: SessionClient = {
				clientId: client.clientId,
				send: stream.send,
				close: stream.close,
			};

			let role: ReturnType<typeof runtime.getSessionRole>["role"];
			let controllerClientId: string | null;
			try {
				runtime.addClient(sessionId, clientSession);
				const resolvedRole = runtime.getSessionRole(sessionId, client.clientId);
				role = resolvedRole.role;
				controllerClientId = resolvedRole.controllerClientId;
			} catch (error) {
				stream.close();
				const message = error instanceof Error ? error.message : String(error);
				if (message === "too_many_clients") return errorResponse("Too many live viewers for this session", 429);
				return errorResponse("Session not running", 404);
			}

			const init: SseEvent = {
				type: "init",
				state,
				yourClientId: client.clientId,
				controllerClientId,
				role,
			};
			stream.send(init);

			req.signal.addEventListener(
				"abort",
				() => {
					runtime.removeClient(sessionId, client.clientId);
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
				if (message === "cannot_takeover_while_streaming") return errorResponse("Cannot take over while streaming", 409);
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

Bun.serve({
	hostname: host,
	port,
	...(tls ? { tls: { cert: Bun.file(tls.certFile), key: Bun.file(tls.keyFile) } } : {}),
	async fetch(req, server): Promise<Response> {
		const response = await handleFetch(req, server);
		applyCorsHeaders(req, response.headers);
		return response;
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
console.log(`Face ID remote session window: ${String(Math.floor(FACEID_TTL_MS / 60000))}m total, ${String(Math.floor(FACEID_FRESH_TTL_MS / 60000))}m freshness for control actions.`);
console.log(`Runtime caps: ${String(maxRunningSessions)} active sessions, ${String(maxClientsPerSession)} viewers per session.`);
if (secureMode) {
	console.log(`Secure mode enabled: client certificate fingerprints must be allowed in ${deviceRegistryPath}.`);
	console.log(`Trusted client certificate header: ${clientCertHeader}.`);
}
console.log("SDK extension auto-loading is enabled.");
if (isTailnetHost(host) && !secureMode) {
	console.log("Direct Tailscale binding enabled by explicit opt-in. Prefer secure mode behind Caddy mTLS.");
	console.log("First remote Face ID enrollment requires secure mode with mTLS, or enrollment from a trusted local browser.");
}
