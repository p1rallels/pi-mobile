const data = {
	hosts: [
		{
			id: "local",
			label: "local mac",
			url: "https://local.tailnet.example.ts.net:8443",
			status: "online",
			sessions: [
				{
					id: "ui-polish",
					title: "mobile ui polish",
					subtitle: "composer, sidebar, tool cards",
					updated: "now",
					status: "working",
					messages: [
						{ from: "user", text: "can we make this feel more like telegram switching between boxes?" },
						{ from: "pi", text: "yep. host switching should feel like chat switching: fast, local, obvious, and mildly sybaritic.", tool: { title: "read public/app/main.js", body: "loaded host-aware state, per-origin client ids, and sse reset hooks" } },
						{ from: "pi", text: "this mock is disconnected from the backend, so we can mutate layout freely without worrying about certs, websockets, or caddy." },
					],
				},
				{
					id: "security",
					title: "secure startup",
					subtitle: "mtls + webauthn docs",
					updated: "8m",
					status: "idle",
					messages: [
						{ from: "user", text: "is this flow documented?" },
						{ from: "pi", text: "yes. the iphone profile install path is now explicit in the runbook and second-host guide." },
					],
				},
			],
		},
		{
			id: "prod-a",
			label: "prod-a",
			url: "https://prod-a.tailnet.example.ts.net:8443",
			status: "online",
			sessions: [
				{
					id: "infra",
					title: "second box setup",
					subtitle: "tailscale, caddy, certs",
					updated: "21m",
					status: "idle",
					messages: [
						{ from: "user", text: "walk me through adding another host." },
						{ from: "pi", text: "install tailscale/caddy/bun, run secure init, issue a device cert, add host links on each box, then use the sidebar." },
					],
				},
			],
		},
		{
			id: "lab",
			label: "lab mini",
			url: "https://lab.tailnet.example.ts.net:8443",
			status: "locked",
			sessions: [
				{
					id: "experiments",
					title: "prototype gestures",
					subtitle: "swipes, sheets, quick actions",
					updated: "1h",
					status: "warn",
					messages: [
						{ from: "pi", text: "lab is mocked as locked, but still clickable for ui iteration." },
					],
				},
			],
		},
	],
};

const state = {
	hostId: localStorage.getItem("mock-host") || "local",
	threadId: localStorage.getItem("mock-thread") || "ui-polish",
	role: localStorage.getItem("mock-role") || "viewer",
	model: localStorage.getItem("mock-model") || "sonnet",
	thinking: localStorage.getItem("mock-thinking") || "medium",
	filter: "active",
};

const $ = (id) => document.getElementById(id);

const hostList = $("host-list");
const threadList = $("thread-list");
const messages = $("messages");
const threadTitle = $("thread-title");
const threadMeta = $("thread-meta");
const activeHostSubtitle = $("active-host-subtitle");
const sidebar = $("sidebar");
const drawerScrim = $("drawer-scrim");
const sheet = $("sheet");
const sheetBackdrop = $("sheet-backdrop");
const composerInput = $("composer-input");

const activeHost = () => data.hosts.find((host) => host.id === state.hostId) || data.hosts[0];
const activeThread = () => activeHost().sessions.find((thread) => thread.id === state.threadId) || activeHost().sessions[0];

const persist = () => {
	localStorage.setItem("mock-host", state.hostId);
	localStorage.setItem("mock-thread", state.threadId);
	localStorage.setItem("mock-role", state.role);
	localStorage.setItem("mock-model", state.model);
	localStorage.setItem("mock-thinking", state.thinking);
};

const initials = (label) => label.split(/\s|-/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

const statusBadge = (status) => {
	const label = status === "working" ? "live" : status === "locked" ? "locked" : status === "warn" ? "check" : "idle";
	const klass = status === "working" || status === "online" ? "" : status === "warn" || status === "locked" ? "warn" : "idle";
	return `<span class="badge ${klass}">${label}</span>`;
};

const openDrawer = () => {
	sidebar.classList.add("open");
	drawerScrim.classList.add("open");
};

const closeDrawer = () => {
	sidebar.classList.remove("open");
	drawerScrim.classList.remove("open");
};

const closeSheet = () => {
	sheet.classList.remove("open");
	sheetBackdrop.classList.remove("open");
};

const renderHosts = () => {
	hostList.innerHTML = data.hosts.map((host) => `
		<button class="host-card ${host.id === state.hostId ? "active" : ""}" data-host="${host.id}">
			<div class="avatar">${initials(host.label)}</div>
			<div>
				<div class="title-row"><span class="card-title">${host.label}</span></div>
				<div class="card-subtitle">${host.url.replace("https://", "")}</div>
			</div>
			${statusBadge(host.status)}
		</button>
	`).join("");
};

const visibleSessions = () => {
	const sessions = activeHost().sessions;
	return state.filter === "all" ? sessions : sessions.filter((session) => session.status !== "idle" || sessions.length === 1);
};

const renderThreads = () => {
	const sessions = visibleSessions();
	threadList.innerHTML = sessions.map((thread) => `
		<button class="thread-card ${thread.id === state.threadId ? "active" : ""}" data-thread="${thread.id}">
			<div class="avatar">${initials(thread.title)}</div>
			<div>
				<div class="title-row"><span class="card-title">${thread.title}</span><span class="card-subtitle">${thread.updated}</span></div>
				<div class="card-subtitle">${thread.subtitle}</div>
			</div>
			${statusBadge(thread.status)}
		</button>
	`).join("");
};

const renderMessages = () => {
	const thread = activeThread();
	threadTitle.textContent = thread.title;
	threadMeta.textContent = `${activeHost().label} · ${activeHost().url.replace("https://", "")} · ${thread.subtitle}`;
	activeHostSubtitle.textContent = activeHost().label;
	messages.innerHTML = thread.messages.map((message, index) => `
		<article class="message ${message.from === "user" ? "user" : "pi"}">
			<div class="avatar">${message.from === "user" ? "u" : "π"}</div>
			<div class="bubble">
				<div class="bubble-head"><span>${message.from === "user" ? "you" : "pi"}</span><span>${index + 1}/${thread.messages.length}</span></div>
				<p>${message.text}</p>
				${message.tool ? `
					<div class="tool-card">
						<button data-tool-toggle><span>${message.tool.title}</span><span>⌄</span></button>
						<div class="tool-body">${message.tool.body}</div>
					</div>
				` : ""}
			</div>
		</article>
	`).join("");
	messages.scrollTop = messages.scrollHeight;
};

const renderChrome = () => {
	$("model-label").textContent = state.model;
	$("thinking-label").textContent = state.thinking;
	$("role-button").textContent = state.role;
	$("role-button").classList.toggle("controller", state.role === "controller");
	$("filter-button").textContent = state.filter;
};

const render = () => {
	renderHosts();
	renderThreads();
	renderMessages();
	renderChrome();
	persist();
};

const selectHost = (hostId) => {
	state.hostId = hostId;
	state.threadId = activeHost().sessions[0].id;
	render();
};

const selectThread = (threadId) => {
	state.threadId = threadId;
	render();
	closeDrawer();
};

const addMessage = (text) => {
	const thread = activeThread();
	thread.messages.push({ from: "user", text });
	thread.messages.push({ from: "pi", text: `mock reply on ${activeHost().label}: “${text}”` });
	thread.updated = "now";
	thread.status = "working";
	render();
};

const sendComposer = () => {
	const text = composerInput.value.trim();
	if (!text) return;
	composerInput.value = "";
	composerInput.style.height = "auto";
	addMessage(text);
};

const openSheet = ({ title, options, current, onSelect }) => {
	sheet.innerHTML = `
		<div class="sheet-head">
			<strong>${title}</strong>
			<button class="text-button" data-close-sheet>close</button>
		</div>
		<div class="sheet-list">
			${options.map((option) => `
				<button class="sheet-option ${option === current ? "active" : ""}" data-option="${option}">
					<span>${option}</span>
					<span>${option === current ? "selected" : ""}</span>
				</button>
			`).join("")}
		</div>
	`;
	sheet.querySelectorAll("[data-option]").forEach((button) => {
		button.addEventListener("click", () => {
			onSelect(button.dataset.option);
			closeSheet();
			render();
		});
	});
	sheet.querySelector("[data-close-sheet]").addEventListener("click", closeSheet);
	sheet.classList.add("open");
	sheetBackdrop.classList.add("open");
};

hostList.addEventListener("click", (event) => {
	const card = event.target.closest("[data-host]");
	if (!card) return;
	selectHost(card.dataset.host);
});

threadList.addEventListener("click", (event) => {
	const card = event.target.closest("[data-thread]");
	if (!card) return;
	selectThread(card.dataset.thread);
});

messages.addEventListener("click", (event) => {
	const toggle = event.target.closest("[data-tool-toggle]");
	if (!toggle) return;
	toggle.closest(".tool-card").classList.toggle("open");
});

$("open-drawer").addEventListener("click", openDrawer);
drawerScrim.addEventListener("click", closeDrawer);
sheetBackdrop.addEventListener("click", closeSheet);
$("send-button").addEventListener("click", sendComposer);
$("takeover-button").addEventListener("click", () => {
	state.role = "controller";
	render();
});
$("release-button").addEventListener("click", () => {
	state.role = "viewer";
	render();
});
$("abort-button").addEventListener("click", () => addMessage("abort current run"));
$("role-button").addEventListener("click", () => {
	state.role = state.role === "viewer" ? "controller" : "viewer";
	render();
});
$("filter-button").addEventListener("click", () => {
	state.filter = state.filter === "active" ? "all" : "active";
	render();
});
$("new-thread-button").addEventListener("click", () => {
	const host = activeHost();
	const id = `mock-${Date.now()}`;
	host.sessions.unshift({
		id,
		title: "new mock session",
		subtitle: "empty clickable state",
		updated: "now",
		status: "working",
		messages: [{ from: "pi", text: "new mock session created locally." }],
	});
	state.threadId = id;
	render();
});
$("model-button").addEventListener("click", () => openSheet({
	title: "choose model",
	options: ["haiku", "sonnet", "opus", "local"],
	current: state.model,
	onSelect: (value) => {
		state.model = value;
	},
}));
$("thinking-button").addEventListener("click", () => openSheet({
	title: "thinking level",
	options: ["none", "low", "medium", "high"],
	current: state.thinking,
	onSelect: (value) => {
		state.thinking = value;
	},
}));
$("quick-actions").addEventListener("click", (event) => {
	const button = event.target.closest("[data-prompt]");
	if (!button) return;
	addMessage(button.dataset.prompt);
});

composerInput.addEventListener("input", () => {
	composerInput.style.height = "auto";
	composerInput.style.height = `${Math.min(composerInput.scrollHeight, 140)}px`;
});

composerInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !/iphone|ipad|android/i.test(navigator.userAgent)) {
		event.preventDefault();
		sendComposer();
	}
});

render();
