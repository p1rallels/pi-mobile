import { hasTrustRequiringProjectResources, type ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ApiProjectTrustChoice = "trust" | "trust_parent" | "trust_session" | "distrust" | "distrust_session";

export interface ApiProjectTrustOption {
	choice: ApiProjectTrustChoice;
	label: string;
	trusted: boolean;
}

export interface ApiProjectTrustPrompt {
	cwd: string;
	options: ApiProjectTrustOption[];
}

export type ApiProjectTrustSource = "no_resources" | "saved" | "setting" | "session" | "restored";

/** Whether this session loaded the project's .pi resources, and why. `gated` is false when there were none to gate. */
export interface ApiProjectTrust {
	trusted: boolean;
	gated: boolean;
	source: ApiProjectTrustSource;
}

/** pi-web's fallback when trust.json has no decision for the folder (PI_WEB_PROJECT_TRUST). */
export type ProjectTrustMode = "always" | "never" | "ask";

export const DEFAULT_PROJECT_TRUST_MODE: ProjectTrustMode = "always";

export function parseProjectTrustMode(raw: string | undefined): ProjectTrustMode {
	const value = raw?.trim().toLowerCase();
	if (!value) return DEFAULT_PROJECT_TRUST_MODE;
	if (value === "always" || value === "never" || value === "ask") return value;
	throw new Error(`PI_WEB_PROJECT_TRUST must be always, never or ask (got ${JSON.stringify(raw)}).`);
}

type TrustStore = Pick<ProjectTrustStore, "get" | "setMany">;

const CHOICES: readonly ApiProjectTrustChoice[] = ["trust", "trust_parent", "trust_session", "distrust", "distrust_session"];

export class ProjectTrustRequiredError extends Error {
	constructor(readonly prompt: ApiProjectTrustPrompt) {
		super("project_trust_required");
	}
}

export function canonicalProjectPath(cwd: string): string {
	try {
		return realpathSync(resolve(cwd));
	} catch {
		return resolve(cwd);
	}
}

function parentPath(cwd: string): string | undefined {
	const parent = dirname(cwd);
	return parent === cwd ? undefined : parent;
}

export function isProjectTrustChoice(value: unknown): value is ApiProjectTrustChoice {
	return typeof value === "string" && CHOICES.some((choice) => choice === value);
}

/** The cli's trust prompt options, including its "this session only" variants. */
export function projectTrustPrompt(rawCwd: string): ApiProjectTrustPrompt {
	const cwd = canonicalProjectPath(rawCwd);
	const parent = parentPath(cwd);
	const options: ApiProjectTrustOption[] = [
		{ choice: "trust", label: "Trust", trusted: true },
		...(parent === undefined ? [] : [{ choice: "trust_parent" as const, label: `Trust parent folder (${parent})`, trusted: true }]),
		{ choice: "trust_session", label: "Trust (this session only)", trusted: true },
		{ choice: "distrust", label: "Do not trust", trusted: false },
		{ choice: "distrust_session", label: "Do not trust (this session only)", trusted: false },
	];
	return { cwd, options };
}

/**
 * Like the cli without command-line overrides: no protected resources, then the closest saved decision in
 * trust.json, then the fallback mode. Returns null when the user has to be asked.
 */
export function resolveProjectTrust(cwd: string, store: TrustStore, mode: ProjectTrustMode): ApiProjectTrust | null {
	if (!hasTrustRequiringProjectResources(cwd)) return { trusted: true, gated: false, source: "no_resources" };
	const saved = store.get(cwd);
	if (saved !== null) return { trusted: saved, gated: true, source: "saved" };
	switch (mode) {
		case "always":
			return { trusted: true, gated: true, source: "setting" };
		case "never":
			return { trusted: false, gated: true, source: "setting" };
		case "ask":
			return null;
	}
}

/** Saves what the choice remembers (like the cli prompt) and returns the decision for this session. */
export function applyProjectTrustChoice(rawCwd: string, choice: ApiProjectTrustChoice, store: TrustStore): ApiProjectTrust {
	const cwd = canonicalProjectPath(rawCwd);
	switch (choice) {
		case "trust":
			store.setMany([{ path: cwd, decision: true }]);
			return { trusted: true, gated: true, source: "saved" };
		case "trust_parent": {
			const parent = parentPath(cwd);
			if (parent === undefined) throw new Error("invalid_project_trust_choice");
			store.setMany([
				{ path: parent, decision: true },
				{ path: cwd, decision: null },
			]);
			return { trusted: true, gated: true, source: "saved" };
		}
		case "distrust":
			store.setMany([{ path: cwd, decision: false }]);
			return { trusted: false, gated: true, source: "saved" };
		case "trust_session":
			return { trusted: true, gated: true, source: "session" };
		case "distrust_session":
			return { trusted: false, gated: true, source: "session" };
	}
}
