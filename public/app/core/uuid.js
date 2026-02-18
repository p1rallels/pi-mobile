function pseudoUUID() {
	const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
	return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

export function safeRandomUUID() {
	try {
		if (typeof crypto !== "undefined") {
			if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
			if (typeof crypto.getRandomValues === "function") {
				const bytes = new Uint8Array(16);
				crypto.getRandomValues(bytes);
				// RFC 4122 version 4
				bytes[6] = (bytes[6] & 0x0f) | 0x40;
				bytes[8] = (bytes[8] & 0x3f) | 0x80;
				const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
				return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
					.slice(8, 10)
					.join("")}-${hex.slice(10, 16).join("")}`;
			}
		}
	} catch {
		// ignore
	}
	return pseudoUUID();
}

