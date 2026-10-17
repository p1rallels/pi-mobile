// Where the canvas map lives. The layout (which sessions and terminals sit where) belongs to the host: GET/PUT
// /api/canvas, so every browser sees the same map. Hosts without that endpoint (older pi-web) fall
// back to this browser's localStorage. The camera is always per device and per host.
import { sanitizeCamera } from "./camera.js";
import { sanitizeRect } from "./layout.js";

const LAYOUT_KEY = "pi-web.canvas.layout:";
const CAMERA_KEY = "pi-web.canvas.camera:";
const MAX_TILES = 500;

/** @typedef {{ sessionId: string, path: string | null, title: string | null, x: number, y: number, w: number, h: number }} SessionLayoutTile */
/** @typedef {{ kind: "terminal", terminalId: string, cwd: string | null, title: string | null, x: number, y: number, w: number, h: number }} TerminalLayoutTile */
/** @typedef {SessionLayoutTile | TerminalLayoutTile} LayoutTile */
/** @typedef {{ tiles: LayoutTile[] }} Layout */

/** @param {unknown} value */
const text = (value) => (typeof value === "string" && value ? value : null);

/** @param {any} tile @returns {LayoutTile | null} */
function parseTile(tile) {
	if (!tile || typeof tile !== "object") return null;
	const title = text(tile.title)?.slice(0, 200) ?? null;
	if (tile.kind === "terminal") {
		const terminalId = text(tile.terminalId);
		return terminalId ? { kind: "terminal", terminalId, cwd: text(tile.cwd), title, ...sanitizeRect(tile) } : null;
	}
	const sessionId = text(tile.sessionId);
	return sessionId ? { sessionId, path: text(tile.path), title, ...sanitizeRect(tile) } : null;
}

/** @param {LayoutTile} tile */
const tileKey = (tile) => ("kind" in tile ? `terminal:${tile.terminalId}` : `session:${tile.sessionId}`);

/** @param {unknown} raw @returns {Layout} */
export function parseLayout(raw) {
	const list = raw && typeof raw === "object" && Array.isArray(/** @type {any} */ (raw).tiles) ? /** @type {any[]} */ (/** @type {any} */ (raw).tiles) : [];
	const seen = new Set();
	/** @type {LayoutTile[]} */
	const tiles = [];
	for (const entry of list.slice(0, MAX_TILES)) {
		const tile = parseTile(entry);
		if (!tile || seen.has(tileKey(tile))) continue;
		seen.add(tileKey(tile));
		tiles.push(tile);
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

/**
 * The host's layout over /api/canvas, falling back to localStorage when the host doesn't have it.
 * @param {{ getBaseUrl: () => string, getJson: (path: string) => Promise<any>, putJson: (path: string, body: unknown) => Promise<any> }} api
 * @param {Pick<Storage, "getItem" | "setItem">} storage
 * @returns {{ load: () => Promise<Layout>, save: (layout: Layout) => Promise<void> }}
 */
export function createLayoutStore(api, storage) {
	const local = createLocalLayoutStore(storage, api.getBaseUrl());
	let serverless = false;
	/** @param {unknown} error */
	const missingEndpoint = (error) => Boolean(error && typeof error === "object" && /** @type {any} */ (error).status === 404);
	return {
		async load() {
			if (serverless) return local.load();
			try {
				return parseLayout(await api.getJson("/api/canvas"));
			} catch (error) {
				if (!missingEndpoint(error)) throw error;
				serverless = true;
				return local.load();
			}
		},
		async save(layout) {
			if (serverless) return local.save(layout);
			await api.putJson("/api/canvas", parseLayout(layout));
		},
	};
}
