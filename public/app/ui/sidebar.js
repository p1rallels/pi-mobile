function formatRelativeTime(iso) {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) return "just now";
	const s = Math.floor(ms / 1000);
	if (s < 10) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d === 1) return "yesterday";
	return `${d}d ago`;
}

const ICON_PLUS =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const ICON_FOLDER =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H3z"/><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h8a2 2 0 0 1 2 2v2"/></svg>';
const ICON_BACK =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>';

function setSidebarButton(btn, icon, label) {
	if (!btn) return;
	btn.innerHTML = `${icon}<span class="txt">${label}</span>`;
}

function escapeHtml(text) {
	return String(text)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function shouldShowSessionInLists(s) {
	if (!s || typeof s !== "object") return false;
	if (s.isRunning) return true;
	const name = typeof s.name === "string" ? s.name.trim() : "";
	if (name) return true;
	const first = typeof s.firstMessage === "string" ? s.firstMessage.trim() : "";
	return first && first !== "(no messages)";
}

export function createSidebar({
	sessionsList,
	sidebar,
	sidebarOverlay,
	sidebarLabel,
	btnSidebarLeft,
	btnSidebarRight,
	api,
	clientId,
	onNotice,
	getActiveSessionId,
	onSelectSession,
	onSessionIdSelected,
}) {
	let isOpen = false;
	let mode = "active"; // active | repos | repoSessions
	let selectedRepoCwd = null;

	function setOpen(open) {
		if (!sidebar) return;
		isOpen = Boolean(open);
		if (isOpen) {
			sidebar.classList.add("open");
			if (sidebarOverlay) sidebarOverlay.classList.add("open");
		} else {
			sidebar.classList.remove("open");
			if (sidebarOverlay) sidebarOverlay.classList.remove("open");
		}
	}

	function toggleOpen() {
		setOpen(!isOpen);
	}

	function setMode(nextMode, repoCwd = null) {
		mode = nextMode;
		selectedRepoCwd = repoCwd;
		updateHeader();
		void refresh();
	}

	function updateHeader() {
		if (!sidebarLabel || !btnSidebarLeft || !btnSidebarRight) return;
		btnSidebarLeft.onclick = null;
		btnSidebarRight.onclick = null;

		if (mode === "repos") {
			sidebarLabel.textContent = "Repos";
			setSidebarButton(btnSidebarLeft, ICON_BACK, "Back");
			setSidebarButton(btnSidebarRight, ICON_PLUS, "Add repo");
			btnSidebarLeft.onclick = () => setMode("active");
			btnSidebarRight.onclick = () => void promptAddRepo();
			return;
		}

		if (mode === "repoSessions") {
			sidebarLabel.textContent = "Repo Sessions";
			sidebarLabel.title = selectedRepoCwd || "";
			setSidebarButton(btnSidebarLeft, ICON_BACK, "Back");
			setSidebarButton(btnSidebarRight, ICON_PLUS, "New session");
			btnSidebarLeft.onclick = () => setMode("repos");
			btnSidebarRight.onclick = () => void startNewSessionInRepo(selectedRepoCwd);
			return;
		}

		sidebarLabel.textContent = "Active Sessions";
		sidebarLabel.title = "";
		setSidebarButton(btnSidebarLeft, ICON_PLUS, "New session");
		setSidebarButton(btnSidebarRight, ICON_FOLDER, "Repos");
		btnSidebarLeft.onclick = () => void promptNewSessionRepo();
		btnSidebarRight.onclick = () => setMode("repos");
	}

	function highlightSessionRow(sessionId) {
		sessionsList.querySelectorAll(".si").forEach((row) => {
			row.classList.toggle("active", row.dataset.sessionId === sessionId);
		});
	}

	function renderSessions(sessions, view = "active") {
		sessionsList.innerHTML = "";
		for (const s of sessions) {
			const row = document.createElement("div");
			row.className = `si${s.id === getActiveSessionId() ? " active" : ""}`;
			row.dataset.sessionId = s.id;

			const name = document.createElement("div");
			name.className = "si-name";
			const labelRaw =
				(typeof s.name === "string" && s.name.trim()) ||
				(typeof s.firstMessage === "string" && s.firstMessage.trim()) ||
				s.id.slice(0, 8);
			const label = String(labelRaw).replace(/\s+/g, " ").trim();
			name.textContent = label;
			name.title = label;

			const meta = document.createElement("div");
			meta.className = "si-meta";
			const rel = formatRelativeTime(s.modified);
			meta.innerHTML = `${rel} · ${escapeHtml(s.cwd)}${s.isRunning ? ` · <span class="si-run">running</span>` : ""}`;

			row.appendChild(name);
			row.appendChild(meta);

			row.addEventListener("click", () => {
				highlightSessionRow(s.id);
				if (view === "repoSessions") {
					void (async () => {
						await onSelectSession(s);
						setMode("active");
					})();
				} else {
					void onSelectSession(s);
				}
			});

			sessionsList.appendChild(row);
		}
	}

	function renderRepos(repos) {
		sessionsList.innerHTML = "";
		for (const cwd of repos) {
			const row = document.createElement("div");
			row.className = "si";
			row.dataset.repoCwd = cwd;

			const name = document.createElement("div");
			name.className = "si-name";
			name.textContent = cwd;
			name.title = cwd;

			const meta = document.createElement("div");
			meta.className = "si-meta";
			meta.textContent = "tap to view sessions";

			row.appendChild(name);
			row.appendChild(meta);

			row.addEventListener("click", () => {
				setMode("repoSessions", cwd);
			});

			sessionsList.appendChild(row);
		}
	}

	async function promptAddRepo() {
		const cwd = window.prompt("Repo path (absolute)", "");
		if (cwd === null) return;
		const trimmed = cwd.trim();
		if (!trimmed) return;
		try {
			await api.postJson("/api/repos", { cwd: trimmed });
			void refresh();
		} catch (error) {
			onNotice(error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function promptNewSessionRepo() {
		let repos = [];
		try {
			const data = await api.getJson("/api/repos");
			repos = Array.isArray(data.repos) ? data.repos : [];
		} catch (error) {
			onNotice(error instanceof Error ? error.message : String(error), "error");
			return;
		}

		if (repos.length === 0) {
			onNotice('No repos saved yet. Click "Repos" → "Add repo".', "info");
			setMode("repos");
			return;
		}

		if (repos.length === 1) {
			await startNewSessionInRepo(repos[0]);
			return;
		}

		const list = repos.slice(0, 20);
		const lines = list.map((p, i) => `${i + 1}) ${p}`);
		const picked = window.prompt(`New session: pick repo (number)\n\n${lines.join("\n")}`, "1");
		if (picked === null) return;
		const raw = picked.trim();
		if (!raw) return;
		if (!/^[0-9]+$/.test(raw)) {
			onNotice("Enter a number from the list.", "error");
			return;
		}
		const idx = Number.parseInt(raw, 10) - 1;
		if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) {
			onNotice("Invalid selection.", "error");
			return;
		}
		await startNewSessionInRepo(list[idx]);
	}

	async function startNewSessionInRepo(repoCwd) {
		if (!repoCwd || typeof repoCwd !== "string") return;
		const cwd = repoCwd.trim();
		if (!cwd) return;
		const result = await api.postJson("/api/sessions", { clientId, cwd });
		onSessionIdSelected(result.sessionId);
		setOpen(false);
		setMode("active");
	}

	async function refresh() {
		try {
			if (mode === "repos") {
				const data = await api.getJson("/api/repos");
				const repos = Array.isArray(data.repos) ? data.repos : [];
				renderRepos(repos);
				return;
			}

			if (mode === "repoSessions") {
				if (!selectedRepoCwd) {
					renderSessions([]);
					return;
				}
				const qs = new URLSearchParams({ cwd: selectedRepoCwd });
				const data = await api.getJson(`/api/sessions?${qs.toString()}`);
				const raw = Array.isArray(data.sessions) ? data.sessions : [];
				const filtered = raw.filter(shouldShowSessionInLists);
				renderSessions(filtered, "repoSessions");
				return;
			}

			const data = await api.getJson("/api/active-sessions");
			const raw = Array.isArray(data.sessions) ? data.sessions : [];
			renderSessions(raw, "active");
		} catch (error) {
			sessionsList.innerHTML = "";
			const row = document.createElement("div");
			row.className = "si";
			const name = document.createElement("div");
			name.className = "si-name";
			name.textContent = "Failed to load sidebar";
			const meta = document.createElement("div");
			meta.className = "si-meta";
			meta.textContent = error instanceof Error ? error.message : String(error);
			row.appendChild(name);
			row.appendChild(meta);
			sessionsList.appendChild(row);
		}
	}

	updateHeader();

	return {
		setOpen,
		toggleOpen,
		setMode,
		updateHeader,
		refresh,
		highlightSessionRow,
	};
}

