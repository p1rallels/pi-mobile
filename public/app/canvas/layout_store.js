// Where the canvas map lives. The layout (which sessions sit where) is per host; until the server
// endpoint lands (m-d9da) it is kept in this browser's localStorage behind the same load/save shape.
// The camera is always per device and per host.
import { sanitizeCamera } from "./camera.js";
import { sanitizeRect } from "./layout.js";

const LAYOUT_KEY = "pi-web.canvas.layout:";
const CAMERA_KEY = "pi-web.canvas.camera:";
const MAX_TILES = 500;

/** @typedef {{ sessionId: string, path: string | null, title: string | null, x: number, y: number, w: number, h: number }} LayoutTile */
/** @typedef {{ tiles: LayoutTile[] }} Layout */

/** @param {unknown} raw @returns {Layout} */
export function parseLayout(raw) {
	const list = raw && typeof raw === "object" && Array.isArray(/** @type {any} */ (raw).tiles) ? /** @type {any[]} */ (/** @type {any} */ (raw).tiles) : [];
	const seen = new Set();
	/** @type {LayoutTile[]} */
	const tiles = [];
	for (const tile of list.slice(0, MAX_TILES)) {
		if (!tile || typeof tile !== "object" || typeof tile.sessionId !== "string" || !tile.sessionId || seen.has(tile.sessionId)) continue;
		seen.add(tile.sessionId);
		tiles.push({
			sessionId: tile.sessionId,
			path: typeof tile.path === "string" && tile.path ? tile.path : null,
			title: typeof tile.title === "string" && tile.title ? tile.title.slice(0, 200) : null,
			...sanitizeRect(tile),
		});
	}
	return { tiles };
}

/**
 * @param {Pick<Storage, "getItem" | "setItem">} storage @param {string} origin
 * @returns {{ load: () => Promise<Layout>, save: (layout: Layout) => Promise<void> }}
 */
export function createLocalLayoutStore(storage, origin) {
	const key = `${LAYOUT_KEY}${origin}`;
	return {
		async load() {
			try {
				return parseLayout(JSON.parse(storage.getItem(key) ?? "null"));
			} catch {
				return { tiles: [] };
			}
		},
		async save(layout) {
			try {
				storage.setItem(key, JSON.stringify(parseLayout(layout)));
			} catch {
				// storage full or disabled: the map just isn't kept
			}
		},
	};
}

/** @param {Pick<Storage, "getItem">} storage @param {string} origin */
export function loadCamera(storage, origin) {
	try {
		const raw = storage.getItem(`${CAMERA_KEY}${origin}`);
		return raw ? sanitizeCamera(JSON.parse(raw)) : null;
	} catch {
		return null;
	}
}

/** @param {Pick<Storage, "setItem">} storage @param {string} origin @param {import("./camera.js").Camera} camera */
export function saveCamera(storage, origin, camera) {
	try {
		storage.setItem(`${CAMERA_KEY}${origin}`, JSON.stringify(sanitizeCamera(camera)));
	} catch {
		// not kept
	}
}
