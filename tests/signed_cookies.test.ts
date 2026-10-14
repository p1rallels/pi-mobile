import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCookieSigner, loadOrCreateCookieKey } from "../src/signed-cookies.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-web-cookies-"));
	tempDirs.push(dir);
	return dir;
}

describe("signed cookies", () => {
	test("round-trips payloads and rejects tampering or another key", async () => {
		const signer = createCookieSigner(new Uint8Array(32).fill(7));
		const token = signer.sign({ kind: "client", clientId: "abc", exp: 123 });
		expect(signer.verify(token)).toEqual({ kind: "client", clientId: "abc", exp: 123 });

		const [body, signature] = token.split(".");
		const forged = Buffer.from(JSON.stringify({ kind: "client", clientId: "evil", exp: 123 })).toString("base64url");
		expect(signer.verify(`${forged}.${signature}`)).toBeNull();
		expect(signer.verify(`${body}.${signature}x`)).toBeNull();
		expect(signer.verify(`${body}.${signature}.extra`)).toBeNull();
		expect(signer.verify(undefined)).toBeNull();
		expect(createCookieSigner(new Uint8Array(32).fill(8)).verify(token)).toBeNull();
	});

	test("creates a private key once and reuses it", async () => {
		const path = join(await tempDir(), "nested", "cookie-key");
		const first = await loadOrCreateCookieKey(path);
		const second = await loadOrCreateCookieKey(path);
		expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});
