// Seeded fake session text for the canvas mock: titles, prompts, prose with code lines, tool output.

/** @param {number} seed @returns {() => number} */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const REPOS = ["pi-web", "infinite", "libs", "cc", "pi-mono", "marbles", "lookup", "pdoom"];
export const TITLES = ["canvas camera + tests", "fix reconnect cursor", "sse batching", "layout endpoint", "glow tuning", "tool output windowing", "launcher flow", "perf harness", "review sidebar", "release notes"];
export const MODELS = ["opus 5.5 · max", "opus 5.5 · high", "sonnet 5 · medium", "gpt-5.5 · high"];
export const USER_ASKS = ["make the glow subtler", "why does the tile blur after zooming?", "run the perf harness again", "ship it", "add a test for the launcher", "check the reconnect path"];
const WORDS =
	"the camera keeps one transform on the world layer so tiles never reflow while zooming and only the streaming block re-renders per frame which keeps the main thread quiet even with ten panes working at once while offscreen tiles drop their streams".split(
		" ",
	);
const CODE = [
	"const next = zoomAt(camera, anchor, scale);",
	"world.style.transform = cameraTransform(next);",
	"if (!tile.visible) return;",
	"await runtime.attachIfNeeded(sessionId);",
	"for (const tile of dirty) writeGeometry(tile);",
	"expect(screenToWorld(zoomed, anchor)).toEqual(before);",
];

/** @param {() => number} rand */
export function createTextSource(rand) {
	/** @template T @param {readonly T[]} list @returns {T} */
	const pick = (list) => list[Math.floor(rand() * list.length)];
	const token = () => {
		const roll = rand();
		if (roll < 0.04) return `\n${pick(CODE)}\n`;
		if (roll < 0.08) return "\n\n";
		return `${pick(WORDS)} `;
	};
	/** @param {number} chars */
	const sentence = (chars) => {
		let text = "";
		while (text.length < chars) text += token();
		return text.trim();
	};
	const codeLine = () => pick(CODE);
	const toolLines = () => Array.from({ length: 2 + Math.floor(rand() * 5) }, () => (rand() < 0.5 ? pick(CODE) : sentence(40)));
	return { rand, pick, token, sentence, codeLine, toolLines };
}
