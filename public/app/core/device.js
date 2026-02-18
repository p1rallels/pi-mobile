export function isPhoneLike() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return (
		window.matchMedia("(hover: none) and (pointer: coarse) and (max-width: 740px)").matches ||
		window.matchMedia("(hover: none) and (pointer: coarse) and (max-height: 740px)").matches
	);
}

