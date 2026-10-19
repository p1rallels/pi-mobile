/**
 * The host's summary of one session (its file, whether it runs here or in another pi), found by id in any folder,
 * or null when the host has no such session (a msg CLI identity, or a session on another machine).
 * @param {{ getJson: (url: string) => Promise<any> }} api @param {string} id
 */
export async function findSession(api, id) {
	if (!id) return null;
	const data = await api.getJson(`/api/sessions?${new URLSearchParams({ id }).toString()}`);
	const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
	return sessions.find((session) => session && session.id === id) ?? null;
}
