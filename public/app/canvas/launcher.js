// The launcher tile: pick a directory (saved repos + the server's cwd, or type a path to add one), then a
// session from it (newest first) or a new one. The host turns the launcher into that session's tile in place, or flies to the
// tile when the session is already on the canvas. Answers a project trust prompt inline.
import { createSessionWithTrust } from "../session/project_trust.js";

const SESSION_LIMIT = 100;

/**
 * @typedef {{ id: string, path: string | null, cwd: string, name?: string, firstMessage?: string, modified?: string, isRunning?: boolean, elsewhere?: { state: string }, forkLabel?: string }} SessionSummary
 * @typedef {{ kind: "created", sessionId: string, cwd: string } | { kind: "session", session: SessionSummary }} LauncherPick
 * @typedef {{ key: string, primary: string, secondary: string, badge?: string, pick: () => void }} Row
 */

/** @param {string} cwd */
export const repoName = (cwd) => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

/** @param {SessionSummary} session */
export function sessionLabel(session) {
	const name = session.name?.trim();
	if (name) return name;
	const first = session.firstMessage?.trim().split("\n")[0]?.trim();
	return first && first !== "(no messages)" ? first.slice(0, 120) : session.id.slice(0, 8);
}

/**
 * What another pi is doing with a session this host doesn't run (the phone's sidebar says the same): "" when nothing.
 * @param {SessionSummary} session
 */
export function elsewhereBadge(session) {
	if (session.isRunning) return "";
	const state = session.elsewhere?.state;
	if (state === "running") return "running elsewhere";
	if (state === "quiet") return "quiet elsewhere";
	if (state === "stopped") return "stopped mid-turn";
	return "";
}

/** Sessions worth listing: running here or elsewhere, named, or with a first message (like the phone's sidebar). @param {SessionSummary} session */
export function isListable(session) {
	if (!session || typeof session.id !== "string") return false;
	if (session.isRunning || elsewhereBadge(session) || session.name?.trim()) return true;
	const first = session.firstMessage?.trim();
	return Boolean(first && first !== "(no messages)");
}

/** @param {string | undefined} iso @param {number} now */
export function relativeTime(iso, now) {
	const at = iso ? Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(at)) return "";
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * The folder a directory query asks to add: a path (/… or ~…) that isn't saved yet, else null.
 * @param {string} query @param {string[]} repos
 */
export function addableDirectory(query, repos) {
	const path = query.trim();
	if (!/^(\/|~(\/|$))/.test(path)) return null;
	const bare = path.length > 1 ? path.replace(/\/+$/, "") : path;
	return repos.includes(bare) ? null : path;
}

/** Every word of the query appears somewhere in the text (case-insensitive). @param {string} query @param {string} text */
export function matchesQuery(query, text) {
	const hay = text.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => hay.includes(word));
}

/**
 * @param {{
 *   doc: Document,
 *   api: any,
 *   getClientId: () => string | null,
 *   isOnCanvas: (sessionId: string) => boolean,
 *   onPick: (pick: LauncherPick) => void,
 *   onClose: () => void,
 *   onTitle?: (title: string) => void,
 * }} options
 */
export function createLauncher({ doc, api, getClientId, isOnCanvas, onPick, onClose, onTitle = () => {} }) {
	/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} className @param {string} [text] */
	function h(tag, className, text) {
		const el = doc.createElement(tag);
		el.className = className;
		if (text !== undefined) el.textContent = text;
		return el;
	}

	const el = h("div", "cv-launch");
	const back = h("button", "cv-launch-back", "←");
	back.type = "button";
	back.title = "Back to directories";
	const crumb = h("div", "cv-launch-crumb");
	const head = h("div", "cv-launch-head");
	head.append(back, crumb);
	const search = /** @type {HTMLInputElement} */ (h("input", "cv-launch-search"));
	search.type = "text";
	search.spellcheck = false;
	search.autocomplete = "off";
	const list = h("div", "cv-launch-list");
	list.setAttribute("role", "listbox");
	const foot = h("div", "cv-launch-foot");
	el.append(head, search, list, foot);

	/** @type {{ step: "repos" } | { step: "sessions", cwd: string } | { step: "trust", cwd: string }} */
	let view = { step: "repos" };
	/** @type {string[]} */
	let repos = [];
	/** @type {SessionSummary[]} */
	let sessions = [];
	let hasMore = false;
	/** @type {Row[]} */
	let rows = [];
	let active = 0;
	let loading = false;
	let busy = false;
	let generation = 0;
	let destroyed = false;
	/** @type {((choice: unknown) => void) | null} */
	let trustAnswer = null;
	/** @type {{ title: string, message: string, options: Array<{ label: string, choice: unknown }> } | null} */
	let trustPrompt = null;

	/** @param {string} text @param {"info" | "error"} [kind] */
	function setFoot(text, kind = "info") {
		foot.textContent = text;
		foot.classList.toggle("is-error", kind === "error");
	}

	function hint() {
		if (view.step === "trust") return "enter answers · esc cancels";
		return view.step === "repos" ? "↑↓ · enter opens · a /path adds it · esc closes" : "↑↓ · enter opens · esc goes back";
	}

	/** @returns {Row[]} */
	function buildRows() {
		const query = search.value.trim();
		if (view.step === "trust") {
			return (trustPrompt?.options ?? []).map((option, index) => ({
				key: `trust:${index}`,
				primary: option.label,
				secondary: "",
				pick: () => answerTrust(option.choice),
			}));
		}
		if (view.step === "repos") {
			const addable = addableDirectory(query, repos);
			const add = addable === null ? [] : [{ key: "add-repo", primary: "+ add directory", secondary: addable, pick: () => void addDirectory(addable) }];
			const saved = repos
				.filter((cwd) => matchesQuery(query, cwd))
				.map((cwd) => ({ key: `repo:${cwd}`, primary: repoName(cwd), secondary: cwd, pick: () => void openRepo(cwd) }));
			return [...add, ...saved];
		}
		const { cwd } = view;
		const now = Date.now();
		const fresh = { key: "new", primary: "+ new session", secondary: cwd, pick: () => void startSession(cwd) };
		const listed = sessions
			.filter((session) => matchesQuery(query, `${sessionLabel(session)} ${session.id}`))
			.map((session) => ({
				key: `session:${session.id}`,
				primary: sessionLabel(session),
				secondary: [relativeTime(session.modified, now), session.id.slice(0, 8)].filter(Boolean).join(" · "),
				badge: isOnCanvas(session.id) ? "on canvas" : session.isRunning ? "running" : elsewhereBadge(session) || undefined,
				pick: () => onPick({ kind: "session", session }),
			}));
		return [fresh, ...listed];
	}

	function render() {
		if (destroyed) return;
		back.hidden = view.step === "repos";
		crumb.textContent = view.step === "repos" ? "open a session · pick a directory" : view.step === "trust" ? "trust this folder?" : `${repoName(view.cwd)} · pick a session`;
		crumb.title = view.step === "repos" ? "" : view.cwd;
		search.placeholder = view.step === "repos" ? "filter directories, or type a /path to add one" : view.step === "trust" ? "" : "filter sessions";
		search.hidden = view.step === "trust";
		rows = buildRows();
		active = Math.min(Math.max(0, active), Math.max(0, rows.length - 1));
		const nodes = rows.map((row, index) => {
			const button = h("button", `cv-launch-row${index === active ? " is-active" : ""}`);
			button.type = "button";
			button.dataset.key = row.key;
			button.setAttribute("role", "option");
			button.setAttribute("aria-selected", String(index === active));
			button.disabled = busy;
			const text = h("span", "cv-launch-text");
			text.append(h("span", "cv-launch-primary", row.primary));
			if (row.secondary) text.append(h("span", "cv-launch-secondary", row.secondary));
			button.append(text);
			if (row.badge) button.append(h("span", "cv-launch-badge", row.badge));
			button.addEventListener("click", () => row.pick());
			return button;
		});
		if (view.step === "trust" && trustPrompt) {
			const intro = h("div", "cv-launch-note", `${trustPrompt.title}\n${trustPrompt.message}`);
			list.replaceChildren(intro, ...nodes);
		} else {
			list.replaceChildren(...nodes);
		}
		if (loading) list.append(h("div", "cv-launch-note", "loading…"));
		else if (rows.length === 0) list.append(h("div", "cv-launch-note", search.value.trim() ? "nothing matches" : "nothing here yet"));
		if (view.step === "sessions" && hasMore && !loading) list.append(h("div", "cv-launch-note", `showing the newest ${SESSION_LIMIT}; filter to narrow down`));
		if (!foot.classList.contains("is-error")) setFoot(hint());
	}

	/** @param {unknown} error */
	const messageOf = (error) => (error instanceof Error ? error.message : String(error));

	async function loadRepos() {
		const mine = ++generation;
		loading = true;
		render();
		try {
			const data = await api.getJson("/api/repos");
			if (mine !== generation) return;
			repos = Array.isArray(data?.repos) ? data.repos.filter((/** @type {unknown} */ cwd) => typeof cwd === "string") : [];
			setFoot(hint());
		} catch (error) {
			if (mine !== generation) return;
			setFoot(`Couldn't list directories: ${messageOf(error)}`, "error");
		} finally {
			if (mine === generation) {
				loading = false;
				render();
			}
		}
	}

	/** Saves a typed folder on the host, then opens it like a saved one. @param {string} path */
	async function addDirectory(path) {
		if (busy) return;
		busy = true;
		setFoot("adding the directory…");
		render();
		try {
			const result = await api.postJson("/api/repos", { cwd: path });
			if (destroyed) return;
			const cwd = typeof result?.cwd === "string" ? result.cwd : path;
			if (!repos.includes(cwd)) repos = [...repos, cwd].sort((a, b) => a.localeCompare(b));
			busy = false;
			await openRepo(cwd);
		} catch (error) {
			if (destroyed) return;
			busy = false;
			setFoot(`Couldn't add the directory: ${messageOf(error)}`, "error");
			render();
		}
	}

	/** @param {string} cwd */
	async function openRepo(cwd) {
		view = { step: "sessions", cwd };
		search.value = "";
		active = 0;
		sessions = [];
		hasMore = false;
		onTitle(`${repoName(cwd)} · new tile`);
		setFoot(hint());
		const mine = ++generation;
		loading = true;
		render();
		search.focus({ preventScroll: true });
		try {
			const query = new URLSearchParams({ cwd, limit: String(SESSION_LIMIT) });
			const data = await api.getJson(`/api/sessions?${query.toString()}`);
			if (mine !== generation) return;
			sessions = (Array.isArray(data?.sessions) ? data.sessions : []).filter(isListable);
			hasMore = Boolean(data?.hasMore);
		} catch (error) {
			if (mine !== generation) return;
			setFoot(`Couldn't list sessions: ${messageOf(error)}`, "error");
		} finally {
			if (mine === generation) {
				loading = false;
				render();
			}
		}
	}

	/** @param {any} prompt @returns {Promise<unknown>} */
	function askTrust(prompt) {
		const cwd = view.step === "sessions" ? view.cwd : String(prompt.cwd ?? "");
		trustPrompt = {
			title: `Trust project folder? ${prompt.cwd}`,
			message: "This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.",
			options: (Array.isArray(prompt.options) ? prompt.options : []).map((/** @type {any} */ option) => ({ label: String(option.label), choice: option.choice })),
		};
		view = { step: "trust", cwd };
		active = 0;
		busy = false;
		render();
		return new Promise((resolve) => {
			trustAnswer = resolve;
		});
	}

	/** @param {unknown} choice */
	function answerTrust(choice) {
		const answer = trustAnswer;
		trustAnswer = null;
		trustPrompt = null;
		if (view.step === "trust") {
			view = { step: "sessions", cwd: view.cwd };
			busy = choice !== null;
			render();
		}
		answer?.(choice);
	}

	/** @param {string} cwd */
	async function startSession(cwd) {
		if (busy) return;
		busy = true;
		setFoot("starting a session…");
		render();
		try {
			const result = await createSessionWithTrust({ api, payload: { clientId: getClientId(), cwd }, ask: askTrust });
			if (destroyed) return;
			if (!result?.sessionId) throw new Error("the session did not start");
			onPick({ kind: "created", sessionId: result.sessionId, cwd });
		} catch (error) {
			if (destroyed) return;
			busy = false;
			view = { step: "sessions", cwd };
			setFoot(`Couldn't start a session: ${messageOf(error)}`, "error");
			render();
		}
	}

	function goBack() {
		if (view.step === "trust") {
			answerTrust(null);
			return;
		}
		view = { step: "repos" };
		search.value = "";
		active = 0;
		generation += 1;
		loading = false;
		onTitle("new tile");
		setFoot(hint());
		render();
		search.focus({ preventScroll: true });
	}

	/** @param {number} delta */
	function move(delta) {
		if (rows.length === 0) return;
		active = (active + delta + rows.length) % rows.length;
		for (const [index, node] of [...list.querySelectorAll(".cv-launch-row")].entries()) {
			node.classList.toggle("is-active", index === active);
			node.setAttribute("aria-selected", String(index === active));
			if (index === active) node.scrollIntoView({ block: "nearest" });
		}
	}

	search.addEventListener("input", () => {
		active = 0;
		if (foot.classList.contains("is-error")) setFoot(hint());
		render();
	});
	search.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			move(event.key === "ArrowDown" ? 1 : -1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (!busy) rows[active]?.pick();
		} else if (event.key === "Backspace" && !search.value && view.step === "sessions") {
			event.preventDefault();
			goBack();
		}
	});
	list.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		move(event.key === "ArrowDown" ? 1 : -1);
		/** @type {HTMLElement | null} */ (list.querySelector(".cv-launch-row.is-active"))?.focus({ preventScroll: true });
	});
	back.addEventListener("click", goBack);

	render();
	void loadRepos();

	return {
		el,
		focus: () => (view.step === "trust" ? /** @type {HTMLElement | null} */ (list.querySelector(".cv-launch-row"))?.focus({ preventScroll: true }) : search.focus({ preventScroll: true })),
		/** Esc steps back, and closes the launcher from the first step. @param {KeyboardEvent} event */
		handleEscape(event) {
			event.preventDefault();
			if (view.step === "repos") onClose();
			else goBack();
		},
		/** @param {string} cwd jump straight to a directory's sessions */
		openRepo: (cwd) => void openRepo(cwd),
		destroy() {
			destroyed = true;
			generation += 1;
			answerTrust(null);
		},
	};
}
