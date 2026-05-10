const now = Date.now();

const fakeHosts = [
	{
		id: "local",
		label: "local",
		url: "https://local.tailnet.example.ts.net:8443",
		repos: ["/workspace/pi-web", "/workspace/agent-tools"],
		sessions: [
			{
				id: "a7f31c09-local-ui",
				name: "mobile ui polish",
				firstMessage: "make this feel like switching telegram chats",
				cwd: "/workspace/pi-web",
				modified: new Date(now - 40_000).toISOString(),
				isRunning: true,
				role: "viewer",
				isStreaming: true,
				model: { provider: "anthropic", id: "claude-sonnet-4" },
				thinkingLevel: "medium",
				stats: { tokens: { input: 18230, output: 2210, cacheRead: 120000, cacheWrite: 8000 }, cost: 0.147 },
				contextUsage: { percent: 41, contextWindow: 200000 },
				messages: [
					{ role: "user", text: "switch between boxes like telegram chats. no page jumps." },
					{ role: "assistant", thinking: "mapping host state to the same sidebar affordance without centralizing command routing", text: "done: the active host now changes in-page. api calls, session creation, and sse attach to the selected host." },
					{ role: "tool", status: "success", call: "read public/app/main.js", out: "loaded host-aware api state\nloaded per-origin client ids\nverified sidebar switching hooks" },
					{ role: "assistant", text: "this mock is now just the real ui shell with fake state. no network, no caddy, no tailscale, no thaumaturgy." },
				],
			},
			{
				id: "9fdc2012-security",
				name: "iphone onboarding docs",
				firstMessage: "document the ios p12 install flow",
				cwd: "/workspace/pi-web",
				modified: new Date(now - 8 * 60_000).toISOString(),
				isRunning: false,
				role: "controller",
				isStreaming: false,
				model: { provider: "anthropic", id: "claude-sonnet-4" },
				thinkingLevel: "low",
				stats: { tokens: { input: 6400, output: 980, cacheRead: 44000, cacheWrite: 0 }, cost: 0.052 },
				contextUsage: { percent: 18, contextWindow: 200000 },
				messages: [
					{ role: "user", text: "the iphone says the required cert is not installed." },
					{ role: "assistant", text: "ios only downloads the identity at first. finish installation in settings → profile downloaded, then reopen safari." },
					{ role: "tool", status: "success", call: "edit RUNBOOK.md", out: "clarified profile downloaded → install → enter p12 password" },
				],
			},
		],
	},
	{
		id: "prod-a",
		label: "prod-a",
		url: "https://prod-a.tailnet.example.ts.net:8443",
		repos: ["/srv/pi-web", "/srv/ops"],
		sessions: [
			{
				id: "bf802cad-prod-a",
				name: "second box setup",
				firstMessage: "walk me through adding a second host",
				cwd: "/srv/pi-web",
				modified: new Date(now - 22 * 60_000).toISOString(),
				isRunning: false,
				role: "viewer",
				isStreaming: false,
				model: { provider: "anthropic", id: "claude-haiku-4" },
				thinkingLevel: "off",
				stats: { tokens: { input: 2100, output: 430, cacheRead: 0, cacheWrite: 0 }, cost: 0.011 },
				contextUsage: { percent: 7, contextWindow: 200000 },
				messages: [
					{ role: "user", text: "add another tailscale host without a central gateway." },
					{ role: "assistant", text: "each host runs its own caddy mtls front door and pi-web backend. the browser switches origin; commands still go directly to that host." },
				],
			},
		],
	},
	{
		id: "lab",
		label: "lab-mini",
		url: "https://lab.tailnet.example.ts.net:8443",
		repos: ["/Users/example/lab"],
		sessions: [
			{
				id: "c41de993-lab",
				name: "tool card experiments",
				firstMessage: "try denser tool cards on phone",
				cwd: "/Users/example/lab",
				modified: new Date(now - 95 * 60_000).toISOString(),
				isRunning: true,
				role: "viewer",
				isStreaming: true,
				model: { provider: "local", id: "mock" },
				thinkingLevel: "high",
				stats: { tokens: { input: 8800, output: 1900, cacheRead: 0, cacheWrite: 1200 }, cost: 0 },
				contextUsage: { percent: 64, contextWindow: 128000 },
				messages: [
					{ role: "assistant", thinking: "checking mobile density", text: "this host is fake, but the selected state, footer, controls, and sidebar are the real layout." },
					{ role: "tool", status: "pending", call: "bash bun run test:e2e", out: "running chromium\nrunning webkit-iphone\nwaiting for screenshots…" },
				],
			},
		],
	},
];

const generatedHost = (index) => {
	const id = `box-${String(index).padStart(2, "0")}`;
	const label = `box-${String(index).padStart(2, "0")}`;
	const minutes = 12 + index * 7;
	return {
		id,
		label,
		url: `https://${id}.tailnet.example.ts.net:8443`,
		repos: [`/srv/${id}/pi-web`, `/srv/${id}/worktree`],
		sessions: [
			{
				id: `${id}-main-session`,
				name: `${label} active task`,
				firstMessage: `check ${label}`,
				cwd: `/srv/${id}/pi-web`,
				modified: new Date(now - minutes * 60_000).toISOString(),
				isRunning: index % 3 === 0,
				role: "viewer",
				isStreaming: index % 3 === 0,
				model: { provider: "anthropic", id: index % 2 === 0 ? "claude-sonnet-4" : "claude-haiku-4" },
				thinkingLevel: index % 2 === 0 ? "medium" : "low",
				stats: { tokens: { input: 1500 * index, output: 240 * index, cacheRead: 3200 * index, cacheWrite: index % 4 === 0 ? 800 : 0 }, cost: 0.006 * index },
				contextUsage: { percent: Math.min(82, 10 + index * 4), contextWindow: 200000 },
				messages: [
					{ role: "user", text: `open ${label} and show me what is active.` },
					{ role: "assistant", text: `${label} is fake, but this proves sessions change per selected host.` },
				],
			},
			{
				id: `${id}-notes-session`,
				name: `${label} notes`,
				firstMessage: `notes for ${label}`,
				cwd: `/srv/${id}/worktree`,
				modified: new Date(now - (minutes + 18) * 60_000).toISOString(),
				isRunning: false,
				role: "controller",
				isStreaming: false,
				model: { provider: "anthropic", id: "claude-sonnet-4" },
				thinkingLevel: "off",
				stats: { tokens: { input: 600 * index, output: 90 * index, cacheRead: 0, cacheWrite: 0 }, cost: 0.002 * index },
				contextUsage: { percent: Math.min(46, 4 + index * 2), contextWindow: 200000 },
				messages: [
					{ role: "assistant", text: `secondary mock session for ${label}.` },
				],
			},
		],
	};
};

fakeHosts.push(...Array.from({ length: 12 }, (_, index) => generatedHost(index + 4)));

const models = [
	{ provider: "anthropic", id: "claude-haiku-4", name: "fast" },
	{ provider: "anthropic", id: "claude-sonnet-4", name: "default" },
	{ provider: "anthropic", id: "claude-opus-4", name: "max" },
	{ provider: "local", id: "mock", name: "offline" },
];

const $ = (id) => document.getElementById(id);
const sessionsList = $("sessions-list");
const msgs = $("msgs");
const input = $("inp");
const workingIndicator = $("working");
const workingSpin = $("work-spin");
const footerLine1 = $("footer-line-1");
const footerLeft2 = $("footer-left-2");
const footerRight2 = $("footer-right-2");
const rolePill = $("role-pill");
const btnModel = $("btn-model");
const btnThinking = $("btn-thinking");
const lblModel = $("lbl-model");
const lblThinking = $("lbl-thinking");
const sidebarLabel = $("sidebar-label");
const btnSidebarLeft = $("btn-sidebar-left");
const btnSidebarRight = $("btn-sidebar-right");
const btnTakeover = $("btn-takeover");
const btnAbort = $("btn-abort");
const btnRelease = $("btn-release");
const menuOverlay = $("menu-overlay");
const menuScrim = $("menu-scrim");
const menuPanel = $("menu-panel");
const sidebar = document.querySelector(".sidebar");
const sidebarOverlay = $("sidebar-overlay");
const kbMenu = $("kb-menu");
const kbEsc = $("kb-esc");
const kbTakeover = $("kb-takeover");
const kbRelease = $("kb-release");
const kbEnter = $("kb-enter");

const state = {
	hostId: localStorage.getItem("pi-web-mock.host") || fakeHosts[0].id,
	sessionId: localStorage.getItem("pi-web-mock.session") || fakeHosts[0].sessions[0].id,
	mode: "active",
	repoCwd: null,
};

let workingTimer = null;
let workingFrame = 0;
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const activeHost = () => fakeHosts.find((host) => host.id === state.hostId) || fakeHosts[0];
const activeSession = () => activeHost().sessions.find((session) => session.id === state.sessionId) || activeHost().sessions[0] || null;
const save = () => {
	localStorage.setItem("pi-web-mock.host", state.hostId);
	localStorage.setItem("pi-web-mock.session", state.sessionId || "");
};

function escapeHtml(text) {
	return String(text ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function formatRelativeTime(iso) {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 10_000) return "just now";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

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
	return Number.isFinite(num) && num > 0 ? `$${num.toFixed(3)}` : null;
}

function metrics(session) {
	if (!session) return "";
	const parts = [];
	const tokens = session.stats?.tokens || {};
	if (tokens.input) parts.push(`↑${formatTokens(tokens.input)}`);
	if (tokens.output) parts.push(`↓${formatTokens(tokens.output)}`);
	if (tokens.cacheRead) parts.push(`R${formatTokens(tokens.cacheRead)}`);
	if (tokens.cacheWrite) parts.push(`W${formatTokens(tokens.cacheWrite)}`);
	const cost = formatCost(session.stats?.cost);
	if (cost) parts.push(cost);
	if (session.contextUsage?.contextWindow) parts.push(`${Math.round(session.contextUsage.percent)}%/${formatTokens(session.contextUsage.contextWindow)}`);
	return parts.join(" ");
}

function setSidebarButton(button, icon, label) {
	button.innerHTML = `${icon}<span class="txt">${label}</span>`;
}

const iconPlus = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const iconFolder = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H3z"/><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h8a2 2 0 0 1 2 2v2"/></svg>';
const iconBack = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>';

function openSidebar() {
	sidebar.classList.add("open");
	sidebarOverlay.classList.add("open");
}

function closeSidebar() {
	sidebar.classList.remove("open");
	sidebarOverlay.classList.remove("open");
}

function appendSectionLabel(label) {
	const row = document.createElement("div");
	row.className = "si mock-section";
	row.style.cursor = "default";
	const meta = document.createElement("div");
	meta.className = "si-meta";
	meta.textContent = label;
	row.appendChild(meta);
	sessionsList.appendChild(row);
}

function createHostRow(host) {
	const row = document.createElement("div");
	row.className = `si${host.id === state.hostId ? " active" : ""}`;
	row.dataset.hostId = host.id;
	row.innerHTML = `<div class="si-name">${escapeHtml(host.label)}</div><div class="si-meta">${host.id === state.hostId ? "current host" : escapeHtml(host.url)}</div>`;
	row.addEventListener("click", () => {
		state.hostId = host.id;
		state.sessionId = host.sessions[0]?.id || null;
		state.mode = "active";
		render();
	});
	return row;
}

function appendHostRows() {
	appendSectionLabel(`Hosts · ${fakeHosts.length}`);
	const hostScroll = document.createElement("div");
	hostScroll.className = "mock-host-scroll";
	for (const host of fakeHosts) {
		hostScroll.appendChild(createHostRow(host));
	}
	sessionsList.appendChild(hostScroll);
	appendSectionLabel(`Active Sessions · ${activeHost().label}`);
}

function appendSessionRows(sessions) {
	for (const session of sessions) {
		const row = document.createElement("div");
		row.className = `si${session.id === state.sessionId ? " active" : ""}`;
		row.dataset.sessionId = session.id;
		const label = session.name || session.firstMessage || session.id.slice(0, 8);
		row.innerHTML = `<div class="si-name" title="${escapeHtml(label)}">${escapeHtml(label)}</div><div class="si-meta">${formatRelativeTime(session.modified)} · ${escapeHtml(session.cwd)}${session.isRunning ? ' · <span class="si-run">running</span>' : ""}</div>`;
		row.addEventListener("click", () => {
			state.sessionId = session.id;
			if (state.mode === "repoSessions") state.mode = "active";
			render();
			closeSidebar();
		});
		sessionsList.appendChild(row);
	}
}

function appendRepoRows() {
	for (const cwd of activeHost().repos) {
		const row = document.createElement("div");
		row.className = "si";
		row.innerHTML = `<div class="si-name" title="${escapeHtml(cwd)}">${escapeHtml(cwd)}</div><div class="si-meta">tap to view sessions</div>`;
		row.addEventListener("click", () => {
			state.mode = "repoSessions";
			state.repoCwd = cwd;
			render();
		});
		sessionsList.appendChild(row);
	}
}

function renderSidebar() {
	sessionsList.innerHTML = "";
	btnSidebarLeft.onclick = null;
	btnSidebarRight.onclick = null;

	if (state.mode === "repos") {
		sidebarLabel.textContent = "Repos";
		setSidebarButton(btnSidebarLeft, iconBack, "Back");
		setSidebarButton(btnSidebarRight, iconPlus, "Add repo");
		btnSidebarLeft.onclick = () => {
			state.mode = "active";
			render();
		};
		btnSidebarRight.onclick = () => addNotice("mock only: repo added", "info");
		appendRepoRows();
		return;
	}

	if (state.mode === "repoSessions") {
		sidebarLabel.textContent = "Repo Sessions";
		sidebarLabel.title = state.repoCwd || "";
		setSidebarButton(btnSidebarLeft, iconBack, "Back");
		setSidebarButton(btnSidebarRight, iconPlus, "New session");
		btnSidebarLeft.onclick = () => {
			state.mode = "repos";
			render();
		};
		btnSidebarRight.onclick = newSession;
		appendSessionRows(activeHost().sessions.filter((session) => session.cwd === state.repoCwd));
		return;
	}

	sidebarLabel.textContent = "Active Sessions";
	sidebarLabel.title = "";
	setSidebarButton(btnSidebarLeft, iconPlus, "New session");
	setSidebarButton(btnSidebarRight, iconFolder, "Repos");
	btnSidebarLeft.onclick = newSession;
	btnSidebarRight.onclick = () => {
		state.mode = "repos";
		render();
	};
	appendHostRows();
	appendSessionRows(activeHost().sessions);
}

function renderMessages() {
	msgs.innerHTML = "";
	const session = activeSession();
	if (!session) {
		addNotice("No session selected.", "info", false);
		return;
	}
	for (const message of session.messages) {
		if (message.role === "user") {
			const user = document.createElement("div");
			user.className = "user-msg";
			user.textContent = message.text;
			msgs.appendChild(user);
		} else if (message.role === "assistant") {
			const block = document.createElement("div");
			block.className = "assistant-block";
			if (message.thinking) {
				const thinking = document.createElement("div");
				thinking.className = "thinking-text shown";
				thinking.textContent = message.thinking;
				block.appendChild(thinking);
			}
			const md = document.createElement("div");
			md.className = "md";
			md.textContent = message.text || "";
			block.appendChild(md);
			msgs.appendChild(block);
		} else if (message.role === "tool") {
			const box = document.createElement("div");
			box.className = `tool-box ${message.status || "success"}`;
			box.innerHTML = `<div class="tool-call">${escapeHtml(message.call)}</div><div class="tool-out">${escapeHtml(message.out)}</div>`;
			box.addEventListener("click", () => box.classList.toggle("success"));
			msgs.appendChild(box);
		}
	}
	msgs.scrollTop = msgs.scrollHeight;
}

function addNotice(text, kind = "info", scroll = true) {
	const block = document.createElement("div");
	block.className = "assistant-block";
	const notice = document.createElement("div");
	notice.className = `notice-text ${kind}`;
	notice.textContent = text;
	block.appendChild(notice);
	msgs.appendChild(block);
	if (scroll) msgs.scrollTop = msgs.scrollHeight;
}

function renderFooter() {
	const session = activeSession();
	if (!session) {
		footerLine1.textContent = `host: ${activeHost().label}`;
		footerLeft2.textContent = "—";
		footerRight2.textContent = activeHost().url;
		return;
	}
	footerLine1.textContent = session.cwd;
	const leftParts = [];
	const metricText = metrics(session);
	if (metricText) leftParts.push(metricText);
	leftParts.push(session.id.slice(0, 8));
	footerLeft2.textContent = leftParts.join(" • ");
	footerRight2.textContent = `${session.model.provider}/${session.model.id} • ${session.thinkingLevel}`;
}

function renderControls() {
	const session = activeSession();
	const hasSession = Boolean(session);
	const isController = hasSession && session.role === "controller";
	const streaming = hasSession && session.isStreaming;
	rolePill.textContent = hasSession ? session.role : "viewer";
	rolePill.classList.remove("controller", "viewer");
	rolePill.classList.add(isController ? "controller" : "viewer");
	btnAbort.disabled = !hasSession || !isController;
	btnTakeover.disabled = !hasSession || isController || streaming;
	btnRelease.disabled = !hasSession || !isController;
	input.disabled = !hasSession || !isController;
	btnModel.disabled = !hasSession || !isController || streaming;
	btnThinking.disabled = !hasSession || !isController || streaming;
	kbEsc.disabled = btnAbort.disabled;
	kbTakeover.disabled = btnTakeover.disabled;
	kbRelease.disabled = btnRelease.disabled;
	kbEnter.disabled = input.disabled;
	input.placeholder = !hasSession ? "" : isController ? "Type a prompt (Enter to send, Shift+Enter for newline)" : streaming ? "Viewer mode — Take over after the run finishes" : "Viewer mode — Take over to type";
	const model = hasSession ? `${session.model.provider}/${session.model.id}` : "—";
	lblModel.textContent = model;
	lblModel.title = model;
	lblThinking.textContent = hasSession ? session.thinkingLevel : "—";
	lblThinking.title = hasSession ? session.thinkingLevel : "—";
	workingIndicator.classList.toggle("open", Boolean(streaming));
}

function tickWorking() {
	if (!workingIndicator.classList.contains("open")) return;
	workingSpin.textContent = frames[workingFrame % frames.length];
	workingFrame += 1;
}

function fillBorders() {
	const chat = document.querySelector(".chat");
	const width = chat?.getBoundingClientRect().width || window.innerWidth;
	const count = Math.floor(width / 8.1);
	const dashes = "─".repeat(Math.max(10, count));
	document.querySelectorAll(".editor-border").forEach((el) => {
		el.textContent = dashes;
	});
}

function ensureSelection() {
	if (!fakeHosts.some((host) => host.id === state.hostId)) {
		state.hostId = fakeHosts[0].id;
	}
	const host = activeHost();
	if (!host.sessions.some((session) => session.id === state.sessionId)) {
		state.sessionId = host.sessions[0]?.id || null;
	}
}

function render() {
	ensureSelection();
	renderSidebar();
	renderMessages();
	renderFooter();
	renderControls();
	fillBorders();
	save();
	if (!workingTimer) workingTimer = setInterval(tickWorking, 80);
}

function newSession() {
	const host = activeHost();
	const id = `${Math.random().toString(16).slice(2, 10)}-mock`;
	const session = {
		id,
		name: "new mock session",
		firstMessage: "new mock session",
		cwd: host.repos[0] || "/workspace/pi-web",
		modified: new Date().toISOString(),
		isRunning: false,
		role: "controller",
		isStreaming: false,
		model: { provider: "anthropic", id: "claude-sonnet-4" },
		thinkingLevel: "medium",
		stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
		contextUsage: { percent: 0, contextWindow: 200000 },
		messages: [{ role: "assistant", text: "new mock session. this exists only in local browser state." }],
	};
	host.sessions.unshift(session);
	state.sessionId = id;
	state.mode = "active";
	render();
	closeSidebar();
}

function sendPrompt() {
	const session = activeSession();
	const text = input.value.trim();
	if (!session || !text) return;
	input.value = "";
	autoResize(input);
	session.messages.push({ role: "user", text });
	session.messages.push({ role: "assistant", thinking: "mock response only", text: `received on ${activeHost().label}: ${text}` });
	session.modified = new Date().toISOString();
	session.isRunning = true;
	session.isStreaming = true;
	render();
}

function autoResize(el) {
	el.style.height = "auto";
	el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

function closeMenu() {
	menuOverlay.classList.remove("open");
	menuPanel.innerHTML = "";
}

function positionMenu(anchor) {
	const rect = anchor.getBoundingClientRect();
	requestAnimationFrame(() => {
		const panel = menuPanel.getBoundingClientRect();
		const margin = 8;
		let left = rect.left + rect.width / 2 - panel.width / 2;
		let top = rect.bottom + 6;
		left = Math.max(margin, Math.min(left, window.innerWidth - panel.width - margin));
		top = Math.max(margin, Math.min(top, window.innerHeight - panel.height - margin));
		menuPanel.style.left = `${left}px`;
		menuPanel.style.top = `${top}px`;
	});
}

function openModelMenu() {
	const session = activeSession();
	if (!session || btnModel.disabled) return;
	menuOverlay.classList.add("open");
	menuPanel.innerHTML = `
		<div class="menu-hdr"><div class="menu-title">Model</div><button class="menu-mini" data-close>Close</button></div>
		<div class="menu-body"><input class="menu-search" placeholder="Search models…"><div class="menu-list"></div></div>
	`;
	const list = menuPanel.querySelector(".menu-list");
	const search = menuPanel.querySelector(".menu-search");
	const draw = () => {
		const q = search.value.toLowerCase();
		list.innerHTML = "";
		for (const model of models.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q))) {
			const key = `${model.provider}/${model.id}`;
			const item = document.createElement("div");
			item.className = `menu-item${key === `${session.model.provider}/${session.model.id}` ? " active" : ""}`;
			item.innerHTML = `<div class="primary">${escapeHtml(key)}</div><div class="secondary">${escapeHtml(model.name)}</div>`;
			item.addEventListener("click", () => {
				session.model = { provider: model.provider, id: model.id };
				closeMenu();
				render();
			});
			list.appendChild(item);
		}
	};
	menuPanel.querySelector("[data-close]").addEventListener("click", closeMenu);
	search.addEventListener("input", draw);
	draw();
	positionMenu(btnModel);
	search.focus();
}

function openThinkingMenu() {
	const session = activeSession();
	if (!session || btnThinking.disabled) return;
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
	menuOverlay.classList.add("open");
	menuPanel.innerHTML = `
		<div class="menu-hdr"><div class="menu-title">Thinking level</div><button class="menu-mini" data-close>Close</button></div>
		<div class="menu-body"><div class="menu-list"></div></div>
	`;
	const list = menuPanel.querySelector(".menu-list");
	for (const level of levels) {
		const item = document.createElement("div");
		item.className = `menu-item${level === session.thinkingLevel ? " active" : ""}`;
		item.innerHTML = `<div class="primary">${level}</div>`;
		item.addEventListener("click", () => {
			session.thinkingLevel = level;
			closeMenu();
			render();
		});
		list.appendChild(item);
	}
	menuPanel.querySelector("[data-close]").addEventListener("click", closeMenu);
	positionMenu(btnThinking);
}

function takeOver() {
	const session = activeSession();
	if (!session) return;
	session.role = "controller";
	session.isStreaming = false;
	session.isRunning = false;
	addNotice("mock: controller role acquired");
	renderControls();
	renderFooter();
}

function release() {
	const session = activeSession();
	if (!session) return;
	session.role = "viewer";
	session.messages.push({ role: "assistant", text: "released. safe to resume in native cli." });
	render();
}

function abort() {
	const session = activeSession();
	if (!session) return;
	session.isStreaming = false;
	session.isRunning = false;
	session.messages.push({ role: "assistant", text: "operation aborted", thinking: "mock abort path" });
	render();
}

btnTakeover.addEventListener("click", takeOver);
btnRelease.addEventListener("click", release);
btnAbort.addEventListener("click", abort);
btnModel.addEventListener("click", openModelMenu);
btnThinking.addEventListener("click", openThinkingMenu);
menuScrim.addEventListener("click", closeMenu);
kbMenu.addEventListener("click", openSidebar);
kbEsc.addEventListener("click", abort);
kbTakeover.addEventListener("click", takeOver);
kbRelease.addEventListener("click", release);
kbEnter.addEventListener("click", sendPrompt);
sidebarOverlay.addEventListener("click", closeSidebar);
input.addEventListener("input", () => autoResize(input));
input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendPrompt();
	}
});
window.addEventListener("resize", fillBorders);

render();
