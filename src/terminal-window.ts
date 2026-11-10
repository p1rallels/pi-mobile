// Which Face ID check a browser's shells ride on. Attaching to a shell needs a check from the command window, newer than
// the browser's last terminal lock (server.ts terminalLockError), and the stream sweep holds an open socket to the same
// rule. The check is the newest one the browser passed on this host: the one in its cookie, or a later one an open
// socket never sees (keep open, an unlock, a prompt's). So a browser that keeps passing checks keeps its sockets, and a
// page left open past the window loses them however long other browsers' checks keep the shells alive. Pure: the
// server holds the record.

/** A browser on a host: its client id, its mTLS device in secure mode (else null), and the host its checks are for. */
export interface CheckingBrowser {
	clientId: string;
	device: string | null;
	rpId: string;
}

/** The newest check each browser passed, by `browserKey`. */
export type PassedChecks = ReadonlyMap<string, number>;

const browserKey = ({ clientId, device, rpId }: CheckingBrowser): string => JSON.stringify([clientId, device, rpId]);

/** A browser passed a check at `at`. Checks older than `keepMs` by then drop out: they can't hold a shell any more. */
export function withPassedCheck(checks: PassedChecks, browser: CheckingBrowser, at: number, keepMs: number): PassedChecks {
	const key = browserKey(browser);
	const next = new Map([...checks].filter(([, passedAt]) => at - passedAt <= keepMs));
	return next.set(key, Math.max(at, checks.get(key) ?? at));
}

/** The newest check a browser passed: the one its request carries (`carriedAt`), or a later one. */
export function newestCheck(checks: PassedChecks, browser: CheckingBrowser, carriedAt: number): number {
	return Math.max(carriedAt, checks.get(browserKey(browser)) ?? carriedAt);
}
