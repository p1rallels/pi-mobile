import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type AuthenticatorTransportFuture,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

type ChallengeKind = "register" | "authenticate";

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

interface ChallengeRecord {
	id: string;
	kind: ChallengeKind;
	rpId: string;
	origin: string;
	expectedChallenge: string;
	expiresAt: number;
}

interface VerifyOutcome {
	ok: true;
	kind: ChallengeKind;
}

const CHALLENGE_TTL_MS = 90_000;

export class FaceIdService {
	private storePath: string;
	private challenges = new Map<string, ChallengeRecord>();

	constructor(storePath = join(homedir(), ".pi", "agent", "pi-web", "faceid-credentials.json")) {
		this.storePath = storePath;
	}

	private async readStore(): Promise<FaceIdStore> {
		try {
			const raw = await readFile(this.storePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<FaceIdStore>;
			if (parsed.version !== 2 || !parsed.rpCredentials || typeof parsed.rpCredentials !== "object") {
				return { version: 2, rpCredentials: {} };
			}
			return { version: 2, rpCredentials: parsed.rpCredentials };
		} catch {
			return { version: 2, rpCredentials: {} };
		}
	}

	private async writeStore(store: FaceIdStore): Promise<void> {
		mkdirSync(dirname(this.storePath), { recursive: true });
		await writeFile(this.storePath, JSON.stringify(store, null, 2), "utf8");
	}

	private pruneChallenges(now = Date.now()): void {
		for (const [id, challenge] of this.challenges.entries()) {
			if (challenge.expiresAt <= now) {
				this.challenges.delete(id);
			}
		}
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
	): Promise<{
		challengeId: string;
		kind: ChallengeKind;
		options: Record<string, unknown>;
	}> {
		this.pruneChallenges();
		const credentials = await this.listCredentialsForRp(rpId);

		if (kind === "authenticate" && credentials.length === 0) {
			throw new Error("faceid_not_enrolled");
		}
		if (kind === "register" && credentials.length > 0) {
			throw new Error("faceid_already_enrolled");
		}

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

			const record: ChallengeRecord = {
				id: challengeId,
				kind,
				rpId,
				origin,
				expectedChallenge: options.challenge,
				expiresAt,
			};
			this.challenges.set(challengeId, record);
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

		const record: ChallengeRecord = {
			id: challengeId,
			kind,
			rpId,
			origin,
			expectedChallenge: options.challenge,
			expiresAt,
		};
		this.challenges.set(challengeId, record);
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

	async verify(challengeId: string, credentialPayload: unknown): Promise<VerifyOutcome> {
		const challenge = this.resolveChallenge(challengeId);
		return challenge.kind === "register"
			? this.verifyRegistration(challenge, credentialPayload)
			: this.verifyAuthentication(challenge, credentialPayload);
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
