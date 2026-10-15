// The phone shell: header, sidebar and one session pane on the static markup in index.html.
import { createApi } from "./core/api.js";
import { isPhoneLike } from "./core/device.js";
import { installFaceIdGuard } from "./core/faceid.js";
import { createClientSessions, hostOrigin, isLoopbackBrowserHost, loadHostList, pageHost } from "./core/hosts.js";
import { createSessionPane } from "./session/pane.js";
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
	});

	sidebarCtrl = createSidebar({
		sessionsList,
		sidebar,
		sidebarOverlay,
		sidebarLabel,
		btnSidebarLeft,
		btnSidebarRight,
		api,
		getClientId: () => clientId,
		onNotice: pane.appendNotice,
		getActiveSessionId: () => pane.getSessionId(),
		onSelectSession: (session) => pane.selectSession(session),
		onSessionIdSelected: (sessionId) => pane.openSessionId(sessionId),
		getHosts: () => hosts,
		getActiveHost: () => activeHost,
		onSelectHost: switchHost,
		createSession: pane.createSession,
	});

	if (kbMenu) kbMenu.addEventListener("click", () => sidebarCtrl.toggleOpen());
	if (sidebarOverlay) sidebarOverlay.addEventListener("click", () => sidebarCtrl.setOpen(false));

	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape") pane.handleEscape(e);
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
