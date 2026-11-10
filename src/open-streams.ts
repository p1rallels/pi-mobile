// Open SSE streams (session events, follow, canvas status) and terminal sockets, each with what let it in. Access is
// checked when a request comes in; this is how the host takes it back from connections already open: a logout closes
// its browser's connections, a terminal lock that browser's terminal sockets, and a sweep every STREAM_SWEEP_MS checks
// each one again the way a new request would be checked (device still allowed, Face ID token still accepted) and
// closes the ones that fail. The bookkeeping is pure: the server holds the map, makes the checks and does the closing.

/**
 * Every few seconds: a lost phone's open streams and shells go within 5 s of `pi-web device revoke`, and a stream
 * outlives its Face ID session by 5 s at most. Each sweep costs one device-registry read per open connection (every
 * request already pays one), and 5 s is also the streams' ping interval.
 */
export const STREAM_SWEEP_MS = 5_000;

export type OpenStreamKind = "events" | "follow" | "canvas_status" | "terminal";

/** Why the host ended a connection it had let in. */
export type StreamCloseReason = "terminals_locked" | "logged_out" | "faceid_ended" | "device_not_allowed";

/** What let a connection in, from the request that opened it. */
export interface StreamAdmission {
	kind: OpenStreamKind;
	/** The browser (client cookie) it came from, or null where the route needed none. */
	clientId: string | null;
	/** The mTLS device's fingerprint in secure mode, else null. */
	device: string | null;
	/** The Face ID token (its jti) it rode on, or null where the route asked for none (loopback). */
	faceIdToken: string | null;
}

/** The connection's request, checked again the way a new one would be. */
export interface StreamRecheck {
	/** The device registry still allows its device (always, outside secure mode). */
	deviceAllowed: boolean;
	/** Its Face ID token still resolves: not logged out, not expired. */
	faceIdAccepted: boolean;
}

/** A check that couldn't be made (the registry unreadable, say) fails, as the request would. */
export const FAILED_RECHECK: StreamRecheck = Object.freeze({ deviceAllowed: false, faceIdAccepted: false });

export interface OpenStream {
	admission: StreamAdmission;
	close(reason: StreamCloseReason): void;
	recheck(): Promise<StreamRecheck>;
}

/** A connection let in, before the server has said how it closes. */
export type AdmittedStream = Omit<OpenStream, "close">;

/** Keyed by whatever identifies the connection to the server (the socket, the stream). */
export type OpenStreams<K> = ReadonlyMap<K, OpenStream>;

export function withStream<K>(streams: OpenStreams<K>, key: K, stream: OpenStream): OpenStreams<K> {
	return new Map(streams).set(key, stream);
}

export function withoutStream<K>(streams: OpenStreams<K>, key: K): OpenStreams<K> {
	if (!streams.has(key)) return streams;
	const next = new Map(streams);
	next.delete(key);
	return next;
}

/** A browser's own action: a logout ends all its connections, a terminal lock only its terminal sockets. */
export type BrowserCloseReason = Extract<StreamCloseReason, "logged_out" | "terminals_locked">;

export function browserStreams<K>(streams: OpenStreams<K>, clientId: string, reason: BrowserCloseReason): OpenStream[] {
	return [...streams.values()].filter(
		({ admission }) => admission.clientId === clientId && (reason === "logged_out" || admission.kind === "terminal"),
	);
}

/** Why the sweep closes a connection, or null to keep it. A connection that rode on no Face ID token needs none. */
export function recheckVerdict(admission: StreamAdmission, recheck: StreamRecheck): StreamCloseReason | null {
	if (!recheck.deviceAllowed) return "device_not_allowed";
	if (admission.faceIdToken !== null && !recheck.faceIdAccepted) return "faceid_ended";
	return null;
}

/**
 * The close frame a terminal socket gets. The page doesn't read it: any close sends the tile back over HTTP to
 * reattach, and that answer (401 Face ID or terminals locked, 403 device) puts it in its locked or failed state.
 * - 4401: a Face ID check is needed again (terminals locked, logged out, the Face ID session ran out)
 * - 4403: the device is no longer allowed (revoked, expired or removed from the registry)
 */
export function terminalCloseFrame(reason: StreamCloseReason): { code: number; reason: string } {
	switch (reason) {
		case "terminals_locked":
			return { code: 4401, reason: "locked" };
		case "logged_out":
			return { code: 4401, reason: "logged out" };
		case "faceid_ended":
			return { code: 4401, reason: "face id ended" };
		case "device_not_allowed":
			return { code: 4403, reason: "device not allowed" };
	}
}
