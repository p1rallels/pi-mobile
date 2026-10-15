// The canvas HUD, top-right like Infinite's: zoom %, -, 1:1, +, fit, new tile, and a slot for the host switcher.

/** @typedef {ReturnType<import("./viewport.js").createViewport>} Viewport */

const ICONS = {
	out: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>',
	in: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
	fit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
	new: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 9v6M9 12h6"/></svg>',
};

/**
 * @param {Document} doc @param {string} act @param {string} title @param {string} html
 */
function button(doc, act, title, html) {
	const el = doc.createElement("button");
	el.type = "button";
	el.className = "cv-hud-btn";
	el.dataset.act = act;
	el.title = title;
	el.setAttribute("aria-label", title);
	el.innerHTML = html;
	return el;
}

/**
 * @param {{ root: HTMLElement, viewport: Viewport, onNewTile: () => void, onFit: () => void }} options
 */
export function createHud({ root, viewport, onNewTile, onFit }) {
	const doc = root.ownerDocument;
	const el = doc.createElement("div");
	el.className = "cv-hud";
	const zoom = doc.createElement("button");
	zoom.type = "button";
	zoom.className = "cv-hud-zoom";
	zoom.dataset.act = "reset";
	zoom.title = "Zoom level (click for 100%)";
	const sep = () => {
		const s = doc.createElement("span");
		s.className = "cv-hud-sep";
		return s;
	};
	const slot = doc.createElement("div");
	slot.className = "cv-hud-slot";
	el.append(
		zoom,
		sep(),
		button(doc, "out", "Zoom out", ICONS.out),
		button(doc, "reset", "Actual size", '<span class="cv-hud-one">1:1</span>'),
		button(doc, "in", "Zoom in", ICONS.in),
		button(doc, "fit", "Fit all tiles", ICONS.fit),
		sep(),
		button(doc, "new", "New tile", ICONS.new),
		slot,
	);
	el.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target.closest("[data-act]") : null;
		if (!(target instanceof HTMLElement) || !el.contains(target)) return;
		switch (target.dataset.act) {
			case "out":
				viewport.zoomStep(-1);
				break;
			case "in":
				viewport.zoomStep(1);
				break;
			case "reset":
				viewport.resetZoom();
				break;
			case "fit":
				onFit();
				break;
			case "new":
				onNewTile();
				break;
		}
	});
	root.append(el);

	let shown = -1;
	const unsubscribe = viewport.onChange((camera) => {
		const percent = Math.round(camera.scale * 100);
		if (percent === shown) return;
		shown = percent;
		zoom.textContent = `${percent}%`;
	});

	return {
		el,
		slot,
		destroy() {
			unsubscribe();
			el.remove();
		},
	};
}
