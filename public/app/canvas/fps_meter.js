// Dev frame meter (?fps=1): fps, p95 frame time over the last ~2s and long tasks, from rAF deltas.

const WINDOW = 120;
const PAINT_MS = 500;

/** @param {number[]} sorted @param {number} q */
const quantile = (sorted, q) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);

/** @param {HTMLElement} parent */
export function createFpsMeter(parent) {
	const doc = parent.ownerDocument;
	const view = /** @type {Window} */ (doc.defaultView);
	const el = doc.createElement("div");
	el.className = "cv-fps";
	parent.append(el);
	const deltas = new Float64Array(WINDOW);
	let count = 0;
	let index = 0;
	let last = 0;
	let lastPaint = 0;
	let longTasks = 0;
	let longestTask = 0;
	let raf = 0;
	/** @type {PerformanceObserver | null} */
	let observer = null;
	try {
		observer = new view.PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				longTasks += 1;
				longestTask = Math.max(longestTask, entry.duration);
			}
		});
		observer.observe({ type: "longtask", buffered: false });
	} catch {
		observer = null;
	}

	function stats() {
		const window = Array.from(deltas.subarray(0, count)).sort((a, b) => a - b);
		const mean = window.reduce((sum, d) => sum + d, 0) / Math.max(window.length, 1);
		return { fps: mean > 0 ? 1000 / mean : 0, p50: quantile(window, 0.5), p95: quantile(window, 0.95), max: window.at(-1) ?? 0, longTasks, longestTask };
	}

	/** @param {number} now */
	function tick(now) {
		if (last) {
			deltas[index] = now - last;
			index = (index + 1) % WINDOW;
			count = Math.min(count + 1, WINDOW);
		}
		last = now;
		if (now - lastPaint > PAINT_MS) {
			lastPaint = now;
			const s = stats();
			el.textContent = `${s.fps.toFixed(0)} fps · p95 ${s.p95.toFixed(1)}ms · long ${s.longTasks}`;
		}
		raf = view.requestAnimationFrame(tick);
	}
	raf = view.requestAnimationFrame(tick);

	return {
		el,
		stats,
		destroy() {
			view.cancelAnimationFrame(raf);
			observer?.disconnect();
			el.remove();
		},
	};
}
