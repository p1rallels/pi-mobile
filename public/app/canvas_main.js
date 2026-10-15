// The laptop canvas shell (?ui=canvas): Infinite in the browser. No sidebar: every tile is a session
// pane, and the HUD holds zoom, new tile and the host switcher. One tile per session; the red dot only
// takes a tile off the canvas (the session keeps running, release stays explicit in the ⋯ menu).
// Tiles of sessions that aren't running stay dormant (no runtime attached) until you click them.
import { createApi } from "./core/api.js";
import { installFaceIdGuard } from "./core/faceid.js";
import { createClientSessions, hostOrigin, isLoopbackBrowserHost, loadHostList, pageHost } from "./core/hosts.js";
import { createCanvas } from "./canvas/canvas.js";
import { createFpsMeter } from "./canvas/fps_meter.js";
import { nextFreeSlot } from "./canvas/layout.js";
import { createLocalLayoutStore, loadCamera, saveCamera } from "./canvas/layout_store.js";
import { buildPaneDom } from "./session/pane_dom.js";
import { createSessionPane } from "./session/pane.js";
import { createMenu } from "./ui/menu.js";

/** Boots the canvas shell (?ui=canvas, remembered; never on phones). */
export async function bootCanvas() {
	const SAVE_DEBOUNCE_MS = 400;
	const DEFAULT_CAMERA = { x: 48, y: 64, scale: 0.6 };

	/**
	 * @typedef {{
	 *   id: string,
	 *   path: string | null,
	 *   title: string,
	 *   pane: ReturnType<typeof createSessionPane>,
	 *   pill: HTMLElement,
	 *   dormant: boolean,
	 *   focusWhenReady: boolean,
	 *   shown: { title: string, pill: string },
	 * }} TileEntry
	 */

	/**
	 * @template {keyof HTMLElementTagNameMap} K
	 * @param {K} tag @param {string} className @param {string} [text]
	 */
	function h(tag, className, text) {
		const el = document.createElement(tag);
		el.className = className;
		if (text !== undefined) el.textContent = text;
		return el;
	}

	/** @param {string} id */
	const byId = (id) => document.getElementById(id);

	/** @param {string | null | undefined} cwd */
	const repoName = (cwd) => (cwd ? (cwd.split("/").filter(Boolean).at(-1) ?? cwd) : null);

	/** @param {{ id: string, cwd?: string, name?: string, firstMessage?: string }} session */
	function sessionTitle(session) {
		const label = session.name?.trim() || session.firstMessage?.trim().split("\n")[0]?.slice(0, 80) || session.id.slice(0, 8);
		return [repoName(session.cwd), label].filter(Boolean).join(" · ");
	}

	document.documentElement.classList.add("cv-page");
	for (const el of document.querySelectorAll("body > .app-header, body > .layout")) el.remove();
	const root = h("div", "cv-host");
	root.id = "canvas-root";
	document.body.prepend(root);
	const menuDom = { menuOverlay: byId("menu-overlay"), menuScrim: byId("menu-scrim"), menuPanel: byId("menu-panel") };

	const api = createApi({ baseUrl: window.location.origin });
	const clients = createClientSessions(api);
	let activeHost = pageHost();
	/** @type {any[]} */
	let hosts = [];
	let layoutStore = createLocalLayoutStore(window.localStorage, api.getBaseUrl());
	/** @type {Map<string, TileEntry>} */
	const entries = new Map();
	let saveTimer = 0;

	const canvas = createCanvas({
		root,
		camera: loadCamera(window.localStorage, api.getBaseUrl()) ?? DEFAULT_CAMERA,
		onNewTile: () => void addRunningSessions({ reveal: true }),
		onEmptyDoubleClick: () => void addRunningSessions({ reveal: true }),
		onFocusChange: (id) => {
			if (id) wake(id);
		},
		focusComposer: (id) => focusComposer(id),
		onCloseRequest: (id) => removeSessionTile(id),
		onGeometryCommit: () => scheduleSave(),
		onCameraSettle: (camera) => saveCamera(window.localStorage, api.getBaseUrl(), camera),
		onEscape: (id, event) => entries.get(id)?.pane.handleEscape(event),
	});

	/** A composer that can't take input yet (dormant tile, session still loading) gets focus once it can. @param {string} id */
	function focusComposer(id) {
		const entry = entries.get(id);
		if (!entry) return;
		entry.focusWhenReady = entry.pane.refs.input.disabled;
		entry.pane.focusComposer();
	}

	/** @param {string} message */
	function notice(message) {
		const focused = canvas.tiles.focusedId();
		const entry = focused ? entries.get(focused) : entries.values().next().value;
		if (entry) entry.pane.appendNotice(message, "error");
		else console.error(message);
	}

	function scheduleSave() {
		window.clearTimeout(saveTimer);
		saveTimer = window.setTimeout(() => void saveLayout(), SAVE_DEBOUNCE_MS);
	}

	function flushPendingSave() {
		if (!saveTimer) return;
		void saveLayout();
	}

	async function saveLayout() {
		window.clearTimeout(saveTimer);
		saveTimer = 0;
		const tiles = [...entries.values()].flatMap((entry) => {
			const tile = canvas.tiles.get(entry.id);
			return tile ? [{ sessionId: entry.id, path: entry.path, title: entry.title, ...tile.rect }] : [];
		});
		await layoutStore.save({ tiles });
	}

	/** @param {TileEntry} entry */
	function pillFor(entry) {
		if (entry.dormant) return { text: "not running", kind: "idle" };
		const connection = entry.pane.getConnection();
		if (connection === "gone") return { text: "ended", kind: "offline" };
		if (connection === "reconnecting") return { text: "reconnecting", kind: "offline" };
		const status = entry.pane.getRunStatus();
		if (status.kind !== "idle") return { text: status.kind, kind: "working" };
		return { text: entry.pane.isController() ? "idle" : "viewing", kind: "idle" };
	}

	/** @param {string} id */
	function renderTileChrome(id) {
		const entry = entries.get(id);
		const tile = canvas.tiles.get(id);
		if (!entry || !tile) return;
		if (entry.focusWhenReady && !entry.pane.refs.input.disabled) {
			entry.focusWhenReady = false;
			if (canvas.tiles.focusedId() === id) entry.pane.focusComposer();
		}
		const state = entry.pane.getState();
		if (state?.sessionName) entry.title = sessionTitle({ id, cwd: state.cwd, name: state.sessionName });
		if (entry.shown.title !== entry.title) {
			entry.shown.title = entry.title;
			tile.titleEl.textContent = entry.title;
			tile.titleEl.title = entry.title;
		}
		const pill = pillFor(entry);
		const pillKey = `${pill.kind}:${pill.text}`;
		if (entry.shown.pill !== pillKey) {
			entry.shown.pill = pillKey;
			entry.pill.textContent = pill.text;
			entry.pill.className = `cv-pill is-${pill.kind}`;
			tile.el.classList.toggle("cv-working", pill.kind === "working");
		}
		tile.el.classList.toggle("cv-waiting", !entry.dormant && entry.pane.extensionUi.isOpen());
	}

	/** @param {HTMLElement} anchor @param {TileEntry} entry */
	function openTileActions(anchor, entry) {
		const { pane } = entry;
		pane.openMenu(anchor, (panel) => {
			const body = h("div", "menu-body");
			const list = h("div", "menu-list");
			/** @param {string} primary @param {string} secondary @param {() => void} action */
			const item = (primary, secondary, action) => {
				const row = h("div", "menu-item");
				row.append(h("div", "primary", primary), h("div", "secondary", secondary));
				row.addEventListener("click", () => {
					pane.closeMenu();
					action();
				});
				list.append(row);
			};
			if (entry.dormant) item("Resume", "attach this session so it can run here", () => wake(entry.id));
			else if (pane.isController()) item("Release", "hand the session back to the native cli", pane.release);
			else item("Take over", "control this session from this browser", pane.takeOver);
			if (!entry.dormant && pane.getRunStatus().kind !== "idle") item("Abort run", "same as esc", pane.abort);
			item("Remove from canvas", "the session keeps running", () => removeSessionTile(entry.id));
			body.append(list);
			panel.append(body);
		});
	}

	/**
	 * @param {{ id: string, path: string | null, title: string, rect: import("./canvas/camera.js").Rect, running: boolean }} spec
	 */
	function addSessionTile({ id, path, title, rect, running }) {
		if (entries.has(id)) return entries.get(id);
		const tile = canvas.tiles.addTile({ id, rect, title });
		const { el, refs } = buildPaneDom(document);
		tile.body.append(el);

		const pill = h("span", "cv-pill");
		tile.statusEl.append(pill);
		const combo = h("span", "cv-combo");
		const btnModel = h("button", "cv-ctl cv-ctl-model");
		btnModel.type = "button";
		btnModel.title = "Model";
		const lblModel = h("span", "sel", "—");
		btnModel.append(lblModel);
		const btnThinking = h("button", "cv-ctl cv-ctl-thinking");
		btnThinking.type = "button";
		btnThinking.title = "Thinking level";
		const lblThinking = h("span", "sel", "—");
		btnThinking.append(lblThinking);
		combo.append(btnModel, btnThinking);
		const more = h("button", "cv-ctl cv-ctl-more", "⋯");
		more.type = "button";
		more.title = "Take over, release, abort";
		tile.controlsEl.append(combo, more);

		const pane = createSessionPane({
			refs: { ...refs, btnModel, btnThinking, lblModel, lblThinking },
			api,
			getClientId: () => clients.current(),
			refreshClient: () => clients.refresh(),
			menuDom,
			getHost: () => ({ hostLabel: activeHost?.label ?? null, baseUrl: api.getBaseUrl() }),
			onStateChange: () => renderTileChrome(id),
		});
		/** @type {TileEntry} */
		const entry = { id, path, title, pane, pill, dormant: !running, focusWhenReady: false, shown: { title: "", pill: "" } };
		entries.set(id, entry);
		more.addEventListener("click", () => openTileActions(more, entry));
		pane.render();
		if (running) pane.openSessionId(id);
		else pane.appendNotice("Not running. Click this tile to resume it here.");
		renderTileChrome(id);
		return entry;
	}

	/** @param {string} id */
	function wake(id) {
		const entry = entries.get(id);
		if (!entry || !entry.dormant) return;
		if (!entry.path) {
			entry.pane.appendNotice("This session has no file to resume from.", "error");
			return;
		}
		entry.dormant = false;
		renderTileChrome(id);
		void entry.pane.selectSession({ id, path: entry.path, isRunning: false }).catch((/** @type {unknown} */ error) => {
			entry.dormant = true;
			entry.pane.appendNotice(`Couldn't resume: ${error instanceof Error ? error.message : String(error)}`, "error");
			renderTileChrome(id);
		});
	}

	/** @param {string} id */
	function removeSessionTile(id) {
		const entry = entries.get(id);
		if (!entry) return;
		entries.delete(id);
		entry.pane.destroy();
		canvas.tiles.removeTile(id);
		scheduleSave();
	}

	function clearTiles() {
		for (const id of [...entries.keys()]) {
			entries.get(id)?.pane.destroy();
			entries.delete(id);
			canvas.tiles.removeTile(id);
		}
	}

	/** @returns {Promise<any[]>} */
	async function runningSessions() {
		const data = await api.getJson("/api/active-sessions");
		return Array.isArray(data?.sessions) ? data.sessions : [];
	}

	/** Puts every running session that isn't on the canvas yet on it (the launcher replaces this, m-f54c). */
	async function addRunningSessions({ reveal = false } = {}) {
		let sessions;
		try {
			sessions = await runningSessions();
		} catch (error) {
			notice(`Couldn't list running sessions: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const fresh = sessions.filter((session) => typeof session?.id === "string" && !entries.has(session.id));
		let last = null;
		for (const session of fresh) {
			last = addSessionTile({ id: session.id, path: session.path ?? null, title: sessionTitle(session), rect: nextFreeSlot(canvas.tiles.rects()), running: true });
		}
		if (fresh.length > 0) scheduleSave();
		if (reveal && last) {
			canvas.tiles.focusTile(last.id);
			canvas.revealTile(last.id);
		} else if (reveal && fresh.length === 0) {
			notice("Every running session is already on the canvas.");
		}
	}

	async function loadCanvas() {
		const [layout, running] = await Promise.all([layoutStore.load(), runningSessions().catch(() => [])]);
		const runningIds = new Set(running.map((session) => session.id));
		for (const tile of layout.tiles) {
			addSessionTile({ id: tile.sessionId, path: tile.path, title: tile.title ?? tile.sessionId.slice(0, 8), rect: tile, running: runningIds.has(tile.sessionId) });
		}
		if (layout.tiles.length === 0) await addRunningSessions();
	}

	/** @param {any} host */
	async function switchHost(host) {
		const origin = hostOrigin(host);
		if (origin === api.getBaseUrl()) return;
		await saveLayout();
		clearTiles();
		api.setBaseUrl(origin);
		activeHost = { ...host, url: origin };
		layoutStore = createLocalLayoutStore(window.localStorage, origin);
		renderHostButton();
		try {
			await clients.ensure();
			canvas.viewport.setCamera(loadCamera(window.localStorage, origin) ?? DEFAULT_CAMERA);
			await loadCanvas();
		} catch (error) {
			console.error("host switch failed", error);
		}
	}

	const hostButton = h("button", "cv-hud-btn cv-hud-host");
	hostButton.type = "button";
	hostButton.title = "Host";
	canvas.hud.slot.append(hostButton);
	function renderHostButton() {
		hostButton.textContent = activeHost?.label || hostOrigin(activeHost);
		hostButton.disabled = hosts.length < 2;
	}
	const shellMenu = createMenu({
		...menuDom,
		btnModel: null,
		btnThinking: null,
		api,
		getClientId: () => clients.current(),
		onNotice: notice,
		getActiveSessionId: () => null,
		getActiveState: () => null,
	});
	hostButton.addEventListener("click", () => {
		shellMenu.openCustom(hostButton, (panel) => {
			const list = h("div", "menu-list");
			for (const host of hosts) {
				const row = h("div", `menu-item${hostOrigin(host) === api.getBaseUrl() ? " active" : ""}`);
				row.append(h("div", "primary", host.label || host.id || host.url), h("div", "secondary", hostOrigin(host)));
				row.addEventListener("click", () => {
					shellMenu.close();
					void switchHost(host);
				});
				list.append(row);
			}
			const body = h("div", "menu-body");
			body.append(list);
			panel.append(body);
		});
	});

	function resumeAll() {
		for (const entry of entries.values()) if (!entry.dormant) entry.pane.resumeIfStale();
	}
	window.addEventListener("pageshow", resumeAll);
	window.addEventListener("focus", resumeAll);
	window.addEventListener("online", resumeAll);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") resumeAll();
	});
	window.addEventListener("pagehide", flushPendingSave);

	if (new URL(window.location.href).searchParams.get("fps") === "1") createFpsMeter(root);

	try {
		await clients.ensure();
	} catch (error) {
		root.append(h("div", "cv-fatal", error instanceof Error ? error.message : String(error)));
		throw error;
	}
	const faceIdGuard = isLoopbackBrowserHost(window.location.hostname) ? null : installFaceIdGuard({ api });
	if (faceIdGuard) await faceIdGuard.start();
	hosts = await loadHostList(api, activeHost);
	renderHostButton();
	await loadCanvas();
	Object.assign(window, { __canvas: { canvas, entries } });
}
