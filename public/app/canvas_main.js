// The laptop canvas shell (?ui=canvas): Infinite in the browser. No sidebar: every tile is a session
// pane, and the HUD holds zoom, new tile and the host switcher. One tile per session; the red dot only
// takes a tile off the canvas (the session keeps running, release stays explicit in the ⋯ menu).
// Tiles of sessions that aren't running stay dormant (no runtime attached) until you click them.
import { createApi } from "./core/api.js";
import { installFaceIdGuard } from "./core/faceid.js";
import { createClientSessions, hostOrigin, isLoopbackBrowserHost, loadHostList, pageHost } from "./core/hosts.js";
import { createCanvas } from "./canvas/canvas.js";
import { createFpsMeter } from "./canvas/fps_meter.js";
import { createLauncher } from "./canvas/launcher.js";
import { nextFreeSlot, rectCenteredAt } from "./canvas/layout.js";
import { createLayoutStore, loadCamera, saveCamera } from "./canvas/layout_store.js";
import { buildPaneDom } from "./session/pane_dom.js";
import { createSessionPane } from "./session/pane.js";
import { createMenu } from "./ui/menu.js";

/** Boots the canvas shell (?ui=canvas, remembered; never on phones). */
export async function bootCanvas() {
	const SAVE_DEBOUNCE_MS = 400;
	const DEFAULT_CAMERA = { x: 48, y: 64, scale: 0.6 };
	const knobs = new URL(window.location.href).searchParams;
	/** @param {string} name @param {number} fallback */
	const intKnob = (name, fallback) => {
		const value = Number.parseInt(knobs.get(name) ?? "", 10);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	};
	// offscreen tiles: drop the stream after SUSPEND_GRACE_MS, unmount the dom after UNMOUNT_AFTER_MS
	// beyond the KEEP_MOUNTED_OFFSCREEN most recently seen (?suspendMs= / ?unmountMs= for tests)
	const SUSPEND_GRACE_MS = intKnob("suspendMs", 8_000);
	const UNMOUNT_AFTER_MS = intKnob("unmountMs", 90_000);
	const KEEP_MOUNTED_OFFSCREEN = intKnob("keepMounted", 8);
	// transcript entries a tile keeps: the newest 20 (50 while focused, plus older pages you scroll to)
	const TRANSCRIPT_WINDOW = { unfocused: intKnob("window", 20), focused: intKnob("focusedWindow", 50), pageSize: 50 };
	const DORMANT_NOTICE = "Not running. Click this tile to resume it here.";
	// on-screen tiles whose session is idle (per the host's status stream) let go of their stream after
	// IDLE_SUSPEND_MS unless focused, so the host can evict them; work or a dialog brings the stream back
	const IDLE_SUSPEND_MS = intKnob("idleSuspendMs", 30_000);
	const IDLE_CHECK_MS = Math.min(2_000, Math.max(100, Math.floor(IDLE_SUSPEND_MS / 3)));
	const SWEEP_MS = Math.min(15_000, Math.max(250, UNMOUNT_AFTER_MS / 2));

	/**
	 * @typedef {{
	 *   id: string,
	 *   path: string | null,
	 *   title: string,
	 *   pane: ReturnType<typeof createSessionPane>,
	 *   controls: { btnModel: HTMLButtonElement, btnThinking: HTMLButtonElement, lblModel: HTMLElement, lblThinking: HTMLElement },
	 *   pill: HTMLElement,
	 *   dormant: boolean,
	 *   focusWhenReady: boolean,
	 *   mounted: boolean,
	 *   opened: boolean,
	 *   visible: boolean,
	 *   suspendTimer: number,
	 *   hiddenAt: number,
	 *   lastVisibleAt: number,
	 *   extTitle: string | null,
	 *   readOnly: "none" | "loading" | "shown",
	 *   status: { id: string, working: boolean, waiting: boolean, viewers: number } | null,
	 *   idleSuspended: boolean,
	 *   idleSince: number,
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
	let layoutStore = createLayoutStore(api, window.localStorage);
	/** @type {Map<string, TileEntry>} */
	const entries = new Map();
	let saveTimer = 0;
	let layoutLoaded = false;

	const canvas = createCanvas({
		root,
		camera: loadCamera(window.localStorage, api.getBaseUrl()) ?? DEFAULT_CAMERA,
		onNewTile: () => openLauncher(nextFreeSlot(canvas.tiles.rects()), { reveal: true }),
		onEmptyDoubleClick: (point) => openLauncher(rectCenteredAt(point)),
		onFocusChange: (id) => onFocusChange(id),
		focusComposer: (id) => {
			const launcher = launchers.get(id);
			if (launcher) launcher.focus();
			else focusComposer(id);
		},
		onActivate: (id) => wake(id),
		onCloseRequest: (id) => {
			if (launchers.has(id)) closeLauncher(id);
			else removeSessionTile(id);
		},
		onGeometryCommit: () => scheduleSave(),
		onCameraSettle: (camera) => saveCamera(window.localStorage, api.getBaseUrl(), camera),
		onVisibilityChange: (id, visible) => onTileVisibility(id, visible),
		onEscape: (id, event) => {
			// the host menu first: esc must never reach a tile's abort while a menu is open over it
			if (shellMenu.isOpen()) {
				event.preventDefault();
				shellMenu.close();
				return;
			}
			if (!id) return;
			const launcher = launchers.get(id);
			if (launcher) launcher.handleEscape(event);
			else entries.get(id)?.pane.handleEscape(event);
		},
	});

	/** @type {string | null} */
	let focusedTileId = null;
	/** @param {string | null} id */
	function onFocusChange(id) {
		const previous = focusedTileId ? entries.get(focusedTileId) : null;
		if (previous?.mounted) previous.pane.setFocused(false);
		focusedTileId = id;
		const next = id ? entries.get(id) : null;
		if (next?.mounted) next.pane.setFocused(true);
		if (next) wakeFromIdle(next);
	}

	/** @param {TileEntry} entry */
	function wakeFromIdle(entry) {
		entry.idleSince = 0;
		if (!entry.idleSuspended) return;
		entry.idleSuspended = false;
		if (entry.mounted && entry.opened && entry.visible) entry.pane.resume();
		renderTileChrome(entry.id);
	}

	/** @type {Map<string, { id: string, path: string | null, working: boolean, waiting: boolean, viewers: number }>} */
	let statusById = new Map();
	let statusKnown = false;
	/** @type {EventSource | null} */
	let statusSource = null;

	/**
	 * The host's status stream (GET /api/canvas/status): which sessions run, work or wait on a dialog.
	 * Hosts without it keep every on-screen tile connected, as before.
	 */
	function connectStatus() {
		statusSource?.close();
		statusKnown = false;
		statusById = new Map();
		const source = api.eventSource("/api/canvas/status");
		statusSource = source;
		source.onmessage = (message) => {
			if (source !== statusSource) return;
			let event;
			try {
				event = JSON.parse(message.data);
			} catch {
				return;
			}
			if (event?.type !== "canvas_status" || !Array.isArray(event.sessions)) return;
			statusById = new Map(event.sessions.filter((/** @type {any} */ status) => typeof status?.id === "string").map((/** @type {any} */ status) => [status.id, status]));
			statusKnown = true;
			for (const entry of entries.values()) reconcileStatus(entry);
		};
		source.onerror = () => {
			if (source !== statusSource || source.readyState !== EventSource.CLOSED) return;
			// an older host (404) or a lost one: tiles keep their own streams
			statusKnown = false;
			for (const entry of entries.values()) wakeFromIdle(entry);
		};
	}

	/** @param {TileEntry} entry */
	function reconcileStatus(entry) {
		const status = statusById.get(entry.id) ?? null;
		entry.status = status;
		if (!status) {
			// stopped running while this tile wasn't listening (evicted, released): back to dormant
			if (!entry.dormant && entry.mounted && entry.opened && entry.pane.getConnection() === "suspended") {
				entry.dormant = true;
				entry.opened = false;
				entry.idleSuspended = false;
				entry.pane.appendNotice(DORMANT_NOTICE);
			}
		} else if (entry.dormant) {
			// running again (resumed from another device): go live
			entry.dormant = false;
			entry.opened = false;
			openIfReady(entry);
		} else if (entry.idleSuspended && (status.working || status.waiting)) {
			wakeFromIdle(entry);
		}
		renderTileChrome(entry.id);
	}

	/** Lets on-screen tiles of idle sessions drop their stream (the focused one keeps it). */
	function suspendIdleTiles() {
		if (!statusKnown || IDLE_SUSPEND_MS <= 0) return;
		const now = Date.now();
		for (const entry of entries.values()) {
			if (!entry.mounted || !entry.opened || entry.dormant || !entry.visible || entry.idleSuspended) continue;
			const status = statusById.get(entry.id);
			const busy =
				entry.id === focusedTileId ||
				!status ||
				status.working ||
				status.waiting ||
				entry.pane.getConnection() !== "live" ||
				entry.pane.getRunStatus().kind !== "idle" ||
				entry.pane.extensionUi.isOpen();
			if (busy) {
				entry.idleSince = 0;
			} else if (!entry.idleSince) {
				entry.idleSince = now;
			} else if (now - entry.idleSince >= IDLE_SUSPEND_MS) {
				entry.idleSuspended = true;
				entry.idleSince = 0;
				entry.pane.suspend();
				renderTileChrome(entry.id);
			}
		}
	}

	/** @type {Map<string, ReturnType<typeof createLauncher>>} */
	const launchers = new Map();
	let launcherSeq = 0;

	/**
	 * A new tile starts as a launcher; picking a session turns it into that session's tile in place.
	 * @param {import("./canvas/camera.js").Rect} rect @param {{ reveal?: boolean }} [options]
	 */
	function openLauncher(rect, { reveal = false } = {}) {
		launcherSeq += 1;
		const id = `launcher-${launcherSeq}`;
		const tile = canvas.tiles.addTile({ id, rect, title: "new tile" });
		tile.el.classList.add("cv-launcher");
		const launcher = createLauncher({
			doc: document,
			api,
			getClientId: () => clients.current(),
			isOnCanvas: (sessionId) => entries.has(sessionId),
			onPick: (pick) => onLauncherPick(id, pick),
			onClose: () => closeLauncher(id),
			onTitle: (title) => {
				tile.titleEl.textContent = title;
			},
		});
		tile.body.replaceChildren(launcher.el);
		launchers.set(id, launcher);
		canvas.tiles.focusTile(id);
		if (reveal) canvas.revealTile(id);
		launcher.focus();
		return id;
	}

	/** @param {string} id */
	function closeLauncher(id) {
		const launcher = launchers.get(id);
		if (!launcher) return;
		launchers.delete(id);
		launcher.destroy();
		canvas.tiles.removeTile(id);
	}

	/** @param {string} launcherId @param {import("./canvas/launcher.js").LauncherPick} pick */
	function onLauncherPick(launcherId, pick) {
		const rect = canvas.tiles.get(launcherId)?.rect;
		if (!rect) return;
		const sessionId = pick.kind === "created" ? pick.sessionId : pick.session.id;
		closeLauncher(launcherId);
		if (entries.has(sessionId)) {
			// one tile per session: fly to the one that's already here
			canvas.tiles.focusTile(sessionId);
			canvas.revealTile(sessionId);
			focusComposer(sessionId);
			return;
		}
		const running = pick.kind === "created" || Boolean(pick.session.isRunning);
		const title = pick.kind === "created" ? sessionTitle({ id: sessionId, cwd: pick.cwd }) : sessionTitle(pick.session);
		const path = pick.kind === "created" ? null : pick.session.path;
		addSessionTile({ id: sessionId, path, title, rect, running });
		scheduleSave();
		canvas.tiles.focusTile(sessionId);
		if (!running) wake(sessionId);
		focusComposer(sessionId);
	}

	/** A composer that can't take input yet (dormant tile, session still loading) gets focus once it can. @param {string} id */
	function focusComposer(id) {
		const entry = entries.get(id);
		if (!entry) return;
		if (!entry.mounted) mountPane(entry);
		// a tile waiting on an extension dialog: the keyboard goes to the dialog, not the composer under it
		const dialog = entry.pane.extensionUi.isOpen() ? canvas.tiles.get(id)?.body.querySelector(".ext-dialog-overlay :is(input, textarea, button)") : null;
		if (dialog instanceof HTMLElement) {
			dialog.focus({ preventScroll: true });
			return;
		}
		entry.focusWhenReady = entry.pane.refs.input.disabled;
		entry.pane.focusComposer();
	}

	/** @param {string} message */
	function notice(message) {
		const focused = canvas.tiles.focusedId();
		const entry = focused ? entries.get(focused) : [...entries.values()].find((candidate) => candidate.mounted);
		if (entry?.mounted) entry.pane.appendNotice(message, "error");
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
		// never overwrite a map we failed to read
		if (!layoutLoaded) return;
		const tiles = [...entries.values()].flatMap((entry) => {
			const tile = canvas.tiles.get(entry.id);
			return tile ? [{ sessionId: entry.id, path: entry.path, title: entry.title, ...tile.rect }] : [];
		});
		try {
			await layoutStore.save({ tiles });
		} catch (error) {
			console.warn("canvas layout not saved", error);
		}
	}

	/** @param {TileEntry} entry */
	function pillFor(entry) {
		if (entry.dormant) return { text: "not running", kind: "idle" };
		if (!entry.mounted || !entry.opened) return { text: "offscreen", kind: "idle" };
		const connection = entry.pane.getConnection();
		if (connection === "suspended" && entry.idleSuspended) {
			if (entry.status?.waiting) return { text: "waiting", kind: "waiting" };
			return entry.status?.working ? { text: "working", kind: "working" } : { text: "idle", kind: "idle" };
		}
		if (connection === "suspended") return { text: "offscreen", kind: "idle" };
		if (connection === "gone") return { text: "ended", kind: "offline" };
		if (connection === "reconnecting") return { text: "reconnecting", kind: "offline" };
		if (entry.pane.extensionUi.isOpen()) return { text: "waiting", kind: "waiting" };
		const status = entry.pane.getRunStatus();
		if (status.kind !== "idle") return { text: status.kind, kind: "working" };
		return { text: entry.pane.isController() ? "idle" : "viewing", kind: "idle" };
	}

	/** Learns the session file from the pane, and turns an ended session back into a dormant tile. @param {TileEntry} entry */
	function syncFromPane(entry) {
		const state = entry.pane.getState();
		if (state?.sessionFile && entry.path !== state.sessionFile) {
			entry.path = state.sessionFile;
			scheduleSave();
		}
		if (!entry.dormant && entry.pane.getConnection() === "gone") {
			entry.dormant = true;
			entry.opened = false;
		}
	}

	/** @param {string} id */
	function renderTileChrome(id) {
		const entry = entries.get(id);
		const tile = canvas.tiles.get(id);
		if (!entry || !tile) return;
		if (entry.mounted) syncFromPane(entry);
		if (entry.mounted && entry.focusWhenReady && !entry.pane.refs.input.disabled) {
			entry.focusWhenReady = false;
			if (canvas.tiles.focusedId() === id) entry.pane.focusComposer();
		}
		const state = entry.mounted ? entry.pane.getState() : null;
		if (state?.sessionName) entry.title = sessionTitle({ id, cwd: state.cwd, name: state.sessionName });
		// an extension's title (ctx.ui.setTitle) names the tile while it's set, the way it names the phone's page
		const title = entry.extTitle || entry.title;
		if (entry.shown.title !== title) {
			entry.shown.title = title;
			tile.titleEl.textContent = title;
			tile.titleEl.title = title;
		}
		const pill = pillFor(entry);
		const pillKey = `${pill.kind}:${pill.text}`;
		if (entry.shown.pill !== pillKey) {
			entry.shown.pill = pillKey;
			entry.pill.textContent = pill.text;
			entry.pill.className = `cv-pill is-${pill.kind}`;
			tile.el.classList.toggle("cv-working", pill.kind === "working");
		}
		tile.el.classList.toggle("cv-waiting", entry.mounted && !entry.dormant && entry.pane.extensionUi.isOpen());
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

	/** @param {string} text */
	function placeholder(text) {
		const el = h("div", "cv-placeholder", text);
		return el;
	}

	/**
	 * Builds the pane inside the tile body. The title-bar controls outlive it, so a tile can be
	 * unmounted while offscreen and mounted again when it comes back.
	 * @param {TileEntry} entry
	 */
	function mountPane(entry) {
		const tile = canvas.tiles.get(entry.id);
		if (!tile || entry.mounted) return;
		const { el, refs } = buildPaneDom(document);
		tile.body.replaceChildren(el);
		entry.pane = createSessionPane({
			refs: { ...refs, ...entry.controls },
			api,
			getClientId: () => clients.current(),
			refreshClient: () => clients.refresh(),
			menuDom,
			getHost: () => ({ hostLabel: activeHost?.label ?? null, baseUrl: api.getBaseUrl() }),
			onStateChange: () => renderTileChrome(entry.id),
			transcriptWindow: TRANSCRIPT_WINDOW,
			tileUi: {
				dialogHost: el,
				hasKeyboard: () => canvas.tiles.focusedId() === entry.id,
				onTitle: (title) => {
					entry.extTitle = title;
					renderTileChrome(entry.id);
				},
			},
		});
		entry.mounted = true;
		entry.opened = false;
		entry.readOnly = "none";
		if (focusedTileId === entry.id) entry.pane.setFocused(true);
		entry.pane.render();
		if (entry.dormant) {
			entry.pane.appendNotice(DORMANT_NOTICE);
			showDormantTail(entry);
		}
	}

	/**
	 * A dormant tile on screen shows the tail of its session file (no runtime attached on the host); hosts
	 * without GET /api/session-transcript leave the notice alone.
	 * @param {TileEntry} entry
	 */
	function showDormantTail(entry) {
		if (!entry.dormant || !entry.mounted || !entry.visible || !entry.path || entry.readOnly !== "none") return;
		entry.readOnly = "loading";
		const pane = entry.pane;
		const query = new URLSearchParams({ path: entry.path, limit: String(TRANSCRIPT_WINDOW.unfocused || 20) });
		api.getJson(`/api/session-transcript?${query.toString()}`).then(
			(/** @type {any} */ page) => {
				if (entry.pane !== pane || !entry.dormant || !entry.mounted) return;
				entry.readOnly = "shown";
				pane.showReadOnly(page, DORMANT_NOTICE);
			},
			() => {
				if (entry.pane === pane) entry.readOnly = "shown";
			},
		);
	}

	/** @param {TileEntry} entry */
	function unmountPane(entry) {
		const tile = canvas.tiles.get(entry.id);
		if (!tile || !entry.mounted) return;
		entry.pane.destroy();
		entry.mounted = false;
		entry.opened = false;
		tile.body.replaceChildren(placeholder(entry.title));
		renderTileChrome(entry.id);
	}

	/** Running sessions open their stream once their tile is on screen, not before. @param {TileEntry} entry */
	function openIfReady(entry) {
		if (entry.dormant || !entry.mounted || entry.opened || !entry.visible) return;
		entry.opened = true;
		entry.pane.openSessionId(entry.id);
	}

	/**
	 * Offscreen tiles drop their stream after a grace period (so idle sessions become evictable on
	 * the server) and pick up from their cursor when they come back.
	 * @param {string} id @param {boolean} visible
	 */
	function onTileVisibility(id, visible) {
		const entry = entries.get(id);
		if (!entry || entry.visible === visible) return;
		entry.visible = visible;
		window.clearTimeout(entry.suspendTimer);
		entry.suspendTimer = 0;
		if (visible) {
			entry.lastVisibleAt = Date.now();
			if (!entry.mounted) mountPane(entry);
			if (entry.opened && !entry.idleSuspended) entry.pane.resume();
			else if (!entry.opened) openIfReady(entry);
			showDormantTail(entry);
			renderTileChrome(id);
			return;
		}
		entry.hiddenAt = Date.now();
		entry.suspendTimer = window.setTimeout(() => {
			entry.suspendTimer = 0;
			if (!entry.visible && entry.mounted) entry.pane.suspend();
			renderTileChrome(id);
		}, SUSPEND_GRACE_MS);
	}

	/** Unmounts tiles that have been offscreen for a while, keeping the most recently seen ones. */
	function sweepOffscreen() {
		const now = Date.now();
		const focused = canvas.tiles.focusedId();
		const stale = [...entries.values()]
			.filter((entry) => entry.mounted && !entry.visible && entry.id !== focused && now - entry.hiddenAt >= UNMOUNT_AFTER_MS)
			.sort((a, b) => b.lastVisibleAt - a.lastVisibleAt);
		const mountedOffscreen = [...entries.values()].filter((entry) => entry.mounted && !entry.visible).length;
		const excess = Math.max(0, mountedOffscreen - KEEP_MOUNTED_OFFSCREEN);
		for (const entry of stale.slice(Math.max(0, stale.length - excess))) unmountPane(entry);
	}

	/**
	 * @param {{ id: string, path: string | null, title: string, rect: import("./canvas/camera.js").Rect, running: boolean }} spec
	 */
	function addSessionTile({ id, path, title, rect, running }) {
		const existing = entries.get(id);
		if (existing) return existing;
		const tile = canvas.tiles.addTile({ id, rect, title });
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

		/** @type {TileEntry} */
		const entry = {
			id,
			path,
			title,
			pane: /** @type {any} */ (null),
			controls: { btnModel, btnThinking, lblModel, lblThinking },
			pill,
			dormant: !running,
			focusWhenReady: false,
			mounted: false,
			opened: false,
			visible: tile.visible,
			suspendTimer: 0,
			hiddenAt: tile.visible ? 0 : Date.now(),
			lastVisibleAt: tile.visible ? Date.now() : 0,
			extTitle: null,
			readOnly: "none",
			status: null,
			idleSuspended: false,
			idleSince: 0,
			shown: { title: "", pill: "" },
		};
		entries.set(id, entry);
		more.addEventListener("click", () => {
			if (!entry.mounted) mountPane(entry);
			openTileActions(more, entry);
		});
		mountPane(entry);
		openIfReady(entry);
		renderTileChrome(id);
		return entry;
	}

	/** @param {string} id */
	function wake(id) {
		const entry = entries.get(id);
		if (!entry || !entry.dormant) return;
		if (!entry.mounted) mountPane(entry);
		if (!entry.path) {
			entry.pane.appendNotice("This session has no file to resume from.", "error");
			return;
		}
		entry.dormant = false;
		entry.opened = true;
		renderTileChrome(id);
		void entry.pane.selectSession({ id, path: entry.path, isRunning: false }).catch((/** @type {unknown} */ error) => {
			entry.dormant = true;
			entry.opened = false;
			entry.pane.appendNotice(`Couldn't resume: ${error instanceof Error ? error.message : String(error)}`, "error");
			renderTileChrome(id);
		});
	}

	/** @param {string} id */
	function removeSessionTile(id) {
		const entry = entries.get(id);
		if (!entry) return;
		entries.delete(id);
		window.clearTimeout(entry.suspendTimer);
		if (entry.mounted) entry.pane.destroy();
		canvas.tiles.removeTile(id);
		scheduleSave();
	}

	function clearTiles() {
		for (const id of [...launchers.keys()]) closeLauncher(id);
		for (const id of [...entries.keys()]) {
			const entry = entries.get(id);
			entries.delete(id);
			if (!entry) continue;
			window.clearTimeout(entry.suspendTimer);
			if (entry.mounted) entry.pane.destroy();
			canvas.tiles.removeTile(id);
		}
	}

	/** @returns {Promise<any[]>} */
	async function runningSessions() {
		const data = await api.getJson("/api/active-sessions");
		return Array.isArray(data?.sessions) ? data.sessions : [];
	}

	/** Puts every running session that isn't on the canvas yet on it (a first visit to a host's empty map). */
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
		layoutLoaded = false;
		const [layout, running] = await Promise.all([
			layoutStore.load().then(
				(loaded) => {
					layoutLoaded = true;
					return loaded;
				},
				(error) => {
					notice(`Couldn't load this host's canvas layout: ${error instanceof Error ? error.message : String(error)}`);
					return { tiles: [] };
				},
			),
			runningSessions().catch(() => []),
		]);
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
		statusSource?.close();
		statusSource = null;
		statusKnown = false;
		api.setBaseUrl(origin);
		activeHost = { ...host, url: origin };
		layoutStore = createLayoutStore(api, window.localStorage);
		renderHostButton();
		try {
			await clients.ensure();
			canvas.viewport.setCamera(loadCamera(window.localStorage, origin) ?? DEFAULT_CAMERA);
			await loadCanvas();
			connectStatus();
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
		for (const entry of entries.values()) if (entry.mounted && entry.opened && !entry.dormant) entry.pane.resumeIfStale();
	}
	window.setInterval(sweepOffscreen, SWEEP_MS);
	window.setInterval(suspendIdleTiles, IDLE_CHECK_MS);
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
	connectStatus();
	Object.assign(window, { __canvas: { canvas, entries, launchers, openLauncher, clientId: () => clients.current(), status: () => statusById } });
}
