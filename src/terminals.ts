// Terminal tiles: one login shell per tile on this host, in a pty, with a headless xterm mirroring its screen so a
// browser that (re)attaches (a reload, another tab, a dropped socket) gets the exact screen back before the live bytes.
// Shells live in memory only: nothing they print or read is logged or written to disk, a restart ends them, and each
// one ends when the Face ID check it was opened under runs out (a newer check on this host pushes that back).
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/** The serialize addon, typed here: its own typings import @xterm/xterm's, which pull the DOM lib into the server. */
interface SerializeAddon {
	activate(terminal: HeadlessTerminal): void;
	dispose(): void;
	serialize(options?: { scrollback?: number }): string;
}
const { SerializeAddon } = createRequire(import.meta.url)("@xterm/addon-serialize") as { SerializeAddon: new () => SerializeAddon };

/** PI_WEB_TERMINALS: `on` (default) offers terminal tiles on the canvas, `off` turns the routes off. */
export type TerminalsMode = "on" | "off";

export function parseTerminalsMode(raw: string | undefined): TerminalsMode {
	const value = raw?.trim().toLowerCase();
	if (!value || value === "on") return "on";
	if (value === "off") return "off";
	throw new Error(`PI_WEB_TERMINALS must be on or off (got ${JSON.stringify(raw)}).`);
}

export const MAX_TERMINALS = 12;
const SCROLLBACK_LINES = 10_000;
const COLS = { min: 10, max: 500, fallback: 80 };
const ROWS = { min: 4, max: 300, fallback: 24 };
const EXPIRY_SWEEP_MS = 10_000;
const KILL_GRACE_MS = 3_000;
const SHELL_DIR = join(import.meta.dir, "terminal-shell");
const EMPTY = new Uint8Array(0);

export type TerminalEndReason = "exited" | "closed" | "expired" | "shutdown";

export interface TerminalInfo {
	id: string;
	cwd: string;
	title: string | null;
	createdAt: number;
	/** When the Face ID check it runs under is over and the shell gets killed; null on hosts that don't check. */
	expiresAt: number | null;
}

/** The part of a websocket a terminal talks to (Bun's ServerWebSocket fits). */
export interface TerminalPeer {
	sendText(data: string): number;
	sendBinary(data: Uint8Array): number;
	close(code?: number, reason?: string): void;
}

/** Text frames to the browser; the shell's output goes as binary frames of raw pty bytes. */
export type TerminalServerMessage =
	| { type: "snapshot"; data: string; cols: number; rows: number }
	| { type: "expires"; at: number | null }
	| { type: "exit"; reason: TerminalEndReason; code: number | null };

interface PeerState {
	/** False while a snapshot is on its way: output meanwhile queues so it lands after the snapshot. */
	live: boolean;
	queue: Uint8Array[];
	/** The socket dropped output (backpressure): it gets a fresh snapshot once it drains. */
	resync: boolean;
}

interface LiveTerminal {
	info: TerminalInfo;
	proc: Bun.Subprocess;
	pty: Bun.Terminal;
	mirror: HeadlessTerminal;
	serializer: SerializeAddon;
	cols: number;
	rows: number;
	peers: Map<TerminalPeer, PeerState>;
	ended: boolean;
}

const clampInt = (value: unknown, range: { min: number; max: number; fallback: number }): number => {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
	return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), range.min), range.max) : range.fallback;
};

export const terminalSize = (cols: unknown, rows: unknown): { cols: number; rows: number } => ({ cols: clampInt(cols, COLS), rows: clampInt(rows, ROWS) });

/** A folder to start in: the one asked for when it exists (`~` and `~/…` allowed), else home. */
export function resolveTerminalCwd(raw: unknown, home = homedir()): string {
	const text = typeof raw === "string" ? raw.trim() : "";
	const path = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
	if (!path || !isAbsolute(path)) return home;
	try {
		return statSync(path).isDirectory() ? resolve(path) : home;
	} catch {
		return home;
	}
}

/** The account's login shell (Bun's userInfo().shell is just $SHELL), then $SHELL, then zsh. */
export function loginShell(): string {
	const user = userInfo().username;
	const read = (cmd: string[], pick: (out: string) => string | undefined): string | undefined => {
		try {
			const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
			return proc.exitCode === 0 ? pick(proc.stdout.toString()) : undefined;
		} catch {
			return undefined;
		}
	};
	const account =
		process.platform === "darwin"
			? read(["dscl", ".", "-read", `/Users/${user}`, "UserShell"], (out) => /UserShell:\s*(\S+)/.exec(out)?.[1])
			: read(["getent", "passwd", user], (out) => out.trim().split(":")[6]);
	return account || process.env.SHELL?.trim() || "/bin/zsh";
}

const DROPPED_PREFIXES = ["PI_WEB_", "npm_", "GHOSTTY_", "ITERM_", "VSCODE_", "KITTY_", "WEZTERM_"];
const DROPPED_KEYS = new Set([
	"PI_CODING_AGENT_DIR",
	"TMUX",
	"TMUX_PANE",
	"STY",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
	"TERMINFO",
	"TERM_PROGRAM_VERSION",
	"TERM_SESSION_ID",
	"INSIDE_EMACS",
	"COLUMNS",
	"LINES",
	"ZDOTDIR",
]);

/**
 * The shell's environment: this server's, minus pi-web's own settings and whatever says which terminal or tmux started
 * the server, with pi-web's pbcopy/pbpaste first on PATH. zsh starts with ZDOTDIR at terminal-shell/zsh, which puts the
 * user's ZDOTDIR back and moves that bin folder to the front again once their startup files (and macOS's path_helper,
 * which reorders PATH in login shells) are done.
 */
export function terminalEnv(base: Record<string, string | undefined>, shell: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined || DROPPED_KEYS.has(key) || DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
		env[key] = value;
	}
	const binDir = join(SHELL_DIR, "bin");
	const path = (base.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin")
		.split(":")
		.filter((entry) => entry && !entry.endsWith("/node_modules/.bin") && entry !== binDir);
	env.PATH = [binDir, ...path].join(":");
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	env.TERM_PROGRAM = "pi-web";
	env.LANG ||= "en_US.UTF-8";
	env.PI_WEB_TERMINAL = "1";
	env.PI_WEB_TERMINAL_BIN = binDir;
	if (basename(shell) === "zsh") {
		if (base.ZDOTDIR) env.PI_WEB_USER_ZDOTDIR = base.ZDOTDIR;
		env.ZDOTDIR = join(SHELL_DIR, "zsh");
	}
	return env;
}

async function psField(field: string, pid: number): Promise<string> {
	const proc = Bun.spawn(["ps", "-o", `${field}=`, "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	return text.trim();
}

/** What runs in the foreground of a shell's terminal (vim, ssh…), or null when the shell itself waits at its prompt. */
export async function foregroundCommand(shellPid: number): Promise<string | null> {
	const group = Number.parseInt(await psField("tpgid", shellPid), 10);
	if (!Number.isFinite(group) || group <= 0 || group === shellPid) return null;
	const command = await psField("comm", group);
	return command ? basename(command) : "a program";
}

export interface TerminalManagerOptions {
	log?: (line: string) => void;
	now?: () => number;
	maxTerminals?: number;
	shell?: string;
	env?: Record<string, string | undefined>;
}

export function createTerminalManager(options: TerminalManagerOptions = {}) {
	const log = options.log ?? ((line: string) => console.log(line));
	const now = options.now ?? Date.now;
	const maxTerminals = options.maxTerminals ?? MAX_TERMINALS;
	let shell = options.shell ?? null;
	const baseEnv = options.env ?? process.env;
	const terminals = new Map<string, LiveTerminal>();

	const send = (peer: TerminalPeer, message: TerminalServerMessage): void => {
		peer.sendText(JSON.stringify(message));
	};

	function onOutput(live: LiveTerminal, chunk: Uint8Array): void {
		if (live.ended) return;
		// the pty may reuse its read buffer, and the mirror parses later
		const bytes = chunk.slice();
		live.mirror.write(bytes);
		for (const [peer, state] of live.peers) {
			if (!state.live) {
				state.queue.push(bytes);
				continue;
			}
			if (state.resync) continue;
			if (peer.sendBinary(bytes) === 0) state.resync = true;
		}
	}

	/**
	 * The screen as the mirror has it, then everything after: the empty write marks the spot, its callback runs once the
	 * mirror parsed up to there, and output that arrived meanwhile waits in the queue.
	 */
	function sendSnapshot(live: LiveTerminal, peer: TerminalPeer, state: PeerState): void {
		state.live = false;
		state.queue = [];
		live.mirror.write(EMPTY, () => {
			if (live.ended || live.peers.get(peer) !== state) return;
			const data = live.serializer.serialize({ scrollback: SCROLLBACK_LINES });
			send(peer, { type: "snapshot", data, cols: live.cols, rows: live.rows });
			for (const bytes of state.queue) peer.sendBinary(bytes);
			state.queue = [];
			state.live = true;
			state.resync = false;
		});
	}

	function end(live: LiveTerminal, reason: TerminalEndReason, code: number | null = null): void {
		if (live.ended) return;
		live.ended = true;
		terminals.delete(live.info.id);
		if (reason !== "exited") {
			// a hangup ends the shell and whatever runs in its foreground (ssh, vim), like closing a terminal window
			live.pty.close();
			live.proc.kill("SIGHUP");
			const timer = setTimeout(() => live.proc.kill("SIGKILL"), KILL_GRACE_MS);
			timer.unref();
			void live.proc.exited.then(() => clearTimeout(timer));
		} else {
			live.pty.close();
		}
		for (const peer of live.peers.keys()) {
			send(peer, { type: "exit", reason, code });
			peer.close(1000, reason);
		}
		live.peers.clear();
		live.mirror.dispose();
		log(`[terminal] closed ${live.info.id} (${reason}${code === null ? "" : `, code ${String(code)}`})`);
	}

	function create(request: { cwd?: unknown; cols?: unknown; rows?: unknown; expiresAt: number | null; openedBy: string }): TerminalInfo {
		if (terminals.size >= maxTerminals) throw new Error("too_many_terminals");
		const { cols, rows } = terminalSize(request.cols, request.rows);
		const cwd = resolveTerminalCwd(request.cwd);
		const info: TerminalInfo = { id: randomUUID(), cwd, title: null, createdAt: now(), expiresAt: request.expiresAt };
		const mirror = new HeadlessTerminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
		const serializer = new SerializeAddon();
		mirror.loadAddon(serializer);
		shell ??= loginShell();
		// output arrives on a later tick, after the terminal below is in place
		let slot: LiveTerminal | null = null;
		const proc = Bun.spawn([shell, "-l"], {
			cwd,
			env: terminalEnv(baseEnv, shell),
			terminal: {
				cols,
				rows,
				name: "xterm-256color",
				data: (_pty, chunk) => {
					if (slot) onOutput(slot, chunk);
				},
			},
		});
		const pty = proc.terminal;
		if (!pty) {
			proc.kill("SIGKILL");
			mirror.dispose();
			throw new Error("terminal_unavailable");
		}
		const live: LiveTerminal = { info, proc, pty, mirror, serializer, cols, rows, peers: new Map(), ended: false };
		slot = live;
		mirror.onTitleChange((title) => {
			info.title = title.slice(0, 200) || null;
		});
		terminals.set(info.id, live);
		void proc.exited.then((code) => end(live, "exited", code));
		log(`[terminal] opened ${info.id} in ${cwd} (${request.openedBy})`);
		return { ...info };
	}

	const live = (id: string): LiveTerminal | null => {
		const found = terminals.get(id);
		return found && !found.ended ? found : null;
	};

	function resize(target: LiveTerminal, cols: unknown, rows: unknown): void {
		const size = terminalSize(cols, rows);
		if (size.cols === target.cols && size.rows === target.rows) return;
		target.cols = size.cols;
		target.rows = size.rows;
		target.pty.resize(size.cols, size.rows);
		target.mirror.resize(size.cols, size.rows);
	}

	/** A websocket attaching: its size first (the shell redraws for it), then the screen, then live output. */
	function attach(id: string, peer: TerminalPeer, size: { cols?: unknown; rows?: unknown }): boolean {
		const target = live(id);
		if (!target) return false;
		if (size.cols !== undefined && size.rows !== undefined) resize(target, size.cols, size.rows);
		const state: PeerState = { live: false, queue: [], resync: false };
		target.peers.set(peer, state);
		send(peer, { type: "expires", at: target.info.expiresAt });
		sendSnapshot(target, peer, state);
		return true;
	}

	function detach(id: string, peer: TerminalPeer): void {
		terminals.get(id)?.peers.delete(peer);
	}

	/** A socket that dropped output catches up with a fresh snapshot once it can take more. */
	function drain(id: string, peer: TerminalPeer): void {
		const target = live(id);
		const state = target?.peers.get(peer);
		if (target && state?.resync && state.live) sendSnapshot(target, peer, state);
	}

	/** Browser frames: {type: "input", data} (keys and pastes), {type: "binary", data} (byte strings), {type: "resize", cols, rows}. */
	function handleMessage(id: string, raw: string): void {
		const target = live(id);
		if (!target) return;
		let message: unknown;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (!message || typeof message !== "object") return;
		const { type, data, cols, rows } = message as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
		if (type === "input" && typeof data === "string") target.pty.write(data);
		else if (type === "binary" && typeof data === "string") target.pty.write(Buffer.from(data, "latin1"));
		else if (type === "resize") resize(target, cols, rows);
	}

	function close(id: string, reason: TerminalEndReason = "closed"): boolean {
		const target = live(id);
		if (!target) return false;
		end(target, reason);
		return true;
	}

	/** A newer Face ID check pushes back when the shells it covers end. */
	function extend(expiresAt: number): void {
		for (const target of terminals.values()) {
			if (target.info.expiresAt === null || target.info.expiresAt >= expiresAt) continue;
			target.info.expiresAt = expiresAt;
			for (const peer of target.peers.keys()) send(peer, { type: "expires", at: expiresAt });
		}
	}

	function sweepExpired(): void {
		const at = now();
		for (const target of [...terminals.values()]) {
			if (target.info.expiresAt !== null && target.info.expiresAt <= at) end(target, "expired");
		}
	}

	const sweeper = setInterval(sweepExpired, EXPIRY_SWEEP_MS);
	sweeper.unref();

	return {
		create,
		attach,
		detach,
		drain,
		handleMessage,
		close,
		extend,
		sweepExpired,
		get: (id: string): TerminalInfo | null => {
			const target = live(id);
			return target ? { ...target.info } : null;
		},
		list: (): TerminalInfo[] => [...terminals.values()].filter((target) => !target.ended).map((target) => ({ ...target.info })),
		count: (): number => terminals.size,
		/** What runs in the foreground of a terminal's shell, so closing it can ask first. */
		foreground: async (id: string): Promise<string | null> => {
			const target = live(id);
			return target ? foregroundCommand(target.proc.pid) : null;
		},
		shutdown(): void {
			clearInterval(sweeper);
			for (const target of [...terminals.values()]) end(target, "shutdown");
		},
	};
}

export type TerminalManager = ReturnType<typeof createTerminalManager>;
