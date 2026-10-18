// The phone's menu: the canvas's launcher (a folder from the saved ones or a typed /path or ~/path, then a session in
// it, a new session or a new terminal) on a full screen sheet. It opens from the sidebar's New and after /quit.
import { createLauncher } from "../canvas/launcher.js";

/**
 * @param {{
 *   doc: Document,
 *   api: any,
 *   getClientId: () => string | null,
 *   canOpenTerminal: () => boolean,
 *   onPick: (pick: import("../canvas/launcher.js").LauncherPick) => void,
 * }} options
 */
export function createLauncherSheet({ doc, api, getClientId, canOpenTerminal, onPick }) {
	const view = /** @type {Window} */ (doc.defaultView);
	const root = doc.createElement("div");
	root.className = "ph-launch";
	root.hidden = true;
	const closeBtn = doc.createElement("button");
	closeBtn.type = "button";
	closeBtn.className = "ph-term-hbtn";
	closeBtn.textContent = "×";
	closeBtn.setAttribute("aria-label", "Close the menu");
	doc.body.append(root);

	/** @type {ReturnType<typeof createLauncher> | null} */
	let launcher = null;

	/** The sheet follows the part of the page iOS leaves visible above its keyboard. */
	function fitViewport() {
		const viewport = view.visualViewport;
		if (root.hidden || !viewport) return;
		root.style.top = `${viewport.offsetTop}px`;
		root.style.height = `${viewport.height}px`;
	}

	function close() {
		if (!launcher) return;
		const current = launcher;
		launcher = null;
		current.destroy();
		root.replaceChildren();
		root.hidden = true;
		root.style.top = "";
		root.style.height = "";
	}

	/** At the directory step, with the cursor in the search box. */
	function open() {
		if (launcher) {
			launcher.focus();
			return;
		}
		root.hidden = false;
		fitViewport();
		launcher = createLauncher({
			doc,
			api,
			getClientId,
			isOnCanvas: () => false,
			canOpenTerminal,
			touch: true,
			onPick: (pick) => {
				close();
				onPick(pick);
			},
			onClose: () => close(),
		});
		launcher.el.querySelector(".cv-launch-head")?.append(closeBtn);
		root.replaceChildren(launcher.el);
		launcher.focus();
	}

	closeBtn.addEventListener("click", () => close());
	view.visualViewport?.addEventListener("resize", fitViewport);
	view.visualViewport?.addEventListener("scroll", fitViewport);

	return {
		open,
		close,
		isOpen: () => launcher !== null,
		/** Esc steps back, and closes the sheet from the directory step. @param {KeyboardEvent} event */
		handleEscape(event) {
			launcher?.handleEscape(event);
		},
	};
}
