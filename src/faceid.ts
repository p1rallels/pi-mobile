import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type AuthenticatorTransportFuture,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { isMissingFileError, readPrivateJsonFile, writePrivateJsonFile } from "./private-state.ts";

export type ChallengeKind = "register" | "authenticate";

interface StoredCredential {
	id: string;
	publicKey: string;
	counter: number;
	transports?: AuthenticatorTransportFuture[];
	createdAt: string;
	lastUsedAt: string;
}

interface FaceIdStore {
	version: 2;
	rpCredentials: Record<string, StoredCredential[]>;
}

/** Who asked for a challenge: the browser (its client id) and, in secure mode, its mTLS device fingerprint (else null). */
export interface ChallengeAsker {
	clientId: string;
	device: string | null;
}

/** What a challenge is bound to: verify takes it only for the same RP and origin, from the same browser and device. */
export interface ChallengeBinding extends ChallengeAsker {
	rpId: string;
	origin: string;
}

interface ChallengeRecord extends ChallengeBinding {
	id: string;
	kind: ChallengeKind;
	expectedChallenge: string;
	expiresAt: number;
	/** the requester key that asked for it (see requester-key.ts) */
	requester: string;
}

interface VerifyOutcome {
	ok: true;
	kind: ChallengeKind;
}

const CHALLENGE_TTL_MS = 90_000;
const MAX_PENDING_CHALLENGES = 256;
/** a requester past this drops its own oldest pending challenge, so no one requester fills the shared store */
export const MAX_PENDING_CHALLENGES_PER_REQUESTER = 8;

const BINDING_FIELDS = ["rpId", "origin", "clientId", "device"] as const satisfies readonly (keyof ChallengeBinding)[];

/** The first field a presented ceremony differs from its challenge in, or null when it's the same RP, origin, browser and device. */
export function bindingMismatch(issued: ChallengeBinding, presented: ChallengeBinding): keyof ChallengeBinding | null {
	return BINDING_FIELDS.find((field) => issued[field] !== presented[field]) ?? null;
}

/**
 * Why a ceremony can't run against an RP that holds this many credentials, or null. Registration is first use only (no path
 * adds a passkey to an enrolled RP), so it's asked when a challenge is issued and again when one is verified.
 */
export function ceremonyRefusal(kind: ChallengeKind, credentialCount: number): "faceid_not_enrolled" | "faceid_already_enrolled" | null {
	if (kind === "authenticate") return credentialCount === 0 ? "faceid_not_enrolled" : null;
	return credentialCount > 0 ? "faceid_already_enrolled" : null;
}

export class FaceIdService {
	private storePath: string;
	private challenges = new Map<string, ChallengeRecord>();
	/** the last verify in line: each one reads, checks and writes the store after the one before it is done */
	private verifying: Promise<unknown> = Promise.resolve();

	constructor(storePath = join(homedir(), ".pi", "agent", "pi-web", "faceid-credentials.json")) {
		this.storePath = storePath;
	}

	private async readStore(): Promise<FaceIdStore> {
		try {
			const parsed = await readPrivateJsonFile<unknown>(this.storePath);
			if (!parsed || typeof parsed !== "object") {
				throw new Error(`Invalid Face ID store: ${this.storePath}`);
			}
			const store = parsed as Partial<FaceIdStore>;
			if (store.version !== 2 || !store.rpCredentials || typeof store.rpCredentials !== "object" || Array.isArray(store.rpCredentials)) {
				throw new Error(`Invalid Face ID store: ${this.storePath}`);
			}
			return { version: 2, rpCredentials: store.rpCredentials };
		} catch (error) {
			if (isMissingFileError(error)) {
				return { version: 2, rpCredentials: {} };
			}
			throw error;
		}
	}

	private async writeStore(store: FaceIdStore): Promise<void> {
		await writePrivateJsonFile(this.storePath, store);
	}

	private pruneChallenges(now = Date.now()): void {
		for (const [id, challenge] of this.challenges.entries()) {
			if (challenge.expiresAt <= now) {
				this.challenges.delete(id);
			}
		}
	}

	/** Stores a challenge, first dropping its requester's oldest pending ones (a Map iterates in insertion order) past the per-requester cap. */
	private remember(record: ChallengeRecord): void {
		const own = [...this.challenges.values()].filter((challenge) => challenge.requester === record.requester);
		for (const stale of own.slice(0, Math.max(0, own.length - MAX_PENDING_CHALLENGES_PER_REQUESTER + 1))) {
			this.challenges.delete(stale.id);
		}
		this.challenges.set(record.id, record);
	}

	private async listCredentialsForRp(rpId: string): Promise<StoredCredential[]> {
		const store = await this.readStore();
		const credentials = store.rpCredentials[rpId];
		return Array.isArray(credentials) ? credentials : [];
	}

	async status(rpId: string): Promise<{ enrolled: boolean; credentialCount: number }> {
		const credentials = await this.listCredentialsForRp(rpId);
		return {
			enrolled: credentials.length > 0,
			credentialCount: credentials.length,
		};
	}

	async createChallenge(
		kind: ChallengeKind,
		rpId: string,
		origin: string,
		requester: string,
		asker: ChallengeAsker,
	): Promise<{
		challengeId: string;
		kind: ChallengeKind;
		options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
	}> {
		this.pruneChallenges();
		if (this.challenges.size >= MAX_PENDING_CHALLENGES) {
			throw new Error("too_many_pending_faceid_challenges");
		}
		const credentials = await this.listCredentialsForRp(rpId);
		const refusal = ceremonyRefusal(kind, credentials.length);
		if (refusal) throw new Error(refusal);
		const { clientId, device } = asker;

		const challengeId = isoBase64URL.fromBuffer(randomBytes(24));
		const expiresAt = Date.now() + CHALLENGE_TTL_MS;

		if (kind === "register") {
			const options = await generateRegistrationOptions({
				rpName: "pi-web",
				rpID: rpId,
				userName: `pi-web@${rpId}`,
				userDisplayName: "pi-web operator",
				timeout: 60_000,
				attestationType: "none",
				authenticatorSelection: {
					userVerification: "required",
					residentKey: "preferred",
				},
				excludeCredentials: credentials.map((cred) => ({
					id: cred.id,
					transports: cred.transports,
				})),
			});

			this.remember({ id: challengeId, kind, rpId, origin, clientId, device, expectedChallenge: options.challenge, expiresAt, requester });
			return { challengeId, kind, options };
		}

		const options = await generateAuthenticationOptions({
			rpID: rpId,
			timeout: 45_000,
			userVerification: "required",
			allowCredentials: credentials.map((cred) => ({
				id: cred.id,
				transports: cred.transports,
			})),
		});

		this.remember({ id: challengeId, kind, rpId, origin, clientId, device, expectedChallenge: options.challenge, expiresAt, requester });
		return { challengeId, kind, options };
	}

	private resolveChallenge(challengeId: string): ChallengeRecord {
		this.pruneChallenges();
		const challenge = this.challenges.get(challengeId);
		if (!challenge || challenge.expiresAt < Date.now()) {
			throw new Error("challenge_expired");
		}
		this.challenges.delete(challengeId);
		return challenge;
	}

	/** Takes a challenge (once: a refused one is gone too) and verifies the ceremony, if it's presented for what it was issued for. */
	async verify(challengeId: string, credentialPayload: unknown, presented: ChallengeBinding): Promise<VerifyOutcome> {
		const challenge = this.resolveChallenge(challengeId);
		if (bindingMismatch(challenge, presented)) throw new Error("challenge_mismatch");
		const run = () =>
			challenge.kind === "register"
				? this.verifyRegistration(challenge, credentialPayload)
				: this.verifyAuthentication(challenge, credentialPayload);
		const outcome = this.verifying.then(run);
		this.verifying = outcome.catch(() => undefined);
		return outcome;
	}

	private async verifyRegistration(challenge: ChallengeRecord, credentialPayload: unknown): Promise<VerifyOutcome> {
		const response = credentialPayload as RegistrationResponseJSON;

		const verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge.expectedChallenge,
			expectedOrigin: challenge.origin,
			expectedRPID: challenge.rpId,
			requireUserVerification: true,
			requireUserPresence: true,
		});

		if (!verification.verified) {
			throw new Error("registration_verification_failed");
		}

		const credential = verification.registrationInfo.credential;
		const store = await this.readStore();
		const existing = Array.isArray(store.rpCredentials[challenge.rpId]) ? store.rpCredentials[challenge.rpId]! : [];
		const refusal = ceremonyRefusal("register", existing.length);
		if (refusal) throw new Error(refusal);
		if (existing.some((entry) => entry.id === credential.id)) {
			throw new Error("credential_already_registered");
		}

		const now = new Date().toISOString();
		const next: StoredCredential = {
			id: isoBase64URL.trimPadding(credential.id),
			publicKey: isoBase64URL.fromBuffer(credential.publicKey),
			counter: credential.counter,
			transports: credential.transports,
			createdAt: now,
			lastUsedAt: now,
		};

		store.rpCredentials[challenge.rpId] = [...existing, next];
		await this.writeStore(store);

		return { ok: true, kind: "register" };
	}

	private async verifyAuthentication(challenge: ChallengeRecord, credentialPayload: unknown): Promise<VerifyOutcome> {
		const response = credentialPayload as AuthenticationResponseJSON;
		const responseId = typeof response?.id === "string" ? isoBase64URL.trimPadding(response.id) : null;
		if (!responseId) throw new Error("invalid_credential_id");

		const store = await this.readStore();
		const credentials = store.rpCredentials[challenge.rpId] ?? [];
		const idx = credentials.findIndex((entry) => entry.id === responseId);
		if (idx < 0) throw new Error("credential_not_registered");

		const entry = credentials[idx]!;
		const verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge.expectedChallenge,
			expectedOrigin: challenge.origin,
			expectedRPID: challenge.rpId,
			credential: {
				id: entry.id,
				publicKey: isoBase64URL.toBuffer(entry.publicKey),
				counter: entry.counter,
				transports: entry.transports,
			},
			requireUserVerification: true,
		});

		if (!verification.verified) {
			throw new Error("authentication_verification_failed");
		}

		const now = new Date().toISOString();
		credentials[idx] = {
			...entry,
			counter: verification.authenticationInfo.newCounter,
			lastUsedAt: now,
		};
		store.rpCredentials[challenge.rpId] = credentials;
		await this.writeStore(store);

		return { ok: true, kind: "authenticate" };
	}
}
