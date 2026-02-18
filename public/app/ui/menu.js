function normalizeForSearch(text) {
	return String(text || "")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "");
}

function fuzzyCharsMatch(query, hay) {
	const q = normalizeForSearch(query);
	const h = normalizeForSearch(hay);
	if (!q) return true;
	let qi = 0;
	for (let i = 0; i < h.length && qi < q.length; i += 1) {
		if (h[i] === q[qi]) qi += 1;
	}
	return qi === q.length;
}

function fuzzyMatch(query, hay) {
	const tokens = String(query || "")
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (tokens.length === 0) return true;
	const h = String(hay || "").toLowerCase();
	return tokens.every((t) => h.includes(t) || fuzzyCharsMatch(t, h));
}

export function createMenu({
	menuOverlay,
	menuScrim,
	menuPanel,
	btnModel,
	btnThinking,
	api,
	clientId,
	onNotice,
	getActiveSessionId,
	getActiveState,
}) {
	let open = false;
	let cachedModels = null;
	let cachedModelsAtMs = 0;

	function close() {
		if (!menuOverlay || !menuPanel) return;
		open = false;
		menuOverlay.classList.remove("open");
		menuPanel.innerHTML = "";
	}

	function position(anchor) {
		if (!menuPanel) return;
		const rect = anchor.getBoundingClientRect();
		const margin = 8;

		// Clamp after render so we can read panel size.
		requestAnimationFrame(() => {
			const panelRect = menuPanel.getBoundingClientRect();
			// Default: open below, centered to anchor.
			let left = rect.left + rect.width / 2 - panelRect.width / 2;
			let top = rect.bottom + 6;

			const maxLeft = window.innerWidth - panelRect.width - margin;
			const maxTop = window.innerHeight - panelRect.height - margin;

			left = Math.max(margin, Math.min(left, maxLeft));
			top = Math.max(margin, Math.min(top, maxTop));

			// If it doesn't fit below, try above.
			if (rect.bottom + 6 + panelRect.height > window.innerHeight - margin && rect.top - 6 - panelRect.height >= margin) {
				top = rect.top - 6 - panelRect.height;
			}

			menuPanel.style.left = `${left}px`;
			menuPanel.style.top = `${top}px`;
		});
	}

	function openMenu(anchor, build) {
		if (!menuOverlay || !menuPanel) return;
		open = true;
		menuOverlay.classList.add("open");
		menuPanel.innerHTML = "";
		menuPanel.style.left = "0px";
		menuPanel.style.top = "0px";
		build(menuPanel);
		position(anchor);
	}

	async function getAvailableModels() {
		if (cachedModels && Date.now() - cachedModelsAtMs < 30_000) return cachedModels;
		const data = await api.getJson("/api/models");
		const models = Array.isArray(data.models) ? data.models : [];
		cachedModels = models;
		cachedModelsAtMs = Date.now();
		return models;
	}

	async function setModel(provider, modelId) {
		const activeSessionId = getActiveSessionId();
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
			type: "set_model",
			clientId,
			provider,
			modelId,
		});
	}

	async function setThinkingLevel(level) {
		const activeSessionId = getActiveSessionId();
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
			type: "set_thinking_level",
			clientId,
			level,
		});
	}

	async function openModelMenu() {
		if (!btnModel || btnModel.disabled) return;
		openMenu(btnModel, (panel) => {
			const hdr = document.createElement("div");
			hdr.className = "menu-hdr";
			const title = document.createElement("div");
			title.className = "menu-title";
			title.textContent = "Model";
			const refresh = document.createElement("button");
			refresh.className = "menu-mini";
			refresh.textContent = "Refresh";
			refresh.addEventListener("click", async () => {
				cachedModels = null;
				cachedModelsAtMs = 0;
				await openModelMenu();
			});
			hdr.appendChild(title);
			hdr.appendChild(refresh);

			const body = document.createElement("div");
			body.className = "menu-body";

			const search = document.createElement("input");
			search.className = "menu-search";
			search.placeholder = "Search models…";

			const list = document.createElement("div");
			list.className = "menu-list";
			list.textContent = "Loading…";

			const render = (models, query) => {
				list.innerHTML = "";
				const activeState = getActiveState();
				const currentKey = activeState?.model ? `${activeState.model.provider}/${activeState.model.id}` : null;
				const filtered = models.filter((m) => fuzzyMatch(query, `${m.provider}/${m.id} ${m.name || ""}`));
				const shown = filtered.slice(0, 200);
				if (shown.length === 0) {
					const empty = document.createElement("div");
					empty.className = "si-meta";
					empty.textContent = "No matches.";
					list.appendChild(empty);
					return;
				}
				for (const m of shown) {
					const item = document.createElement("div");
					item.className = "menu-item";
					const key = `${m.provider}/${m.id}`;
					if (currentKey && key === currentKey) item.classList.add("active");

					const primary = document.createElement("div");
					primary.className = "primary";
					primary.textContent = key;
					const secondary = document.createElement("div");
					secondary.className = "secondary";
					secondary.textContent = m.name || (m.reasoning ? "reasoning" : "");

					item.appendChild(primary);
					item.appendChild(secondary);
					item.addEventListener("click", async () => {
						try {
							await setModel(m.provider, m.id);
							close();
						} catch (error) {
							onNotice(error instanceof Error ? error.message : String(error), "error");
						}
					});
					list.appendChild(item);
				}
			};

			search.addEventListener("input", async () => {
				try {
					const models = await getAvailableModels();
					render(models, search.value);
				} catch (error) {
					list.textContent = error instanceof Error ? error.message : String(error);
				}
			});

			body.appendChild(search);
			body.appendChild(list);

			panel.appendChild(hdr);
			panel.appendChild(body);

			(async () => {
				try {
					const models = await getAvailableModels();
					render(models, "");
					position(btnModel);
					search.focus();
				} catch (error) {
					list.textContent = error instanceof Error ? error.message : String(error);
				}
			})();
		});
	}

	function openThinkingMenu() {
		if (!btnThinking || btnThinking.disabled) return;
		openMenu(btnThinking, (panel) => {
			const hdr = document.createElement("div");
			hdr.className = "menu-hdr";
			const title = document.createElement("div");
			title.className = "menu-title";
			title.textContent = "Thinking level";
			const closeBtn = document.createElement("button");
			closeBtn.className = "menu-mini";
			closeBtn.textContent = "Close";
			closeBtn.addEventListener("click", () => close());
			hdr.appendChild(title);
			hdr.appendChild(closeBtn);

			const body = document.createElement("div");
			body.className = "menu-body";

			const list = document.createElement("div");
			list.className = "menu-list";

			const activeState = getActiveState();
			const current = activeState?.thinkingLevel ? String(activeState.thinkingLevel) : "off";
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
			for (const level of levels) {
				const item = document.createElement("div");
				item.className = "menu-item";
				if (level === current) item.classList.add("active");
				const primary = document.createElement("div");
				primary.className = "primary";
				primary.textContent = level;
				item.appendChild(primary);
				item.addEventListener("click", async () => {
					try {
						await setThinkingLevel(level);
						close();
					} catch (error) {
						onNotice(error instanceof Error ? error.message : String(error), "error");
					}
				});
				list.appendChild(item);
			}

			body.appendChild(list);
			panel.appendChild(hdr);
			panel.appendChild(body);
		});
	}

	if (menuScrim) menuScrim.addEventListener("click", () => close());

	return {
		close,
		isOpen: () => open,
		openModelMenu,
		openThinkingMenu,
	};
}

