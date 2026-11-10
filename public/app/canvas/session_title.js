/** @param {string | null | undefined} cwd */
export const repoName = (cwd) => (cwd ? (cwd.split("/").filter(Boolean).at(-1) ?? cwd) : null);

/**
 * A pfs fork's folder, ~/.pfs/forks/<repo>/<n> (<repo>/.forks/<n> before pfs 0.4): "repo · fork n" when the host sent
 * no fork label, which names the fork wherever pfs keeps them.
 * @param {string | null | undefined} cwd
 */
export const forkPlace = (cwd) => {
	const match = cwd ? (/\/\.pfs\/forks\/([^/]+)\/(\d+)(?:\/|$)/.exec(cwd) ?? /^(.+)\/\.forks\/(\d+)(?:\/|$)/.exec(cwd)) : null;
	return match ? `${repoName(match[1])} · fork ${match[2]}` : null;
};

/**
 * A fork label ends in pfs's name for the fork ("pi-web · fork 19-fix-streams"), and a sub is usually named like its fork
 * ("fix-streams"): such a name would only say it twice.
 * @param {string | null | undefined} forkLabel @param {string} label
 */
function repeatsForkName(forkLabel, label) {
	const fork = forkLabel ? /· fork (\d+)-(.+)$/.exec(forkLabel) : null;
	return fork !== null && (label === fork[2] || label === `${fork[1]}-${fork[2]}`);
}

/**
 * A tile's title: where the session ran (its fork, else its repo), then its name, first line or id, unless that only
 * repeats the fork's name.
 * @param {{ id: string, cwd?: string, name?: string, firstMessage?: string, forkLabel?: string | null }} session
 */
export function sessionTitle(session) {
	const label = session.name?.trim() || session.firstMessage?.trim().split("\n")[0]?.slice(0, 80) || session.id.slice(0, 8);
	const place = session.forkLabel || forkPlace(session.cwd) || repoName(session.cwd);
	return [place, repeatsForkName(session.forkLabel, label) ? null : label].filter(Boolean).join(" · ");
}
