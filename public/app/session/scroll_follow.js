const AT_BOTTOM_PX = 2;

export function remainingScroll(el) {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function nextPinnedState({ pinned, previousTop, top, remaining }) {
	if (remaining <= AT_BOTTOM_PX) return true;
	if (top < previousTop) return false;
	return pinned;
}

export function createScrollFollower({ scrollEl, pillEl = null }) {
	let pinned = true;
	let lastTop = scrollEl.scrollTop;

	function updatePill() {
		if (!pillEl) return;
		pillEl.hidden = pinned || remainingScroll(scrollEl) <= AT_BOTTOM_PX;
	}

	function jumpToBottom() {
		scrollEl.scrollTop = scrollEl.scrollHeight;
		lastTop = scrollEl.scrollTop;
	}

	function onScroll() {
		const top = scrollEl.scrollTop;
		pinned = nextPinnedState({ pinned, previousTop: lastTop, top, remaining: remainingScroll(scrollEl) });
		lastTop = top;
		updatePill();
	}

	function sync() {
		if (pinned) jumpToBottom();
		updatePill();
	}

	function pin() {
		pinned = true;
		sync();
	}

	function restore(top) {
		scrollEl.scrollTop = top;
		lastTop = scrollEl.scrollTop;
		updatePill();
	}

	scrollEl.addEventListener("scroll", onScroll, { passive: true });
	if (pillEl) pillEl.addEventListener("click", pin);

	return {
		sync,
		pin,
		restore,
		isPinned: () => pinned,
		getScrollTop: () => scrollEl.scrollTop,
	};
}
