import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissingFileError } from "./private-state.ts";

const KEY_BYTES = 32;

export interface CookieSigner {
	sign(payload: Record<string, unknown>): string;
	verify(token: string | null | undefined): Record<string, unknown> | null;
}

function mac(key: Uint8Array, body: string): Buffer {
	return createHmac("sha256", key).update(body).digest();
}

/** Stateless `body.mac` tokens: auth survives restarts as long as the key file does. */
export function createCookieSigner(key: Uint8Array): CookieSigner {
	if (key.length < KEY_BYTES) throw new Error("cookie key is too short");
	return {
		sign(payload) {
			const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
			return `${body}.${mac(key, body).toString("base64url")}`;
		},
		verify(token) {
			if (!token) return null;
			const [body, signature, extra] = token.split(".");
			if (!body || !signature || extra !== undefined) return null;
			const expected = mac(key, body);
			const given = Buffer.from(signature, "base64url");
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
			try {
				const payload: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
				return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
			} catch {
				return null;
			}
		},
	};
}

export async function loadOrCreateCookieKey(path: string): Promise<Uint8Array> {
	try {
		const key = await readFile(path);
		if (key.length >= KEY_BYTES) return key;
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const key = randomBytes(KEY_BYTES);
	await writeFile(path, key, { mode: 0o600 });
	await chmod(path, 0o600).catch(() => {});
	return key;
}
