// The laptop canvas map (which sessions sit where), one per pi-web host so every browser sees the
// same layout. Stored in agentDir/pi-web/canvas.json with atomic writes; last write wins.
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";

export const CANVAS_LAYOUT_MAX_TILES = 500;
export const CANVAS_LAYOUT_BODY_LIMIT = 256 * 1024;
const MIN_W = 320;
const MIN_H = 220;
const MAX_W = 4000;
const MAX_H = 3000;
const DEFAULT_W = 800;
const DEFAULT_H = 500;
const MAX_COORD = 10_000_000;

export interface CanvasLayoutTile {
	sessionId: string;
	path: string | null;
	title: string | null;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface CanvasLayout {
	version: 1;
	tiles: CanvasLayoutTile[];
	updatedAt: string | null;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const finiteOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const boundedString = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

function parseTile(raw: unknown): CanvasLayoutTile | null {
	if (!raw || typeof raw !== "object") return null;
	const tile = raw as Record<string, unknown>;
	const sessionId = boundedString(tile.sessionId, 200);
	if (!sessionId) return null;
	return {
		sessionId,
		path: boundedString(tile.path, 4096),
		title: typeof tile.title === "string" && tile.title ? tile.title.slice(0, 200) : null,
		x: Math.round(clamp(finiteOr(tile.x, 0), -MAX_COORD, MAX_COORD)),
		y: Math.round(clamp(finiteOr(tile.y, 0), -MAX_COORD, MAX_COORD)),
		w: Math.round(clamp(finiteOr(tile.w, DEFAULT_W), MIN_W, MAX_W)),
		h: Math.round(clamp(finiteOr(tile.h, DEFAULT_H), MIN_H, MAX_H)),
	};
}

/** Whatever was stored or sent, a layout with at most one tile per session and sane geometry. */
export function parseCanvasLayout(raw: unknown): CanvasLayout {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const list = Array.isArray(record.tiles) ? record.tiles : [];
	const seen = new Set<string>();
	const tiles: CanvasLayoutTile[] = [];
	for (const entry of list) {
		if (tiles.length >= CANVAS_LAYOUT_MAX_TILES) break;
		const tile = parseTile(entry);
		if (!tile || seen.has(tile.sessionId)) continue;
		seen.add(tile.sessionId);
		tiles.push(tile);
	}
	return { version: 1, tiles, updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null };
}

export function createCanvasLayoutStore(path: string, now: () => Date = () => new Date()) {
	let writes: Promise<unknown> = Promise.resolve();

	async function load(): Promise<CanvasLayout> {
		try {
			return parseCanvasLayout(await readPrivateJsonFile<unknown>(path));
		} catch (error) {
			if (isMissingFileError(error)) return { version: 1, tiles: [], updatedAt: null };
			throw error;
		}
	}

	/** Writes are serialized so concurrent saves from two browsers land whole, in arrival order. */
	function save(raw: unknown): Promise<CanvasLayout> {
		const layout: CanvasLayout = { ...parseCanvasLayout(raw), updatedAt: now().toISOString() };
		const write = writes.then(() => writePrivateJsonFile(path, layout));
		writes = write.catch(() => undefined);
		return write.then(() => layout);
	}

	return { load, save };
}
