// The laptop canvas map (which sessions and terminals sit where), one per pi-web host so every browser sees the
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

interface CanvasLayoutRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface CanvasLayoutSessionTile extends CanvasLayoutRect {
	sessionId: string;
	path: string | null;
	title: string | null;
}

/** A terminal tile: its shell (gone after a restart, when the tile opens a new one in `cwd`) and its folder. */
export interface CanvasLayoutTerminalTile extends CanvasLayoutRect {
	kind: "terminal";
	terminalId: string;
	cwd: string | null;
	title: string | null;
}

export type CanvasLayoutTile = CanvasLayoutSessionTile | CanvasLayoutTerminalTile;

export interface CanvasLayout {
	version: 1;
	tiles: CanvasLayoutTile[];
	updatedAt: string | null;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const finiteOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const boundedString = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

function parseRect(tile: Record<string, unknown>): CanvasLayoutRect {
	return {
		x: Math.round(clamp(finiteOr(tile.x, 0), -MAX_COORD, MAX_COORD)),
		y: Math.round(clamp(finiteOr(tile.y, 0), -MAX_COORD, MAX_COORD)),
		w: Math.round(clamp(finiteOr(tile.w, DEFAULT_W), MIN_W, MAX_W)),
		h: Math.round(clamp(finiteOr(tile.h, DEFAULT_H), MIN_H, MAX_H)),
	};
}

const parseTitle = (value: unknown): string | null => (typeof value === "string" && value ? value.slice(0, 200) : null);

function parseTile(raw: unknown): CanvasLayoutTile | null {
	if (!raw || typeof raw !== "object") return null;
	const tile = raw as Record<string, unknown>;
	if (tile.kind === "terminal") {
		const terminalId = boundedString(tile.terminalId, 200);
		if (!terminalId) return null;
		return { kind: "terminal", terminalId, cwd: boundedString(tile.cwd, 4096), title: parseTitle(tile.title), ...parseRect(tile) };
	}
	const sessionId = boundedString(tile.sessionId, 200);
	if (!sessionId) return null;
	return { sessionId, path: boundedString(tile.path, 4096), title: parseTitle(tile.title), ...parseRect(tile) };
}

const tileKey = (tile: CanvasLayoutTile): string => ("kind" in tile ? `terminal:${tile.terminalId}` : `session:${tile.sessionId}`);

/** Whatever was stored or sent, a layout with at most one tile per session or terminal and sane geometry. */
export function parseCanvasLayout(raw: unknown): CanvasLayout {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const list = Array.isArray(record.tiles) ? record.tiles : [];
	const seen = new Set<string>();
	const tiles: CanvasLayoutTile[] = [];
	for (const entry of list) {
		if (tiles.length >= CANVAS_LAYOUT_MAX_TILES) break;
		const tile = parseTile(entry);
		if (!tile || seen.has(tileKey(tile))) continue;
		seen.add(tileKey(tile));
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
