function appendBold(target, text) {
	const parts = String(text).split("**");
	const markerCount = parts.length - 1;
	if (markerCount === 0 || markerCount % 2 !== 0) {
		target.appendChild(document.createTextNode(String(text)));
		return;
	}

	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i];
		if (i % 2 === 0) {
			if (part) target.appendChild(document.createTextNode(part));
			continue;
		}
		const span = document.createElement("span");
		span.className = "bold";
		span.textContent = part;
		target.appendChild(span);
	}
}

function appendInlineMarkdown(target, text) {
	const chunks = String(text).split("`");
	const backtickCount = chunks.length - 1;
	if (backtickCount === 0 || backtickCount % 2 !== 0) {
		appendBold(target, text);
		return;
	}

	for (let i = 0; i < chunks.length; i += 1) {
		const chunk = chunks[i];
		if (i % 2 === 0) {
			if (chunk) appendBold(target, chunk);
		} else {
			const span = document.createElement("span");
			span.className = "ci";
			span.textContent = chunk;
			target.appendChild(span);
		}
		if (i < chunks.length - 1 && chunk.length === 0) {
			// Preserve empty chunks (e.g. "``") as literal backticks.
			// We already handled odd backtick counts above, so this is rare.
		}
	}
}

export function renderMarkdown(target, text) {
	target.innerHTML = "";

	const lines = String(text).split("\n");
	let inFence = false;
	let fenceLines = [];
	let textLines = [];

	const flushText = () => {
		if (textLines.length === 0) return;
		appendInlineMarkdown(target, textLines.join("\n"));
		textLines = [];
	};

	const flushFence = () => {
		const pre = document.createElement("div");
		pre.className = "codeblock";
		const code = document.createElement("code");
		code.textContent = fenceLines.join("\n");
		pre.appendChild(code);
		target.appendChild(pre);
		fenceLines = [];
	};

	for (const line of lines) {
		if (!inFence) {
			if (line.startsWith("```")) {
				flushText();
				inFence = true;
				fenceLines = [];
				continue;
			}
			textLines.push(line);
			continue;
		}

		if (line.startsWith("```")) {
			flushFence();
			inFence = false;
			continue;
		}
		fenceLines.push(line);
	}

	if (inFence) {
		flushFence();
	} else {
		flushText();
	}
}

