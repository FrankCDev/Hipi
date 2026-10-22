import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { FileEntry, FileRoot, FileService, FileTarget, FileText } from "./contracts.ts";
import { FILE_LIMITS, FileServiceError, validateRelativePath } from "./contracts.ts";

import { rootDisplayName } from "./display-name.ts";

type Grant = FileRoot & { principalId: string; canonicalPath: string; dev: bigint; ino: bigint };
/** Trusted Node consumers only; never forward renderer-selected byte budgets. */
export interface TrustedFileSnapshotSource {
	/** Returns independently owned bytes. Consumers must not mutate retained snapshot content. */
	read(target: FileTarget, maxBytes: number): Promise<{ bytes: Uint8Array; revision: string }>;
	/** Recheck before publishing any cached preview resource, including every later chunk read. */
	assertAuthorized(target: FileTarget): Promise<void>;
}
/** Node-only broker capability. Never accept this callback from IPC, HTTP or model arguments.
 * The broker checks the exact invocation/consumed approval and holds its cancellation/revocation
 * lock until commit settles, invoking and awaiting commit exactly once. Calling the callback outside that lock is not an authorization gate.
 */
export type FileCommitPermit = <T>(commit: () => Promise<T>) => Promise<T>;
/** Verified host binding, never inferred from the other roots available to a principal. */
export type TrustedProjectContext = {
	workspaceId: string;
	bindingId: string;
	bindingRevision: number;
	root: FileRoot;
};
export interface TrustedAgentFileService extends Pick<FileService, "listRoots" | "list" | "readText"> {
	/** Host composition only. An unavailable, disconnected or revoked binding returns null. */
	currentProject?(workspaceId: string): Promise<TrustedProjectContext | null>;
	/** Synchronous grant-liveness check immediately before dispatch; not a workspace or filesystem authorization. */
	assertRoot(workspaceId: string, rootId: string): void;
	saveText(target: FileTarget, text: string, ifMatch: string, withCommitPermit: FileCommitPermit): Promise<FileText>;
}
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
export type FileAuthorityOptions = {
	/** Explicitly acknowledges no protection against hostile same-user OS processes. */
	securityMode: "cooperative-local-files";
	assertWorkspaceAccess(principalId: string, workspaceId: string): Promise<void>;
};
export interface TrustedFileAuthority {
	/** Trusted picker/config only. Never expose this method over the public file transport. */
	grantRoot(input: {
		principalId: string;
		workspaceId: string;
		absolutePath: string;
		writable: boolean;
		/** Reopening a persisted association must match the original canonical directory identity. */
		expectedIdentity?: { canonicalPath: string; device: string; inode: string };
	}): Promise<FileRoot>;
	revokeRoot(rootId: string): void;
	forPrincipal(principalId: string): FileService;
	/** Trusted Agent broker only; the public manual editor port is unchanged. */
	forAgent(principalId: string): TrustedAgentFileService;
	/** Internal preview input only; not part of the public text transport. */
	forPrincipalSnapshot(principalId: string): TrustedFileSnapshotSource;
	close(): Promise<void>;
}
function digest(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function textContent(bytes: Buffer): FileText {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new FileServiceError("UNSUPPORTED_ENCODING");
	}
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new FileServiceError("UNSUPPORTED_ENCODING");
	return { text, revision: digest(bytes), encoding: "utf-8", bytes: bytes.length };
}
/** A bounded local-file broker, not an OS security sandbox or cross-process atomic CAS. */
export function createFileAuthority(options: FileAuthorityOptions): TrustedFileAuthority {
	if (options.securityMode !== "cooperative-local-files") throw new FileServiceError("BLOCKED_RESOURCE");
	const grants = new Map<string, Grant>();
	const writing = new Set<string>();
	let active = 0;
	let closed = false;
	const drained = Promise.withResolvers<void>();
	async function bounded<T>(operation: () => Promise<T>): Promise<T> {
		if (closed) throw new FileServiceError("CLOSED");
		if (active >= FILE_LIMITS.concurrent) throw new FileServiceError("BUSY");
		active++;
		try {
			return await operation();
		} catch (error) {
			if (error instanceof FileServiceError) throw error;
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				throw new FileServiceError("NOT_FOUND");
			throw new FileServiceError("IO_ERROR");
		} finally {
			active--;
			if (closed && active === 0) drained.resolve();
		}
	}
	async function authorize(principalId: string, target: FileTarget, write = false): Promise<Grant> {
		if (!target || typeof target.workspaceId !== "string" || typeof target.rootId !== "string")
			throw new FileServiceError("UNAUTHORIZED");
		const grant = grants.get(target.rootId);
		if (
			!grant ||
			grant.principalId !== principalId ||
			grant.workspaceId !== target.workspaceId ||
			(write && !grant.writable)
		)
			throw new FileServiceError("UNAUTHORIZED");
		await options.assertWorkspaceAccess(principalId, target.workspaceId);
		if (grants.get(target.rootId) !== grant) throw new FileServiceError("UNAUTHORIZED");
		return grant;
	}
	async function resolve(grant: Grant, path: string): Promise<string> {
		const root = await lstat(grant.canonicalPath, { bigint: true });
		if (
			!root.isDirectory() ||
			root.isSymbolicLink() ||
			root.dev !== grant.dev ||
			root.ino !== grant.ino ||
			(await realpath(grant.canonicalPath)) !== grant.canonicalPath
		)
			throw new FileServiceError("BLOCKED_RESOURCE");
		let current = grant.canonicalPath;
		for (const part of path ? path.split("/") : []) {
			current = join(current, part);
			const info = await lstat(current);
			if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.nlink > 1 && info.isFile()))
				throw new FileServiceError("BLOCKED_RESOURCE");
		}
		return current;
	}
	async function readBytes(grant: Grant, path: string, maxBytes: number): Promise<{ bytes: Buffer; mode: number }> {
		const filename = await resolve(grant, path);
		const handle = await open(
			filename,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		try {
			const before = await handle.stat();
			if (!before.isFile() || before.nlink !== 1) throw new FileServiceError("BLOCKED_RESOURCE");
			if (before.size > maxBytes) throw new FileServiceError("LIMIT_EXCEEDED");
			const bytes = Buffer.alloc(maxBytes + 1);
			let length = 0;
			while (length < bytes.length) {
				const result = await handle.read(bytes, length, bytes.length - length, length);
				if (!result.bytesRead) break;
				length += result.bytesRead;
			}
			if (length > maxBytes) throw new FileServiceError("LIMIT_EXCEEDED");
			const after = await handle.stat();
			const current = await lstat(await resolve(grant, path));
			if (
				length !== before.size ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs ||
				current.ino !== after.ino ||
				current.dev !== after.dev
			)
				throw new FileServiceError("VERSION_CONFLICT");
			return { bytes: bytes.subarray(0, length), mode: before.mode };
		} finally {
			await handle.close();
		}
	}
	async function read(grant: Grant, path: string): Promise<{ content: FileText; mode: number }> {
		const result = await readBytes(grant, path, FILE_LIMITS.bytes);
		return { content: textContent(result.bytes), mode: result.mode };
	}
	function saveText(
		principalId: string,
		target: FileTarget,
		text: string,
		ifMatch: string,
		withCommitPermit?: FileCommitPermit,
	): Promise<FileText> {
		return bounded(async () => {
			const grant = await authorize(principalId, target, true);
			const path = validateRelativePath(target.path);
			if (typeof text !== "string" || typeof ifMatch !== "string" || !/^[a-f0-9]{64}$/.test(ifMatch))
				throw new FileServiceError("INVALID_PATH");
			if (Buffer.byteLength(text) > FILE_LIMITS.bytes) throw new FileServiceError("LIMIT_EXCEEDED");
			const next = textContent(Buffer.from(text));
			if (next.text !== text) throw new FileServiceError("UNSUPPORTED_ENCODING");
			const filename = await resolve(grant, path);
			const identity = await lstat(filename);
			// Inode identity also covers alternate casing and overlapping root grants.
			const writeKey = `${identity.dev}:${identity.ino}`;
			if (writing.has(writeKey)) throw new FileServiceError("BUSY");
			writing.add(writeKey);
			let temporary: string | undefined;
			let renameStarted = false;
			let renameCompleted = false;
			let permitActive = true;
			let commitCalled = false;
			try {
				const original = await read(grant, path);
				if (original.content.revision !== ifMatch) throw new FileServiceError("VERSION_CONFLICT");
				const candidate = join(dirname(filename), `.hipi-save-${randomUUID()}`);
				const handle = await open(candidate, "wx", original.mode & 0o777);
				temporary = candidate;
				try {
					await handle.writeFile(text);
					await handle.chmod(original.mode & 0o777);
					await handle.sync();
				} finally {
					await handle.close();
				}
				const commit = async () => {
					if (!permitActive || commitCalled) throw new FileServiceError("UNAUTHORIZED");
					commitCalled = true;
					await authorize(principalId, target, true);
					if ((await read(grant, path)).content.revision !== ifMatch)
						throw new FileServiceError("VERSION_CONFLICT");
					if (!permitActive || grants.get(target.rootId) !== grant) throw new FileServiceError("UNAUTHORIZED");
					// No asynchronous gap between the final root check and starting rename.
					renameStarted = true;
					await rename(candidate, filename);
					renameCompleted = true;
					temporary = undefined;
					return next;
				};
				if (withCommitPermit) await withCommitPermit(commit);
				else await commit();
				if (!renameCompleted) throw new FileServiceError("UNAUTHORIZED");
				return next;
			} catch (error) {
				// Includes a lost gate acknowledgement after successful rename. Never retry here.
				if (renameStarted) throw new FileServiceError("WRITE_OUTCOME_UNKNOWN");
				throw error;
			} finally {
				permitActive = false;
				writing.delete(writeKey);
				if (temporary) await unlink(temporary).catch(() => undefined);
			}
		});
	}
	const authority: TrustedFileAuthority = {
		forAgent: (principalId) => {
			const manual = authority.forPrincipal(principalId);
			return {
				assertRoot: (workspaceId, rootId) => {
					if (closed) throw new FileServiceError("CLOSED");
					const grant = grants.get(rootId);
					if (!grant || grant.principalId !== principalId || grant.workspaceId !== workspaceId)
						throw new FileServiceError("UNAUTHORIZED");
				},
				listRoots: manual.listRoots,
				list: manual.list,
				readText: manual.readText,
				saveText: (target, text, ifMatch, withCommitPermit) => {
					if (typeof withCommitPermit !== "function") return Promise.reject(new FileServiceError("UNAUTHORIZED"));
					return saveText(principalId, target, text, ifMatch, withCommitPermit);
				},
			};
		},
		forPrincipalSnapshot: (principalId) => ({
			read: (target, maxBytes) =>
				bounded(async () => {
					if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SNAPSHOT_BYTES)
						throw new FileServiceError("LIMIT_EXCEEDED");
					const grant = await authorize(principalId, target);
					const result = await readBytes(grant, validateRelativePath(target.path), maxBytes);
					await authorize(principalId, target);
					return { bytes: Uint8Array.from(result.bytes), revision: digest(result.bytes) };
				}),
			assertAuthorized: (target) =>
				bounded(async () => {
					await authorize(principalId, target);
					validateRelativePath(target.path);
				}),
		}),
		close: async () => {
			closed = true;
			grants.clear();
			if (active === 0) drained.resolve();
			await drained.promise;
		},
		grantRoot: (input) =>
			bounded(async () => {
				if (
					!isAbsolute(input.absolutePath) ||
					!/^[a-zA-Z0-9_-]{1,128}$/.test(input.principalId) ||
					!/^[a-zA-Z0-9_-]{1,128}$/.test(input.workspaceId) ||
					typeof input.writable !== "boolean"
				)
					throw new FileServiceError("INVALID_PATH");
				await options.assertWorkspaceAccess(input.principalId, input.workspaceId);
				const canonicalPath = await realpath(input.absolutePath);
				const info = await lstat(canonicalPath, { bigint: true });
				if (!info.isDirectory()) throw new FileServiceError("BLOCKED_RESOURCE");
				if (
					input.expectedIdentity &&
					(canonicalPath !== input.expectedIdentity.canonicalPath ||
						info.dev.toString() !== input.expectedIdentity.device ||
						info.ino.toString() !== input.expectedIdentity.inode)
				)
					throw new FileServiceError("BLOCKED_RESOURCE");
				if (closed) throw new FileServiceError("CLOSED");
				if (grants.size >= FILE_LIMITS.roots) throw new FileServiceError("LIMIT_EXCEEDED");
				const displayName = rootDisplayName(canonicalPath);
				const root: FileRoot = {
					workspaceId: input.workspaceId,
					rootId: randomUUID(),
					writable: input.writable,
					...(displayName === undefined ? {} : { displayName }),
				};
				grants.set(root.rootId, {
					...root,
					principalId: input.principalId,
					canonicalPath,
					dev: info.dev,
					ino: info.ino,
				});
				return root;
			}),
		revokeRoot: (rootId) => {
			grants.delete(rootId);
		},
		forPrincipal: (principalId) => {
			const service: FileService = {
				listRoots: (workspaceId) =>
					bounded(async () => {
						if (typeof workspaceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId))
							throw new FileServiceError("UNAUTHORIZED");
						await options.assertWorkspaceAccess(principalId, workspaceId);
						if (closed) throw new FileServiceError("CLOSED");
						return [...grants.values()]
							.filter((grant) => grant.principalId === principalId && grant.workspaceId === workspaceId)
							.map(({ rootId, writable, displayName }) => ({
								workspaceId,
								rootId,
								writable,
								...(displayName === undefined ? {} : { displayName }),
							}));
					}),
				list: (target, cursor) =>
					bounded(async () => {
						const grant = await authorize(principalId, target);
						const path = validateRelativePath(target.path, true);
						const directory = await opendir(await resolve(grant, path));
						const entries: FileEntry[] = [];
						for await (const item of directory) {
							if (entries.length >= FILE_LIMITS.directoryEntries) throw new FileServiceError("LIMIT_EXCEEDED");
							const itemPath = path ? `${path}/${item.name}` : item.name;
							let kind: FileEntry["kind"] = item.isDirectory()
								? "directory"
								: item.isFile()
									? "file"
									: "blocked";
							try {
								validateRelativePath(itemPath);
							} catch {
								kind = "blocked";
							}
							entries.push({ name: item.name, path: itemPath, kind });
						}
						entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
						const revision = digest(JSON.stringify([target.rootId, path, entries]));
						let offset = 0;
						if (cursor !== undefined) {
							if (typeof cursor !== "string" || !/^[a-f0-9]{64}:[0-9]{1,5}$/.test(cursor))
								throw new FileServiceError("INVALID_PATH");
							const [version, index] = cursor.split(":");
							if (version !== revision) throw new FileServiceError("VERSION_CONFLICT");
							offset = Number(index);
							if (offset >= entries.length) throw new FileServiceError("INVALID_PATH");
						}
						await authorize(principalId, target);
						return {
							entries: entries.slice(offset, offset + FILE_LIMITS.page),
							nextCursor:
								offset + FILE_LIMITS.page < entries.length ? `${revision}:${offset + FILE_LIMITS.page}` : null,
						};
					}),
				readText: (target) =>
					bounded(async () => {
						const grant = await authorize(principalId, target);
						const result = await read(grant, validateRelativePath(target.path));
						await authorize(principalId, target);
						return result.content;
					}),
				saveText: (target, text, ifMatch) => saveText(principalId, target, text, ifMatch),
				preview: async (target) => {
					try {
						return { kind: "text", content: await service.readText(target), rendering: "plain-text-only" };
					} catch (error) {
						if (error instanceof FileServiceError && error.code === "UNSUPPORTED_ENCODING")
							return { kind: "unsupported", reason: "binary-or-encoding" };
						throw error;
					}
				},
			};
			return service;
		},
	};
	return authority;
}
