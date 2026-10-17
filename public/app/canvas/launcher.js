// The launcher tile: pick a directory (saved repos + the server's cwd, folders pi has been used in, or a typed /path or ~/path
// that browses the host's folders and adds or creates one), then a session from it (newest first), a new one, or a terminal
// there (on the host serving the page). The host turns
// the launcher into that session's tile in place, or flies to the tile when the session is already on the canvas. Answers a
// project trust prompt inline.
import { createSessionWithTrust } from "../session/project_trust.js";

const SESSION_LIMIT = 100;
/** Typing within one folder waits this long before asking the host again; a new folder is asked for right away. */
const DIR_DEBOUNCE_MS = 120;

/**
 * @typedef {{ id: string, path: string | null, cwd: string, name?: string, firstMessage?: string, modified?: string, isRunning?: boolean, elsewhere?: { state: string }, forkLabel?: string }} SessionSummary
 * @typedef {{ kind: "created", sessionId: string, cwd: string } | { kind: "session", session: SessionSummary } | { kind: "terminal", cwd: string }} LauncherPick
 * @typedef {{ key: string, primary: string, secondary: string, badge?: string, muted?: boolean, pick: () => void, complete?: string }} Row
 * @typedef {{ name: string, path: string }} DirEntry
 * @typedef {{ query: string, path: string, exists: boolean, parent: string, parentExists: boolean, insideHome: boolean, canCreate: boolean, entries: DirEntry[], truncated: boolean }} DirListing
 * @typedef {{ fresh: boolean, path: string, exists: boolean, canCreate: boolean, entries: DirEntry[] }} TypedFolder
 * @typedef {{ cwd: string, modified?: string, sessions?: number, forkLabel?: string }} RepoSuggestion
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

/** A directory query that names a folder on the host (/…, ~ or ~/…) instead of filtering the listed ones. @param {string} query */
export const isPathQuery = (query) => /^(\/|~(\/|$))/.test(query.trim());

/**
 * The folder a directory query asks to add: a path (/… or ~…) that isn't saved yet, else null.
 * @param {string} query @param {string[]} repos
 */
export function addableDirectory(query, repos) {
	const path = query.trim();
	if (!isPathQuery(path)) return null;
	const bare = path.length > 1 ? path.replace(/\/+$/, "") : path;
	return repos.includes(bare) ? null : path;
}

/**
 * Where a typed path gets listed: the folder as typed through its last slash ("~" lists home), and the name typed after it.
 * @param {string} query @returns {{ prefix: string, leaf: string }}
 */
export function splitPathQuery(query) {
	const text = query.trim() === "~" ? "~/" : query.trim();
	const cut = text.lastIndexOf("/") + 1;
	return { prefix: text.slice(0, cut), leaf: text.slice(cut) };
}

/** A name the host can make one folder with (it checks again). @param {string} name */
export const isCreatableName = (name) => name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");

/** Subfolders starting with the typed name in any case; hidden ones only once it starts with a dot. @param {DirEntry[]} entries @param {string} leaf */
export function filterDirEntries(entries, leaf) {
	const lower = leaf.toLowerCase();
	return entries.filter((entry) => (leaf.startsWith(".") || !entry.name.startsWith(".")) && entry.name.toLowerCase().startsWith(lower));
}

/**
 * What the last listing says about a path typed in the same folder: exact when it answered this very query, else narrowed on
 * the spot so the rows keep up with typing until the host answers. Null when it listed another folder.
 * @param {DirListing | null} listing @param {string} query @returns {TypedFolder | null}
 */
export function readListing(listing, query) {
	const typed = query.trim();
	if (!listing) return null;
	const { prefix, leaf } = splitPathQuery(typed);
	if (splitPathQuery(listing.query).prefix !== prefix) return null;
	const entries = filterDirEntries(listing.entries, leaf);
	if (listing.query === typed) return { fresh: true, path: listing.path, exists: listing.exists, canCreate: listing.canCreate, entries };
	const exists = leaf === "" ? listing.parentExists : listing.entries.some((entry) => entry.name === leaf);
	const path = leaf === "" ? listing.parent : `${listing.parent.replace(/\/+$/, "")}/${leaf}`;
	return { fresh: false, path, exists, canCreate: !exists && listing.parentExists && listing.insideHome && isCreatableName(leaf), entries };
}

/** @param {string} query @param {any} data @returns {DirListing} */
function toListing(query, data) {
	const entries = Array.isArray(data?.entries) ? data.entries : [];
	return {
		query,
		path: typeof data?.path === "string" ? data.path : "",
		exists: data?.exists === true,
		parent: typeof data?.parent === "string" ? data.parent : "",
		parentExists: data?.parentExists === true,
		insideHome: data?.insideHome === true,
		canCreate: data?.canCreate === true,
		entries: entries
			.filter((/** @type {any} */ entry) => typeof entry?.name === "string" && typeof entry?.path === "string")
			.map((/** @type {DirEntry} */ entry) => ({ name: entry.name, path: entry.path })),
		truncated: data?.truncated === true,
	};
}

/** @param {string} path */
const withSlash = (path) => (path.endsWith("/") ? path : `${path}/`);

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
 *   canOpenTerminal?: () => boolean,
 * }} options
 */
export function createLauncher({ doc, api, getClientId, isOnCanvas, onPick, onClose, onTitle = () => {}, canOpenTerminal = () => false }) {
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
	let reposLoaded = false;
	/** @type {RepoSuggestion[]} */
	let suggestions = [];
	/** @type {DirListing | null} */
	let dirs = null;
	let dirsPending = false;
	let dirSeq = 0;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let dirTimer = null;
	/** @type {SessionSummary[]} */
	let sessions = [];
	let hasMore = false;
	/** @type {Row[]} */
	let rows = [];
	let active = 0;
	/** Arrow keys moved the highlight since the query last changed, so answers from the host keep it on that row. */
	let navigated = false;
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
		if (view.step === "sessions") return "↑↓ · enter opens · esc goes back";
		return isPathQuery(search.value) ? "↑↓ · enter opens · tab completes · esc closes" : "↑↓ · enter opens · / or ~/ browses folders · esc closes";
	}

	/** @param {string} cwd @param {string} typed */
	const savedFolderRow = (cwd, typed) => ({ key: `repo:${cwd}`, primary: repoName(cwd), secondary: cwd, badge: "saved", pick: () => void openRepo(cwd), complete: withSlash(typed) });

	/** @param {string} typed */
	const addRow = (typed) => ({ key: "add-repo", primary: "+ add directory", secondary: typed, pick: () => void saveDirectory(typed, false), complete: withSlash(typed) });

	/** @param {DirEntry} entry @param {string} prefix @returns {Row} */
	function folderRow(entry, prefix) {
		const saved = repos.includes(entry.path);
		return {
			key: `dir:${entry.path}`,
			primary: entry.name,
			secondary: `${prefix}${entry.name}`,
			badge: saved ? "saved" : undefined,
			pick: () => void (saved ? openRepo(entry.path) : saveDirectory(entry.path, false)),
			complete: `${prefix}${entry.name}/`,
		};
	}

	/**
	 * A typed path: the folder itself first (open it when saved, add it when it exists), then the subfolders that continue it,
	 * then "+ create folder" when it could be made, so enter on a half-typed name picks the folder it starts, never a new one.
	 * @param {string} query @returns {Row[]}
	 */
	function pathRows(query) {
		const { prefix, leaf } = splitPathQuery(query);
		// "." and ".." are the start of a hidden name or a step up, not a folder to add
		const namesFolder = leaf !== "." && leaf !== "..";
		const found = readListing(dirs, query);
		if (!found) {
			const addable = addableDirectory(query, repos);
			if (!namesFolder) return [];
			return [addable === null ? savedFolderRow(query.length > 1 ? query.replace(/\/+$/, "") : query, query) : addRow(addable)];
		}
		const self = found.exists && namesFolder ? (repos.includes(found.path) ? savedFolderRow(found.path, query) : addRow(query)) : null;
		const children = found.entries.filter((entry) => !(self && entry.name === leaf)).map((entry) => folderRow(entry, prefix));
		const create = found.canCreate ? [{ key: "create-dir", primary: "+ create folder", secondary: query, pick: () => void saveDirectory(query, true) }] : [];
		return [...(self ? [self] : []), ...children, ...create];
	}

	/** What the rows can't say about a typed path. @param {string} query @param {number} shown */
	function pathNote(query, shown) {
		const found = readListing(dirs, query);
		if (!dirs || !found?.fresh) return dirsPending && shown === 0 ? "looking…" : "";
		const { prefix, leaf } = splitPathQuery(query);
		if (!dirs.parentExists) return `no folder at ${prefix}`;
		if (!found.exists && !found.canCreate && !dirs.insideHome && isCreatableName(leaf)) return "new folders go inside your home folder";
		if (dirs.truncated) return `showing the first ${String(dirs.entries.length)}; keep typing to narrow down`;
		return "";
	}

	/** Saved folders, then folders pi has been used in that aren't saved yet. @param {string} query @returns {Row[]} */
	function folderRows(query) {
		const now = Date.now();
		const saved = repos
			.filter((cwd) => matchesQuery(query, cwd))
			.map((cwd) => ({ key: `repo:${cwd}`, primary: repoName(cwd), secondary: cwd, pick: () => void openRepo(cwd), complete: withSlash(cwd) }));
		const used = suggestions
			.filter((suggestion) => !repos.includes(suggestion.cwd) && matchesQuery(query, `${suggestion.forkLabel ?? ""} ${suggestion.cwd}`))
			.map((suggestion) => ({
				key: `suggest:${suggestion.cwd}`,
				primary: suggestion.forkLabel ?? repoName(suggestion.cwd),
				secondary: [relativeTime(suggestion.modified, now), suggestion.cwd].filter(Boolean).join(" · "),
				badge: "not added",
				muted: true,
				pick: () => void saveDirectory(suggestion.cwd, false),
				complete: withSlash(suggestion.cwd),
			}));
		return [...saved, ...used];
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
		if (view.step === "repos") return isPathQuery(query) ? pathRows(query) : folderRows(query);
		const { cwd } = view;
		const now = Date.now();
		const fresh = { key: "new", primary: "+ new session", secondary: cwd, pick: () => void startSession(cwd) };
		const terminal = canOpenTerminal() ? [{ key: "terminal", primary: "+ new terminal", secondary: cwd, pick: () => onPick({ kind: "terminal", cwd }) }] : [];
		const listed = sessions
			.filter((session) => matchesQuery(query, `${sessionLabel(session)} ${session.id}`))
			.map((session) => ({
				key: `session:${session.id}`,
				primary: sessionLabel(session),
				secondary: [relativeTime(session.modified, now), session.id.slice(0, 8)].filter(Boolean).join(" · "),
				badge: isOnCanvas(session.id) ? "on canvas" : session.isRunning ? "running" : elsewhereBadge(session) || undefined,
				pick: () => onPick({ kind: "session", session }),
			}));
		return [fresh, ...terminal, ...listed];
	}

	/** @param {number} shown */
	function notes(shown) {
		const query = search.value.trim();
		if (view.step === "repos" && isPathQuery(query)) {
			const note = pathNote(query, shown);
			return note ? [note] : shown === 0 ? ["nothing matches"] : [];
		}
		const waiting = view.step === "repos" ? !reposLoaded : loading;
		const found = waiting ? ["loading…"] : shown === 0 ? [query ? "nothing matches" : "nothing here yet"] : [];
		const more = view.step === "sessions" && hasMore && !loading ? [`showing the newest ${SESSION_LIMIT}; filter to narrow down`] : [];
		return [...found, ...more];
	}

	/** Rebuilds the rows; the highlight is the first row unless arrow keys moved it, then it stays on that row while it's listed. */
	function render() {
		if (destroyed) return;
		back.hidden = view.step === "repos";
		crumb.textContent = view.step === "repos" ? "open a session · pick a directory" : view.step === "trust" ? "trust this folder?" : `${repoName(view.cwd)} · pick a session`;
		crumb.title = view.step === "repos" ? "" : view.cwd;
		search.placeholder = view.step === "repos" ? "filter directories, or type a /path or ~/path" : view.step === "trust" ? "" : "filter sessions";
		search.hidden = view.step === "trust";
		const activeKey = navigated ? rows[active]?.key : undefined;
		rows = buildRows();
		const kept = activeKey === undefined ? -1 : rows.findIndex((row) => row.key === activeKey);
		active = kept >= 0 ? kept : navigated ? Math.min(Math.max(0, active), Math.max(0, rows.length - 1)) : 0;
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
			if (row.badge) button.append(h("span", `cv-launch-badge${row.muted ? " is-muted" : ""}`, row.badge));
			button.addEventListener("click", () => row.pick());
			return button;
		});
		if (view.step === "trust" && trustPrompt) {
			const intro = h("div", "cv-launch-note", `${trustPrompt.title}\n${trustPrompt.message}`);
			list.replaceChildren(intro, ...nodes);
		} else {
			list.replaceChildren(...nodes);
		}
		list.append(...notes(rows.length).map((text) => h("div", "cv-launch-note", text)));
		if (!foot.classList.contains("is-error")) setFoot(hint());
	}

	/** @param {unknown} error */
	const messageOf = (error) => (error instanceof Error ? error.message : String(error));

	async function loadRepos() {
		void loadSuggestions();
		try {
			const data = await api.getJson("/api/repos");
			if (destroyed) return;
			repos = Array.isArray(data?.repos) ? data.repos.filter((/** @type {unknown} */ cwd) => typeof cwd === "string") : [];
		} catch (error) {
			if (destroyed) return;
			setFoot(`Couldn't list directories: ${messageOf(error)}`, "error");
		} finally {
			reposLoaded = true;
			render();
		}
	}

	async function loadSuggestions() {
		try {
			const data = await api.getJson("/api/repos/suggestions");
			if (destroyed) return;
			suggestions = (Array.isArray(data?.suggestions) ? data.suggestions : []).filter((/** @type {any} */ suggestion) => typeof suggestion?.cwd === "string");
			render();
		} catch {
			// only suggestions: the saved folders list without them
		}
	}

	/** @param {string} query */
	async function loadDirs(query) {
		const mine = ++dirSeq;
		try {
			const data = await api.getJson(`/api/dirs?${new URLSearchParams({ path: query }).toString()}`);
			if (mine !== dirSeq || destroyed) return;
			dirs = toListing(query, data);
			dirsPending = false;
		} catch (error) {
			if (mine !== dirSeq || destroyed) return;
			dirsPending = false;
			setFoot(`Couldn't list ${query}: ${messageOf(error)}`, "error");
		}
		render();
	}

	function cancelDirs() {
		if (dirTimer) clearTimeout(dirTimer);
		dirTimer = null;
		dirSeq += 1;
		dirsPending = false;
	}

	/** Asks the host about a typed path: right away for a new folder, after a pause for more of a name in the same one. */
	function scheduleDirs() {
		const query = search.value.trim();
		if (view.step !== "repos" || !isPathQuery(query) || dirs?.query === query) {
			cancelDirs();
			return;
		}
		if (dirTimer) clearTimeout(dirTimer);
		dirTimer = null;
		dirsPending = true;
		if (readListing(dirs, query) === null) {
			void loadDirs(query);
			return;
		}
		dirTimer = setTimeout(() => {
			dirTimer = null;
			void loadDirs(query);
		}, DIR_DEBOUNCE_MS);
	}

	function queryChanged() {
		active = 0;
		navigated = false;
		if (foot.classList.contains("is-error")) setFoot(hint());
		scheduleDirs();
		render();
	}

	/**
	 * Saves a folder on the host (making it first with create: one new folder inside home), then opens it like a saved one.
	 * @param {string} path @param {boolean} create
	 */
	async function saveDirectory(path, create) {
		if (busy) return;
		busy = true;
		setFoot(create ? "creating the folder…" : "adding the directory…");
		render();
		try {
			const result = await api.postJson("/api/repos", create ? { cwd: path, create: true } : { cwd: path });
			if (destroyed) return;
			const cwd = typeof result?.cwd === "string" ? result.cwd : path;
			if (!repos.includes(cwd)) repos = [...repos, cwd].sort((a, b) => a.localeCompare(b));
			dirs = null;
			busy = false;
			await openRepo(cwd);
		} catch (error) {
			if (destroyed) return;
			busy = false;
			setFoot(`Couldn't ${create ? "create the folder" : "add the directory"}: ${messageOf(error)}`, "error");
			render();
		}
	}

	/** @param {string} cwd */
	async function openRepo(cwd) {
		cancelDirs();
		view = { step: "sessions", cwd };
		search.value = "";
		active = 0;
		navigated = false;
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
		navigated = false;
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
		navigated = false;
		generation += 1;
		loading = false;
		cancelDirs();
		dirs = null;
		onTitle("new tile");
		setFoot(hint());
		render();
		search.focus({ preventScroll: true });
	}

	/** @param {number} delta */
	function move(delta) {
		if (rows.length === 0) return;
		navigated = true;
		active = (active + delta + rows.length) % rows.length;
		for (const [index, node] of [...list.querySelectorAll(".cv-launch-row")].entries()) {
			node.classList.toggle("is-active", index === active);
			node.setAttribute("aria-selected", String(index === active));
			if (index === active) node.scrollIntoView({ block: "nearest" });
		}
	}

	/** Tab puts the highlighted folder in the box (with a trailing slash) to list what's inside it. @param {KeyboardEvent} event */
	function complete(event) {
		const completion = rows[active]?.complete;
		if (!completion && !isPathQuery(search.value)) return;
		event.preventDefault();
		if (!completion || completion === search.value) return;
		search.value = completion;
		queryChanged();
	}

	search.addEventListener("input", queryChanged);
	search.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			move(event.key === "ArrowDown" ? 1 : -1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (!busy) rows[active]?.pick();
		} else if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && view.step === "repos") {
			complete(event);
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
			cancelDirs();
			answerTrust(null);
		},
	};
}
