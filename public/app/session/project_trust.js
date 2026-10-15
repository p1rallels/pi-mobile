/** The select dialog for a PI_WEB_PROJECT_TRUST=ask prompt, worded like the pi cli. */
export function trustPromptRequest(prompt) {
	return {
		method: "select",
		title: `Trust project folder?\n${prompt.cwd}`,
		message: "This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.",
		options: prompt.options.map((option) => option.label),
	};
}

export function choiceForLabel(prompt, label) {
	return prompt.options.find((option) => option.label === label)?.choice ?? null;
}

/** Starts or resumes a session, answering the server's project trust prompt first when it asks for one. */
export async function createSessionWithTrust({ api, payload, ask }) {
	try {
		return await api.postJson("/api/sessions", payload);
	} catch (error) {
		const prompt = error && error.status === 409 ? error.body?.projectTrust : null;
		if (!prompt || typeof prompt.cwd !== "string" || !Array.isArray(prompt.options)) throw error;
		const choice = await ask(prompt);
		if (!choice) throw new Error("Not opened: project trust was not decided.");
		return api.postJson("/api/sessions", { ...payload, projectTrust: choice });
	}
}
