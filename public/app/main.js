import { createApi } from "./core/api.js";
import { isPhoneLike } from "./core/device.js";
import { installFaceIdGuard } from "./core/faceid.js";
import { createSessionController } from "./session/controller.js";
import { createMenu } from "./ui/menu.js";
import { createSidebar } from "./ui/sidebar.js";

const sessionsList = document.getElementById("sessions-list");
const msgs = document.getElementById("msgs");
const jumpLatest = document.getElementById("jump-latest");
const queuedPanel = document.getElementById("queued-panel");
const input = document.getElementById("inp");
const workingIndicator = document.getElementById("working");
const workingSpin = document.getElementById("work-spin");
const workingText = document.querySelector(".work-text");

const footerLine1 = document.getElementById("footer-line-1");
const footerLeft2 = document.getElementById("footer-left-2");
const footerRight2 = document.getElementById("footer-right-2");

const rolePill = document.getElementById("role-pill");
const btnModel = document.getElementById("btn-model");
const btnThinking = document.getElementById("btn-thinking");
const lblModel = document.getElementById("lbl-model");
const lblThinking = document.getElementById("lbl-thinking");

const sidebarLabel = document.getElementById("sidebar-label");
const btnSidebarLeft = document.getElementById("btn-sidebar-left");
const btnSidebarRight = document.getElementById("btn-sidebar-right");

const btnTakeover = document.getElementById("btn-takeover");
const btnAbort = document.getElementById("btn-abort");
const btnRelease = document.getElementById("btn-release");

const menuOverlay = document.getElementById("menu-overlay");
const menuScrim = document.getElementById("menu-scrim");
const menuPanel = document.getElementById("menu-panel");

const sidebar = document.querySelector(".sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");

const kbMenu = document.getElementById("kb-menu");
const kbEsc = document.getElementById("kb-esc");
const kbTakeover = document.getElementById("kb-takeover");
const kbRelease = document.getElementById("kb-release");
const kbEnter = document.getElementById("kb-enter");

const replayName = new URL(window.location.href).searchParams.get("replay")?.trim() || null;
const initialHost = {
	id: "current",
	label: window.location.hostname || "current",
	url: window.location.origin,
	enabled: true,
};
const api = createApi({ baseUrl: initialHost.url });
let activeHost = initialHost;
let hosts = [];
let clientId = null;
const clientIdsByOrigin = new Map();

function isLoopbackBrowserHost(hostname) {
	const normalized = String(hostname || "").trim().toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized.startsWith("127.")
	);
}

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

function hostOrigin(host) {
	return new URL(host.url, window.location.href).origin;
}

function mergeHosts(rawHosts) {
	const byOrigin = new Map();
	for (const host of rawHosts) {
		if (!host || typeof host !== "object" || host.enabled === false || typeof host.url !== "string") continue;
		try {
			byOrigin.set(hostOrigin(host), { ...host, url: hostOrigin(host) });
		} catch {
			continue;
		}
	}
	return [...byOrigin.values()].sort((a, b) => String(a.label || a.id || a.url).localeCompare(String(b.label || b.id || b.url)));
}

async function ensureClientSession() {
	const origin = api.getBaseUrl();
	const cached = clientIdsByOrigin.get(origin);
	if (cached) {
		clientId = cached;
		return cached;
	}
	const clientSession = await api.postJson("/api/client", {});
	if (!clientSession || typeof clientSession.clientId !== "string" || clientSession.clientId.length === 0) {
		throw new Error("Failed to establish browser session.");
	}
	clientIdsByOrigin.set(origin, clientSession.clientId);
	clientId = clientSession.clientId;
	return clientId;
}

async function refreshClientSession() {
	clientIdsByOrigin.delete(api.getBaseUrl());
	return ensureClientSession();
}

async function loadHosts() {
	const data = await api.getJson("/api/hosts").catch(() => ({ hosts: [] }));
	const rawHosts = Array.isArray(data.hosts) ? data.hosts : [];
	hosts = mergeHosts(rawHosts);
	if (!hosts.some((host) => hostOrigin(host) === api.getBaseUrl())) {
		hosts = mergeHosts([...hosts, activeHost]);
	}
}

async function switchHost(host) {
	const origin = hostOrigin(host);
	if (origin === api.getBaseUrl()) return;
	menuCtrl?.close();
	api.setBaseUrl(origin);
	activeHost = { ...host, url: origin };
	try {
		await ensureClientSession();
		sessionCtrl.reset();
		updateFooter();
		updateControls();
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

let workingIntervalId = null;
let workingFrame = 0;

let sidebarCtrl = null;
let menuCtrl = null;

function formatTokens(n) {
	const num = Number(n || 0);
	if (!Number.isFinite(num) || num <= 0) return "0";
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 10_000) return `${Math.round(num / 1_000)}k`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
	return String(Math.round(num));
}

function formatCost(cost) {
	const num = Number(cost || 0);
	if (!Number.isFinite(num) || num <= 0) return null;
	return `$${num.toFixed(3)}`;
}

function buildSessionMetrics(state) {
	if (!state || typeof state !== "object") return "";

	const parts = [];
	const stats = state.stats && typeof state.stats === "object" ? state.stats : null;
	const tokens = stats && stats.tokens && typeof stats.tokens === "object" ? stats.tokens : null;

	const inputTokens = tokens && typeof tokens.input === "number" ? tokens.input : 0;
	const outputTokens = tokens && typeof tokens.output === "number" ? tokens.output : 0;
	const cacheRead = tokens && typeof tokens.cacheRead === "number" ? tokens.cacheRead : 0;
	const cacheWrite = tokens && typeof tokens.cacheWrite === "number" ? tokens.cacheWrite : 0;
	const cost = stats && typeof stats.cost === "number" ? stats.cost : 0;

	if (inputTokens) parts.push(`↑${formatTokens(inputTokens)}`);
	if (outputTokens) parts.push(`↓${formatTokens(outputTokens)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);

	const costStr = formatCost(cost);
	if (costStr) parts.push(costStr);

	const usage = state.contextUsage && typeof state.contextUsage === "object" ? state.contextUsage : null;
	const cw = usage && typeof usage.contextWindow === "number" ? usage.contextWindow : 0;
	if (cw > 0) {
		const percent = typeof usage.percent === "number" ? usage.percent : null;
		const auto = state.autoCompactionEnabled ? " (auto)" : "";
		if (percent === null) {
			parts.push(`?/${formatTokens(cw)}${auto}`);
		} else {
			parts.push(`${Math.round(percent)}%/${formatTokens(cw)}${auto}`);
		}
	}

	return parts.join(" ");
}

function updateFooter() {
	const activeState = sessionCtrl.getActiveState();
	if (!activeState) {
		footerLine1.textContent = activeHost?.label ? `host: ${activeHost.label}` : "—";
		footerLeft2.textContent = "—";
		footerRight2.textContent = api.getBaseUrl();
		return;
	}

	footerLine1.textContent = activeState.cwd || "—";

	const model = activeState.model ? `${activeState.model.provider}/${activeState.model.id}` : "(no model)";
	const metrics = buildSessionMetrics(activeState);
	const leftParts = [];
	if (metrics) leftParts.push(metrics);
	leftParts.push(activeState.sessionId.slice(0, 8));
	footerLeft2.textContent = leftParts.join(" • ");
	footerRight2.textContent = `${model} • ${activeState.thinkingLevel}`;
}

function updateRolePill() {
	const role = sessionCtrl.getRole();
	const connection = sessionCtrl.getConnection();
	const offline = Boolean(sessionCtrl.getActiveSessionId()) && (connection === "reconnecting" || connection === "gone");
	rolePill.textContent = offline ? (connection === "gone" ? "ended" : "reconnecting") : role;
	rolePill.classList.remove("controller", "viewer", "offline");
	rolePill.classList.add(offline ? "offline" : role);
}

function updateTopSelectors() {
	const activeState = sessionCtrl.getActiveState();
	const model = activeState?.model ? `${activeState.model.provider}/${activeState.model.id}` : "—";
	if (lblModel) {
		lblModel.textContent = model;
		lblModel.title = model;
	}
	const thinking = activeState?.thinkingLevel ? String(activeState.thinkingLevel) : "—";
	if (lblThinking) {
		lblThinking.textContent = thinking;
		lblThinking.title = thinking;
	}
}

function workingLabel(status) {
	if (status.kind === "compacting") return status.reason && status.reason !== "manual" ? `Compacting context (${status.reason})...` : "Compacting context...";
	if (status.kind === "retrying") return `Retrying (${status.attempt}/${status.maxAttempts})...`;
	return "Working...";
}

function updateWorkingIndicator() {
	if (!workingIndicator) return;
	const status = sessionCtrl.getRunStatus();
	const show = isPhoneLike() && status.kind !== "idle";
	workingIndicator.classList.toggle("open", show);
	if (workingText) workingText.textContent = workingLabel(status);

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const updateFrame = () => {
		if (workingSpin) workingSpin.textContent = frames[workingFrame % frames.length];
		workingFrame = (workingFrame + 1) % frames.length;
	};

	if (show) {
		if (!workingIntervalId) {
			workingFrame = 0;
			updateFrame();
			workingIntervalId = setInterval(updateFrame, 80);
		}
	} else if (workingIntervalId) {
		clearInterval(workingIntervalId);
		workingIntervalId = null;
	}
}

function updateControls() {
	updateRolePill();

	const hasSession = Boolean(sessionCtrl.getActiveSessionId());
	const isController = hasSession && sessionCtrl.isController();
	const activeState = sessionCtrl.getActiveState();
	const compacting = Boolean(activeState && activeState.isCompacting);
	const streaming = Boolean(activeState && activeState.isStreaming);
	const busy = streaming || compacting;
	const phone = isPhoneLike();
	const canChangeSettings = hasSession && isController && !busy;

	btnAbort.disabled = !hasSession || !isController;
	btnTakeover.disabled = !hasSession || isController || busy;
	btnRelease.disabled = !hasSession || !isController;
	input.disabled = !hasSession || !isController || compacting;
	if (btnModel) btnModel.disabled = !canChangeSettings;
	if (btnThinking) btnThinking.disabled = !canChangeSettings;

	if (kbEsc) kbEsc.disabled = !hasSession || !isController;
	if (kbTakeover) kbTakeover.disabled = !hasSession || isController || busy;
	if (kbRelease) kbRelease.disabled = !hasSession || !isController;
	if (kbEnter) kbEnter.disabled = !hasSession || !isController || compacting;

	if (!hasSession) {
		input.placeholder = "";
	} else if (compacting) {
		input.placeholder = "Compacting context…";
	} else if (isController) {
		input.placeholder = phone
			? "Type a prompt (Enter steers, /queue waits)"
			: streaming
				? "Streaming… (Enter steers, /queue waits)"
				: "Type a prompt (Enter to send, Shift+Enter for newline)";
	} else {
		input.placeholder = streaming ? "Viewer mode — Take over after the run finishes" : "Viewer mode — Take over to type";
	}

	updateTopSelectors();
	updateWorkingIndicator();
}

function autoResize(el) {
	el.style.height = "auto";
	el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

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

function restoreComposerText(text) {
	input.value = input.value.trim() ? `${text}\n${input.value}` : text;
	autoResize(input);
}

async function sendPromptFromInput() {
	if (input.disabled) return;
	const text = input.value;
	if (!text.trim()) return;
	input.value = "";
	autoResize(input);
	input.focus();
	try {
		await sessionCtrl.sendPrompt(text);
	} catch (error) {
		restoreComposerText(text);
		sessionCtrl.appendNotice(`Not sent: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

const sessionCtrl = createSessionController({
	msgsEl: msgs,
	queuedEl: queuedPanel,
	pillEl: jumpLatest,
	api,
	getClientId: () => clientId,
	onRefreshClient: refreshClientSession,
	onStateChange: () => {
		updateFooter();
		updateControls();
	},
	onCloseMenu: () => menuCtrl?.close(),
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
	onNotice: sessionCtrl.appendNotice,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	onSelectSession: (session) => sessionCtrl.selectSession(session),
	onSessionIdSelected: (sessionId) => {
		sessionCtrl.openSessionId(sessionId);
		updateControls();
	},
	getHosts: () => hosts,
	getActiveHost: () => activeHost,
	onSelectHost: switchHost,
});

menuCtrl = createMenu({
	menuOverlay,
	menuScrim,
	menuPanel,
	btnModel,
	btnThinking,
	api,
	getClientId: () => clientId,
	onNotice: sessionCtrl.appendNotice,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	getActiveState: () => sessionCtrl.getActiveState(),
});

btnAbort.addEventListener("click", () => void sessionCtrl.abortRun());
btnTakeover.addEventListener("click", () => void sessionCtrl.takeOver());
btnRelease.addEventListener("click", () => void sessionCtrl.release());
if (btnModel) btnModel.addEventListener("click", () => void menuCtrl.openModelMenu());
if (btnThinking) btnThinking.addEventListener("click", () => menuCtrl.openThinkingMenu());

if (kbMenu) kbMenu.addEventListener("click", () => sidebarCtrl.toggleOpen());
if (kbEsc) kbEsc.addEventListener("click", () => void sessionCtrl.abortRun());
if (kbTakeover) kbTakeover.addEventListener("click", () => void sessionCtrl.takeOver());
if (kbRelease) kbRelease.addEventListener("click", () => void sessionCtrl.release());
if (kbEnter) kbEnter.addEventListener("click", () => void sendPromptFromInput());

if (sidebarOverlay) sidebarOverlay.addEventListener("click", () => sidebarCtrl.setOpen(false));

input.addEventListener("input", () => autoResize(input));
input.addEventListener("keydown", (e) => {
	if (isPhoneLike()) return;
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		void sendPromptFromInput();
	}
});

window.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		if (menuCtrl.isOpen()) {
			e.preventDefault();
			menuCtrl.close();
			return;
		}
		void sessionCtrl.abortRun();
	}
});

fillBorders();
window.addEventListener("resize", fillBorders);
window.addEventListener("resize", () => sidebarCtrl.setOpen(false));
window.addEventListener("pageshow", () => void sessionCtrl.syncState());
window.addEventListener("focus", () => void sessionCtrl.syncState());
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") void sessionCtrl.syncState();
});
setInterval(() => {
	if (document.visibilityState === "visible" && sessionCtrl.getActiveState()?.isCompacting) void sessionCtrl.syncState();
}, 1500);

updateFooter();
updateControls();

if (faceIdGuard) {
	await faceIdGuard.start();
}

if (replayName) {
	void sessionCtrl.runReplay(replayName);
} else {
	await loadHosts();
	void sidebarCtrl.refresh();
	setInterval(() => void sidebarCtrl.refresh(), 5_000);
}
