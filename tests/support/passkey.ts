// A dummy platform authenticator for Face ID tests: a real ES256 key pair, "none" attestation, UP+UV flags, so every
// WebAuthn check on the host runs for real.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64 = (input: Uint8Array | string): string => Buffer.from(input).toString("base64url");
const sha256 = (input: Uint8Array | string): Buffer => createHash("sha256").update(input).digest();
const uint32 = (n: number): Buffer => {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(n);
	return out;
};

export interface Passkey {
	id: Buffer;
	privateKey: KeyObject;
	cose: Uint8Array;
	counter: number;
}

export function passkey(): Passkey {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = publicKey.export({ format: "jwk" });
	if (!jwk.x || !jwk.y) throw new Error("missing ec coordinates");
	const cose = isoCBOR.encode(
		new Map<number, number | Uint8Array>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Buffer.from(jwk.x, "base64url")],
			[-3, Buffer.from(jwk.y, "base64url")],
		]),
	);
	return { id: randomBytes(32), privateKey, cose, counter: 0 };
}

/** The passkey's answer to a register challenge. */
export function registration(key: Passkey, challenge: string, rpId: string, origin: string) {
	const idLength = Buffer.alloc(2);
	idLength.writeUInt16BE(key.id.length);
	const authData = Buffer.concat([sha256(rpId), Buffer.from([0x45]), uint32(0), Buffer.alloc(16), idLength, key.id, key.cose]);
	const attestation = new Map<string, string | Uint8Array | Map<number, number>>([
		["fmt", "none"],
		["attStmt", new Map()],
		["authData", authData],
	]);
	return {
		id: b64(key.id),
		rawId: b64(key.id),
		type: "public-key",
		clientExtensionResults: {},
		response: {
			clientDataJSON: b64(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })),
			attestationObject: b64(isoCBOR.encode(attestation)),
			transports: ["internal"],
		},
	};
}

/** The passkey's answer to an authenticate challenge. */
export function assertion(key: Passkey, challenge: string, rpId: string, origin: string) {
	key.counter += 1;
	const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
	const authData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), uint32(key.counter)]);
	return {
		id: b64(key.id),
		rawId: b64(key.id),
		type: "public-key",
		clientExtensionResults: {},
		response: {
			clientDataJSON: b64(clientData),
			authenticatorData: b64(authData),
			userHandle: b64("operator"),
			signature: b64(sign("sha256", Buffer.concat([authData, sha256(clientData)]), key.privateKey)),
		},
	};
}
