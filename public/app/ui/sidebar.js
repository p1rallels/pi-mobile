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

function setSidebarButton(btn, icon, label) {
	if (!btn) return;
	btn.innerHTML = `${icon}<span class="txt">${label}</span>`;
	btn.classList.remove("hidden", "wide");
	btn.classList.toggle("positive", label.toLowerCase().includes("new") || label.toLowerCase().includes("add"));
}

function escapeHtml(text) {
	return String(text)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

/** The label for a session another process may still be writing, or "" when pi-web hosts it or its turn closed. */
export function elsewhereLabel(s) {
	const elsewhere = s && typeof s.elsewhere === "object" ? s.elsewhere : null;
	if (!elsewhere || s.isRunning) return "";
	if (elsewhere.state === "running") return "running elsewhere";
	if (elsewhere.state === "quiet") return `running elsewhere, quiet ${formatRelativeTime(elsewhere.lastWrite).replace(" ago", "")}`;
	if (elsewhere.state === "stopped") return "stopped mid-turn";
	return "";
}

function currentOrigin() {
	return new URL(window.location.href).origin;
}

function hostOrigin(host) {
	try {
		return new URL(host.url).origin;
	} catch {
		return "";
	}
}

/** @param {string | null | undefined} cwd */
const folderName = (cwd) => (cwd ? (cwd.split("/").filter(Boolean).at(-1) ?? cwd) : "terminal");

/**
 * The phone's menu: hosts, the sessions running here and the host's terminals. New opens the launcher sheet (pick a
 * folder, then a session, a new session or a new terminal).
 * `terminals` lists the host's shells (null: none on this host, or turned off) and opens one; without it there is no
 * terminals section.
 */
export function createSidebar({
	sessionsList,
	sidebar,
	sidebarOverlay,
	sidebarLabel,
	btnSidebarLeft,
	btnSidebarRight,
	onNotice,
	getActiveSessionId,
	onSelectSession,
	api,
	getHosts = () => [],
	getActiveHost = () => null,
	onSelectHost = () => {},
	onOpenMenu = () => {},
	terminals = null,
}) {
	let isOpen = false;

	function setOpen(open) {
		if (!sidebar) return;
		const opening = Boolean(open) && !isOpen;
		isOpen = Boolean(open);
		if (isOpen) {
			sidebar.classList.add("open");
			if (sidebarOverlay) sidebarOverlay.classList.add("open");
			if (opening) void refresh();
		} else {
			sidebar.classList.remove("open");
			if (sidebarOverlay) sidebarOverlay.classList.remove("open");
		}
	}

	function toggleOpen() {
		setOpen(!isOpen);
	}

	function updateHeader() {
		if (!sidebarLabel || !btnSidebarLeft || !btnSidebarRight) return;
		sidebarLabel.textContent = "Menu";
		sidebarLabel.title = "";
		setSidebarButton(btnSidebarLeft, ICON_PLUS, "New");
		setSidebarButton(btnSidebarRight, "", "");
		btnSidebarLeft.classList.add("wide");
		btnSidebarRight.classList.add("hidden");
		btnSidebarRight.onclick = null;
		btnSidebarLeft.onclick = () => {
			setOpen(false);
			onOpenMenu();
		};
	}

	function highlightSessionRow(sessionId) {
		sessionsList.querySelectorAll(".si").forEach((row) => {
			row.classList.toggle("active", row.dataset.sessionId === sessionId);
		});
	}

	function appendSectionLabel(label) {
		const row = document.createElement("div");
		row.className = "section-title";
		row.textContent = label;
		sessionsList.appendChild(row);
	}

	function createHostRow(host, activeOrigin) {
		const origin = hostOrigin(host);
		if (!origin) return null;
		const row = document.createElement("div");
		row.className = `si${origin === activeOrigin ? " active" : ""}`;
		row.dataset.hostId = typeof host.id === "string" ? host.id : origin;

		const name = document.createElement("div");
		name.className = "si-name";
		const label = (typeof host.label === "string" && host.label.trim()) || (typeof host.id === "string" && host.id.trim()) || origin;
		name.textContent = label;
		name.title = origin;

		const meta = document.createElement("div");
		meta.className = "si-meta";
		meta.textContent = origin === activeOrigin ? "current host" : origin;

		row.appendChild(name);
		row.appendChild(meta);
		row.addEventListener("click", () => {
			if (origin === activeOrigin) return;
			void onSelectHost(host);
		});
		return row;
	}

	function renderHosts(hosts) {
		const activeHost = getActiveHost();
		const activeOrigin = activeHost && typeof activeHost.url === "string" ? hostOrigin(activeHost) : currentOrigin();
		const enabled = hosts.filter((host) => host && typeof host === "object" && host.enabled !== false && typeof host.url === "string");
		if (enabled.length === 0) return;
		appendSectionLabel("Hosts");
		const hostScroll = document.createElement("div");
		hostScroll.className = "host-scroll";
		for (const host of enabled) {
			const row = createHostRow(host, activeOrigin);
			if (row) hostScroll.appendChild(row);
		}
		sessionsList.appendChild(hostScroll);
		appendSectionLabel("Active Sessions");
	}

	function renderSessions(sessions) {
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
			const elsewhere = elsewhereLabel(s);
			const rel = formatRelativeTime(elsewhere ? s.elsewhere.lastWrite : s.modified);
			const cwd = escapeHtml(typeof s.forkLabel === "string" && s.forkLabel ? s.forkLabel : s.cwd);
			meta.title = s.cwd;
			if (elsewhere) {
				meta.innerHTML = `${rel} · <span class="si-elsewhere ${escapeHtml(s.elsewhere.state)}">${escapeHtml(elsewhere)}</span> · ${cwd}`;
			} else {
				meta.innerHTML = `${rel} · ${cwd}${s.isRunning ? ` · <span class="si-run">running</span>` : ""}`;
			}

			row.appendChild(name);
			row.appendChild(meta);

			row.addEventListener("click", () => {
				highlightSessionRow(s.id);
				void (async () => {
					try {
						await onSelectSession(s);
					} catch (error) {
						onNotice(error instanceof Error ? error.message : String(error), "error");
					}
				})();
			});

			sessionsList.appendChild(row);
		}
	}

	/** @param {string} label @param {string} metaText @param {() => void} onClick */
	function appendRow(label, metaText, onClick) {
		const row = document.createElement("div");
		row.className = "si";
		const name = document.createElement("div");
		name.className = "si-name";
		name.textContent = label;
		name.title = label;
		const meta = document.createElement("div");
		meta.className = "si-meta";
		meta.textContent = metaText;
		row.appendChild(name);
		row.appendChild(meta);
		row.addEventListener("click", () => {
			setOpen(false);
			onClick();
		});
		sessionsList.appendChild(row);
		return row;
	}

	/** The host's shells, newest last, then a new one in the home folder. */
	function renderTerminals(list) {
		appendSectionLabel("Terminals");
		for (const info of list) {
			if (typeof info?.id !== "string") continue;
			const cwd = typeof info.cwd === "string" ? info.cwd : null;
			const title = typeof info.title === "string" && info.title.trim() ? info.title.trim() : null;
			const opened = Number.isFinite(info.createdAt) ? `opened ${formatRelativeTime(new Date(info.createdAt).toISOString())} · ` : "";
			const row = appendRow(title || folderName(cwd), `${opened}${cwd ?? ""}`, () => terminals.open({ terminalId: info.id, cwd, title }));
			row.dataset.terminalId = info.id;
		}
		const fresh = appendRow("+ new terminal", "in your home folder (New picks a folder)", () => terminals.open({ terminalId: null, cwd: "~" }));
		fresh.classList.add("si-new-terminal");
	}

	async function refresh() {
		try {
			const [sessionData, terminalList] = await Promise.all([api.getJson("/api/active-sessions"), terminals ? terminals.list() : null]);
			const hosts = getHosts();
			const raw = Array.isArray(sessionData.sessions) ? sessionData.sessions : [];
			sessionsList.innerHTML = "";
			renderHosts(hosts);
			renderSessions(raw);
			if (terminals && Array.isArray(terminalList)) renderTerminals(terminalList);
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
		isOpen: () => isOpen,
		setOpen,
		toggleOpen,
		updateHeader,
		refresh,
		highlightSessionRow,
	};
}
