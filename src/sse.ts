import type { FollowSseEvent, SseEvent } from "./types.ts";

/** Browsers retry a dropped EventSource after this delay and send the last frame id as Last-Event-ID. */
export const SSE_RETRY_MS = 1_500;
export const SSE_PING_INTERVAL_MS = 5_000;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function sseRetryFrame(retryMs = SSE_RETRY_MS): string {
	return `retry: ${String(retryMs)}\n\n`;
}

/** A named event rather than a comment, so the page can tell a silent dead stream from an idle one. */
export function ssePingFrame(now = Date.now()): string {
	return `event: ping\ndata: ${String(now)}\n\n`;
}

export function sseEventFrame(event: SseEvent | FollowSseEvent, id?: string): string {
	const idLine = id !== undefined && CURSOR_PATTERN.test(id) ? `id: ${id}\n` : "";
	return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}

/** The newest cursor wins: the browser's own retry sends Last-Event-ID to a URL that may carry an older ?since=. */
export function resolveResumeCursor(lastEventId: string | null, since: string | null): string | undefined {
	return [lastEventId, since].map((value) => value?.trim() ?? "").find((value) => CURSOR_PATTERN.test(value));
}
