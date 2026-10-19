import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { MAINTENANCE_LIMITS, MaintenanceError } from "./contracts.ts";

export function validateWorkspaceId(value: string): void {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value))
		throw new MaintenanceError("INVALID_PATH");
}
export async function assertRegularFile(path: string) {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new MaintenanceError("INVALID_PATH");
	return info;
}
export async function canonicalDirectory(path: string): Promise<string> {
	if (!path || path.includes("\0") || path.startsWith("\\\\")) throw new MaintenanceError("INVALID_PATH");
	const absolute = resolve(path);
	let cursor = parse(absolute).root;
	for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		const info = await lstat(cursor);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new MaintenanceError("INVALID_PATH");
	}
	return realpath(absolute);
}
export async function allocateDirectory(source: string, destination: string): Promise<string> {
	if (
		!destination ||
		destination.includes("\0") ||
		/[\\/]$/.test(destination) ||
		[".", ".."].includes(basename(destination)) ||
		/[:<>"|?*\x00-\x1f]/.test(basename(destination)) ||
		/[. ]$/.test(basename(destination)) ||
		/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(basename(destination))
	)
		throw new MaintenanceError("INVALID_PATH");
	const target = join(await canonicalDirectory(dirname(resolve(destination))), basename(destination));
	const inside = (a: string, b: string) => {
		const delta = relative(a.toLowerCase(), b.toLowerCase());
		return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
	};
	if (inside(source, target) || inside(target, source)) throw new MaintenanceError("INVALID_PATH");
	await mkdir(target, { mode: 0o700 });
	return target;
}
/** Only operation-owned outputs are flushed; this never grants write access to a source database. */
export async function syncPath(path: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1))
		throw new MaintenanceError("INVALID_PATH");
	// Windows FlushFileBuffers requires write access for files and directories. r+ opens
	// an existing path without creation/truncation; successful flush is still platform-unqualified.
	const handle = await open(path, info.isFile() || process.platform === "win32" ? "r+" : "r");
	try {
		await handle.sync();
	} catch (error) {
		throw new MaintenanceError("DURABILITY_UNVERIFIED", "", "flush", error);
	} finally {
		await handle.close();
	}
}
export async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
	const before = await assertRegularFile(path);
	if (before.size > MAINTENANCE_LIMITS.totalBytes) throw new MaintenanceError("CAPACITY_EXCEEDED");
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
		bytes += chunk.length;
		if (bytes > MAINTENANCE_LIMITS.totalBytes) throw new MaintenanceError("CAPACITY_EXCEEDED");
		hash.update(chunk);
	}
	const after = await assertRegularFile(path);
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		bytes !== after.size
	)
		throw new MaintenanceError("SOURCE_CHANGED");
	return { bytes, sha256: hash.digest("hex") };
}

/** Bound metadata reads even if a concurrently replaced file is larger than its earlier stat. */
export async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
	const info = await assertRegularFile(path);
	if (info.size > maximum) throw new MaintenanceError("CAPACITY_EXCEEDED");
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maximum + 1);
		let count = 0;
		while (count < buffer.length) {
			const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
			if (!bytesRead) break;
			count += bytesRead;
		}
		if (count > maximum) throw new MaintenanceError("CAPACITY_EXCEEDED");
		return buffer.subarray(0, count);
	} finally {
		await handle.close();
	}
}
export async function boundedDirectoryNames(path: string, maximum: number): Promise<string[]> {
	const names: string[] = [];
	for await (const entry of await opendir(path)) {
		names.push(entry.name);
		if (names.length > maximum) throw new MaintenanceError("INCOMPLETE_BACKUP");
	}
	return names;
}
