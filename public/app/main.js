// The phone shell: header, sidebar and one session pane on the static markup in index.html.
import { createApi } from "./core/api.js";
import { isPhoneLike } from "./core/device.js";
import { installFaceIdGuard } from "./core/faceid.js";
import { createClientSessions, hostOrigin, isLoopbackBrowserHost, loadHostList, pageHost } from "./core/hosts.js";
import { findSession } from "./session/find_session.js";
import { createSessionPane } from "./session/pane.js";
import { createLauncherSheet } from "./ui/launcher_sheet.js";
import { createSidebar } from "./ui/sidebar.js";

/** Boots the phone shell; app.js picks it unless the canvas was asked for. */
export async function bootPhone() {
	const sessionsList = document.getElementById("sessions-list");
	const msgs = document.getElementById("msgs");

	const sidebarLabel = document.getElementById("sidebar-label");
	const btnSidebarLeft = document.getElementById("btn-sidebar-left");
	const btnSidebarRight = document.getElementById("btn-sidebar-right");

	const menuDom = {
		menuOverlay: document.getElementById("menu-overlay"),
		menuScrim: document.getElementById("menu-scrim"),
		menuPanel: document.getElementById("menu-panel"),
	};

	const sidebar = document.querySelector(".sidebar");
	const sidebarOverlay = document.getElementById("sidebar-overlay");

	const kbMenu = document.getElementById("kb-menu");

	/** @type {import("./session/pane.js").PaneRefs} */
	const paneRefs = {
		msgs,
		jumpLatest: document.getElementById("jump-latest"),
		queuedPanel: document.getElementById("queued-panel"),
		input: document.getElementById("inp"),
		editor: document.getElementById("editor-wrap"),
		readOnlyNote: document.getElementById("read-only-note"),
		working: document.getElementById("working"),
		workingSpin: document.getElementById("work-spin"),
		workingText: document.querySelector(".work-text"),
		footerLine1: document.getElementById("footer-line-1"),
		footerLeft2: document.getElementById("footer-left-2"),
		footerRight2: document.getElementById("footer-right-2"),
		footerExtStatus: document.getElementById("footer-ext-status"),
		extAbove: document.getElementById("ext-widgets-above"),
		extBelow: document.getElementById("ext-widgets-below"),
		rolePill: document.getElementById("role-pill"),
		lineage: document.getElementById("lineage-line"),
		btnModel: document.getElementById("btn-model"),
		btnThinking: document.getElementById("btn-thinking"),
		lblModel: document.getElementById("lbl-model"),
		lblThinking: document.getElementById("lbl-thinking"),
		btnTakeover: document.getElementById("btn-takeover"),
		btnAbort: document.getElementById("btn-abort"),
		btnRelease: document.getElementById("btn-release"),
		kbEsc: document.getElementById("kb-esc"),
		kbTakeover: document.getElementById("kb-takeover"),
		kbRelease: document.getElementById("kb-release"),
		kbEnter: document.getElementById("kb-enter"),
	};

	const replayName = new URL(window.location.href).searchParams.get("replay")?.trim() || null;
	const api = createApi({ baseUrl: window.location.origin });
	let activeHost = pageHost();
	let hosts = [];
	const clients = createClientSessions(api);
	let clientId = null;

	function showFatalError(error) {
		msgs.innerHTML = "";
		const block = document.createElement("div");
		block.className = "assistant-block";
		const notice = document.createElement("div");
		notice.className = "notice-text error";
		notice.textContent = error instanceof Error ? error.message : String(error);
		block.appendChild(notice);
		msgs.appendChild(block);
	}

	async function ensureClientSession() {
		clientId = await clients.ensure();
		return clientId;
	}

	async function refreshClientSession() {
		clientId = await clients.refresh();
		return clientId;
	}

	async function loadHosts() {
		hosts = await loadHostList(api, activeHost);
	}

	async function switchHost(host) {
		const origin = hostOrigin(host);
		if (origin === api.getBaseUrl()) return;
		pane.closeMenu();
		api.setBaseUrl(origin);
		activeHost = { ...host, url: origin };
		try {
			await ensureClientSession();
			pane.reset();
			await sidebarCtrl.refresh();
		} catch (error) {
			showFatalError(error);
		}
	}

	try {
		await ensureClientSession();
	} catch (error) {
		showFatalError(error);
		throw error;
	}

	const shouldUseFaceId = !isLoopbackBrowserHost(window.location.hostname);
	const faceIdGuard = shouldUseFaceId ? installFaceIdGuard({ api }) : null;

	let sidebarCtrl = null;

	/** Terminals run on the host serving the page (its cookies, its websocket), never on a linked one. */
	const terminalsHere = () => api.getBaseUrl() === window.location.origin;
	/** @type {Promise<typeof import("./terminal/phone_terminal.js")> | null} */
	let phoneTerminalModule = null;
	/** @type {ReturnType<typeof import("./terminal/phone_terminal.js").createPhoneTerminal> | null} */
	let phoneTerminal = null;

	/** The terminal screen, loaded (xterm and all) the first time one opens. @param {{ terminalId: string | null, cwd: string | null, title?: string | null }} spec */
	async function openTerminal(spec) {
		if (!terminalsHere()) return;
		try {
			phoneTerminalModule ??= import("./terminal/phone_terminal.js");
			const { createPhoneTerminal } = await phoneTerminalModule;
			phoneTerminal ??= createPhoneTerminal({
				doc: document,
				api,
				refreshClient: refreshClientSession,
				onClosed: () => void sidebarCtrl?.refresh(),
				lock: faceIdGuard?.terminals,
			});
			phoneTerminal.open(spec);
		} catch (error) {
			phoneTerminalModule = null;
			pane.appendNotice(`Couldn't open the terminal: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	/** The host's shells for the sidebar; null when it has none to offer (another host's page, or terminals off). */
	async function listTerminals() {
		if (!terminalsHere()) return null;
		try {
			const data = await api.getJson("/api/terminals");
			return Array.isArray(data?.terminals) ? data.terminals : [];
		} catch {
			return null;
		}
	}

	/** @param {import("./canvas/launcher.js").LauncherPick} pick */
	async function onMenuPick(pick) {
		try {
			if (pick.kind === "terminal") await openTerminal({ terminalId: null, cwd: pick.cwd });
			else if (pick.kind === "created") pane.openSessionId(pick.sessionId);
			else await pane.selectSession(pick.session);
		} catch (error) {
			pane.appendNotice(error instanceof Error ? error.message : String(error), "error");
		}
		void sidebarCtrl?.refresh();
	}

	const launcherSheet = createLauncherSheet({
		doc: document,
		api,
		getClientId: () => clientId,
		canOpenTerminal: terminalsHere,
		onPick: (pick) => void onMenuPick(pick),
	});

	function fillBorders() {
		const chat = document.querySelector(".chat");
		const w = chat.getBoundingClientRect().width;
		const charW = 8.1;
		const count = Math.floor(w / charW);
		const dashes = "─".repeat(Math.max(10, count));
		document.querySelectorAll(".editor-border").forEach((el) => {
			el.textContent = dashes;
		});
	}

	const pane = createSessionPane({
		refs: paneRefs,
		api,
		getClientId: () => clientId,
		refreshClient: refreshClientSession,
		menuDom,
		getHost: () => ({ hostLabel: activeHost?.label ?? null, baseUrl: api.getBaseUrl() }),
		onSidebarClose: () => sidebarCtrl?.setOpen(false),
		onSidebarRefresh: () => sidebarCtrl?.refresh(),
		// /quit stopped the session: the pane empties and the menu opens at picking a directory, like a canvas tile
		onQuit: () => {
			pane.reset();
			launcherSheet.open();
			void sidebarCtrl?.refresh();
		},
		onOpenSession: (ref) => void openNamedSession(ref),
	});

	/**
	 * A session a message names (its sender), opened the way the sidebar opens one: wherever it lives, hosted here,
	 * followed while another pi runs it, or resumed.
	 * @param {import("./session/chat_view.js").SessionRef} ref
	 */
	async function openNamedSession(ref) {
		if (ref.id === pane.getSessionId()) return;
		try {
			const session = await findSession(api, ref.id);
			if (!session) {
				pane.appendNotice(`${ref.label} (${ref.id}) isn't a session on this host.`, "error");
				return;
			}
			await pane.selectSession(session);
		} catch (error) {
			pane.appendNotice(`Couldn't open ${ref.label}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		void sidebarCtrl?.refresh();
	}

	sidebarCtrl = createSidebar({
		sessionsList,
		sidebar,
		sidebarOverlay,
		sidebarLabel,
		btnSidebarLeft,
		btnSidebarRight,
		api,
		onNotice: pane.appendNotice,
		getActiveSessionId: () => pane.getSessionId(),
		onSelectSession: (session) => pane.selectSession(session),
		getHosts: () => hosts,
		getActiveHost: () => activeHost,
		onSelectHost: switchHost,
		onOpenMenu: () => launcherSheet.open(),
		terminals: { list: listTerminals, open: (spec) => void openTerminal(spec) },
	});

	if (kbMenu) kbMenu.addEventListener("click", () => sidebarCtrl.toggleOpen());
	if (sidebarOverlay) sidebarOverlay.addEventListener("click", () => sidebarCtrl.setOpen(false));

	window.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		// esc in a terminal is the shell's (vim), never an abort of the session behind it
		if (phoneTerminal?.isOpen()) return;
		if (launcherSheet.isOpen()) launcherSheet.handleEscape(e);
		else pane.handleEscape(e);
	});

	fillBorders();
	window.addEventListener("resize", fillBorders);
	window.addEventListener("resize", () => sidebarCtrl.setOpen(false));
	window.addEventListener("pageshow", () => pane.resumeIfStale());
	window.addEventListener("focus", () => pane.resumeIfStale());
	window.addEventListener("online", () => pane.resumeIfStale());
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") pane.resumeIfStale();
	});

	pane.render();

	if (faceIdGuard) {
		await faceIdGuard.start();
	}

	if (replayName) {
		void pane.runReplay(replayName);
	} else {
		await loadHosts();
		void sidebarCtrl.refresh();
		setInterval(() => {
			if (document.visibilityState !== "visible") return;
			if (isPhoneLike() && !sidebarCtrl.isOpen()) return;
			void sidebarCtrl.refresh();
		}, 5_000);
	}
}
