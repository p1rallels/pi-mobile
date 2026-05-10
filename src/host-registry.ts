import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";

export interface HostRecord {
	id: string;
	label: string;
	url: string;
	tailscaleName?: string;
	tailscaleIp?: string;
	enabled: boolean;
	createdAt: string;
}

export interface HostRegistry {
	version: 1;
	hosts: HostRecord[];
}

export function emptyHostRegistry(): HostRegistry {
	return { version: 1, hosts: [] };
}

export function normalizeHostId(raw: string): string {
	const id = raw.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(id)) {
		throw new Error("Host id must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores.");
	}
	return id;
}

export function normalizeHostUrl(raw: string): string {
	const parsed = new URL(raw.trim());
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`Unsupported host url protocol: ${parsed.protocol}`);
	}
	parsed.pathname = "";
	parsed.search = "";
	parsed.hash = "";
	return parsed.origin;
}

function parseOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseHostRecord(raw: unknown): HostRecord | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const input = raw as Partial<HostRecord>;
	if (typeof input.id !== "string" || typeof input.url !== "string") return null;
	return {
		id: normalizeHostId(input.id),
		label: typeof input.label === "string" && input.label.trim() ? input.label.trim() : normalizeHostId(input.id),
		url: normalizeHostUrl(input.url),
		tailscaleName: parseOptionalString(input.tailscaleName),
		tailscaleIp: parseOptionalString(input.tailscaleIp),
		enabled: input.enabled !== false,
		createdAt: typeof input.createdAt === "string" && input.createdAt.trim() ? input.createdAt.trim() : new Date().toISOString(),
	};
}

export function parseHostRegistry(raw: unknown, path: string): HostRegistry {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid host registry: ${path}`);
	}
	const input = raw as Partial<HostRegistry>;
	if (input.version !== 1 || !Array.isArray(input.hosts)) {
		throw new Error(`Invalid host registry: ${path}`);
	}
	const hosts = input.hosts.map(parseHostRecord).filter((host): host is HostRecord => Boolean(host));
	return { version: 1, hosts: dedupeHosts(hosts) };
}

export async function loadHostRegistry(path: string): Promise<HostRegistry> {
	try {
		return parseHostRegistry(await readPrivateJsonFile<unknown>(path), path);
	} catch (error) {
		if (isMissingFileError(error)) return emptyHostRegistry();
		throw error;
	}
}

export async function saveHostRegistry(path: string, registry: HostRegistry): Promise<void> {
	await writePrivateJsonFile(path, { version: 1, hosts: dedupeHosts(registry.hosts) });
}

export function dedupeHosts(hosts: HostRecord[]): HostRecord[] {
	const byId = new Map<string, HostRecord>();
	for (const host of hosts) {
		byId.set(normalizeHostId(host.id), {
			...host,
			id: normalizeHostId(host.id),
			url: normalizeHostUrl(host.url),
			enabled: host.enabled !== false,
		});
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function upsertHost(path: string, input: { id: string; url: string; label?: string; tailscaleName?: string; tailscaleIp?: string; enabled?: boolean }): Promise<HostRegistry> {
	const registry = await loadHostRegistry(path);
	const id = normalizeHostId(input.id);
	const now = new Date().toISOString();
	const existing = registry.hosts.find((host) => host.id === id);
	const nextHost: HostRecord = {
		id,
		label: input.label?.trim() || existing?.label || id,
		url: normalizeHostUrl(input.url),
		tailscaleName: input.tailscaleName?.trim() || existing?.tailscaleName,
		tailscaleIp: input.tailscaleIp?.trim() || existing?.tailscaleIp,
		enabled: input.enabled ?? existing?.enabled ?? true,
		createdAt: existing?.createdAt ?? now,
	};
	const next = { version: 1 as const, hosts: dedupeHosts([...registry.hosts.filter((host) => host.id !== id), nextHost]) };
	await saveHostRegistry(path, next);
	return next;
}

export async function removeHost(path: string, rawId: string): Promise<HostRecord> {
	const id = normalizeHostId(rawId);
	const registry = await loadHostRegistry(path);
	const host = registry.hosts.find((entry) => entry.id === id);
	if (!host) throw new Error(`host_not_found: ${id}`);
	await saveHostRegistry(path, { version: 1, hosts: registry.hosts.filter((entry) => entry.id !== id) });
	return host;
}
