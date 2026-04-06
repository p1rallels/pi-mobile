import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function errorCode(error: unknown): string | null {
	if (!error || typeof error !== "object") return null;
	return typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null;
}

export function isMissingFileError(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

async function assertNotSymlink(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) {
			throw new Error(`Refusing symlinked state path: ${path}`);
		}
	} catch (error) {
		if (isMissingFileError(error)) return;
		throw error;
	}
}

async function assertSafePathHierarchy(path: string): Promise<void> {
	let current = resolve(path);
	while (true) {
		await assertNotSymlink(current);
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await assertSafePathHierarchy(path);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700).catch(() => {
		// best effort on existing directories / non-posix filesystems
	});
}

export async function readPrivateJsonFile<T = unknown>(path: string): Promise<T> {
	await assertSafePathHierarchy(path);
	const raw = await readFile(path, "utf8");
	await chmod(path, 0o600).catch(() => {
		// best effort on existing files / non-posix filesystems
	});
	return JSON.parse(raw) as T;
}

export async function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
	const dir = dirname(path);
	await ensurePrivateDirectory(dir);
	await assertSafePathHierarchy(path);

	const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
		await chmod(tempPath, 0o600).catch(() => {
			// best effort on non-posix filesystems
		});
		await rename(tempPath, path);
		await chmod(path, 0o600).catch(() => {
			// best effort on non-posix filesystems
		});
	} finally {
		await rm(tempPath, { force: true }).catch(() => {
			// ignore cleanup failures
		});
	}
}
