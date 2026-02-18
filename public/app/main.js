import { createApi } from "./core/api.js";
import { isPhoneLike } from "./core/device.js";
import { installFaceIdGuard } from "./core/faceid.js";
import { getOrCreateClientId, getToken } from "./core/storage.js";
import { createSessionController } from "./session/controller.js";
import { createMenu } from "./ui/menu.js";
import { createSidebar } from "./ui/sidebar.js";

const sessionsList = document.getElementById("sessions-list");
const msgs = document.getElementById("msgs");
const input = document.getElementById("inp");
const workingIndicator = document.getElementById("working");
const workingSpin = document.getElementById("work-spin");

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

const clientId = getOrCreateClientId();
const token = getToken();
const replayName = new URL(window.location.href).searchParams.get("replay")?.trim() || null;
const api = createApi(token);
const faceIdGuard = installFaceIdGuard({ api });

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
		if (percent === null) {
			parts.push(`?/${formatTokens(cw)}`);
		} else {
			parts.push(`${Math.round(percent)}%/${formatTokens(cw)}`);
		}
	}

	return parts.join(" ");
}

function updateFooter() {
	const activeState = sessionCtrl.getActiveState();
	if (!activeState) {
		footerLine1.textContent = "—";
		footerLeft2.textContent = "—";
		footerRight2.textContent = "—";
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
	rolePill.textContent = role;
	rolePill.classList.remove("controller", "viewer");
	rolePill.classList.add(role);
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

function updateWorkingIndicator() {
	if (!workingIndicator) return;
	const activeState = sessionCtrl.getActiveState();
	const show = isPhoneLike() && (sessionCtrl.getPendingPrompt() || Boolean(activeState && activeState.isStreaming));
	workingIndicator.classList.toggle("open", show);

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
	const streaming = Boolean(sessionCtrl.getActiveState() && sessionCtrl.getActiveState().isStreaming);
	const phone = isPhoneLike();
	const canChangeSettings = hasSession && isController && !streaming;

	btnAbort.disabled = !hasSession;
	btnTakeover.disabled = !hasSession || isController || streaming;
	btnRelease.disabled = !hasSession || !isController;
	input.disabled = !hasSession || !isController;
	if (btnModel) btnModel.disabled = !canChangeSettings;
	if (btnThinking) btnThinking.disabled = !canChangeSettings;

	if (kbEsc) kbEsc.disabled = !hasSession;
	if (kbTakeover) kbTakeover.disabled = !hasSession || isController || streaming;
	if (kbRelease) kbRelease.disabled = !hasSession || !isController;
	if (kbEnter) kbEnter.disabled = !hasSession || !isController;

	if (!hasSession) {
		input.placeholder = "";
	} else if (isController) {
		input.placeholder = phone
			? "Type a prompt (Enter key to send, Return key for newline)"
			: streaming
				? "Streaming… (Esc to abort, Enter to queue follow-up)"
				: "Type a prompt (Enter to send, Shift+Enter for newline)";
	} else {
		input.placeholder = streaming ? "Viewer mode — Esc to abort" : "Viewer mode — Take over to type";
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

function sendPromptFromInput() {
	if (input.disabled) return;
	const text = input.value;
	input.value = "";
	autoResize(input);
	void sessionCtrl.sendPrompt(text);
	input.focus();
}

const sessionCtrl = createSessionController({
	msgsEl: msgs,
	api,
	clientId,
	token,
	isPhoneLikeFn: isPhoneLike,
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
	clientId,
	onNotice: sessionCtrl.appendNotice,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	onSelectSession: (s) => sessionCtrl.selectSession(s),
	onSessionIdSelected: (sessionId) => {
		sessionCtrl.openSessionId(sessionId);
		updateControls();
	},
});

menuCtrl = createMenu({
	menuOverlay,
	menuScrim,
	menuPanel,
	btnModel,
	btnThinking,
	api,
	clientId,
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
if (kbEnter) kbEnter.addEventListener("click", () => sendPromptFromInput());

if (sidebarOverlay) sidebarOverlay.addEventListener("click", () => sidebarCtrl.setOpen(false));

input.addEventListener("input", () => autoResize(input));
input.addEventListener("keydown", (e) => {
	if (isPhoneLike()) return;
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendPromptFromInput();
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

updateFooter();
updateControls();

if (replayName) {
	void sessionCtrl.runReplay(replayName);
} else {
	void sidebarCtrl.refresh();
	setInterval(() => void sidebarCtrl.refresh(), 5_000);
}

void faceIdGuard.start();
