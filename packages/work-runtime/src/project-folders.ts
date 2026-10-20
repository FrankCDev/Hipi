import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type FileRoot, FileServiceError, type ProjectFolder, type ProjectFolderSelection } from "./files/contracts.ts";
import { rootDisplayName } from "./files/display-name.ts";
import { fileIdentifier, parseProjectFolder } from "./files/protocol.ts";
import type { TrustedFileAuthority } from "./files/service.ts";

/** Local catalog metadata only. Never serialize this record into public app or file responses. */
export type ProjectFolderRecord = {
	workspaceId: string;
	bindingId: string;
	revision: number;
	displayName: string | null;
} & (
	| { revoked: false; canonicalPath: string; device: string; inode: string }
	| { revoked: true; canonicalPath: null; device: null; inode: null }
);
export type ProjectFolderBinding = Omit<Extract<ProjectFolderRecord, { revoked: false }>, "revision">;
export interface ProjectFolderCatalog {
	readProjectFolder(workspaceId: string): ProjectFolderRecord | null;
	bindProjectFolder(record: ProjectFolderBinding, expectedBindingId: string | null): ProjectFolderRecord;
	unbindProjectFolder(workspaceId: string, expectedBindingId: string): ProjectFolderRecord;
}
const runtimeCatalogs = new WeakMap<object, ProjectFolderCatalog>();

/** Called only by the local Node runtime composition root, never by AppClient dispatch. */
export function registerRuntimeProjectFolders(runtime: object, catalog: ProjectFolderCatalog): void {
	runtimeCatalogs.set(runtime, catalog);
}

export function parseProjectFolderRecord(value: ProjectFolderRecord): ProjectFolderRecord {
	fileIdentifier(value.workspaceId);
	fileIdentifier(value.bindingId);
	if (
		!Number.isSafeInteger(value.revision) ||
		value.revision < 1 ||
		(value.displayName !== null &&
			(typeof value.displayName !== "string" ||
				!value.displayName ||
				[...value.displayName].length > 255 ||
				/[\p{Cc}\p{Cf}\p{Cs}/\\]/u.test(value.displayName)))
	)
		throw new FileServiceError("INVALID_PATH");
	if (value.revoked) {
		if (value.canonicalPath !== null || value.device !== null || value.inode !== null)
			throw new FileServiceError("INVALID_PATH");
	} else if (
		typeof value.canonicalPath !== "string" ||
		!isAbsolute(value.canonicalPath) ||
		value.canonicalPath.length > 4096 ||
		value.canonicalPath.includes("\0") ||
		typeof value.device !== "string" ||
		!/^(0|[1-9][0-9]{0,39})$/.test(value.device) ||
		typeof value.inode !== "string" ||
		!/^(0|[1-9][0-9]{0,39})$/.test(value.inode)
	)
		throw new FileServiceError("INVALID_PATH");
	return value;
}

/** Node-only host capability. Persistent bindings never contain roots, consent, or write approvals. */
export function createRuntimeProjectFolders(runtime: object, authority: TrustedFileAuthority, principalId: string) {
	const registered = runtimeCatalogs.get(runtime);
	if (!registered) return undefined;
	const catalog = registered;
	const roots = new Map<string, { bindingId: string; root: FileRoot }>();
	const selections = new Map<
		string,
		{
			canonicalPath: string;
			device: string;
			inode: string;
			displayName: string | null;
			expires: number;
		}
	>();
	const active = new Set<string>();
	const reads = new Map<string, Promise<ProjectFolder>>();
	let closed = false;
	const drained = Promise.withResolvers<void>();
	const service = authority.forPrincipal(principalId);
	function revoke(workspaceId: string): void {
		const current = roots.get(workspaceId);
		if (current) authority.revokeRoot(current.root.rootId);
		roots.delete(workspaceId);
	}
	function assertOpen(): void {
		if (closed) throw new FileServiceError("CLOSED");
	}
	async function exclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
		assertOpen();
		fileIdentifier(workspaceId);
		if (active.has(workspaceId)) throw new FileServiceError("BUSY");
		active.add(workspaceId);
		try {
			return await operation();
		} finally {
			active.delete(workspaceId);
			if (closed && active.size === 0) drained.resolve();
		}
	}
	function state(record: ProjectFolderRecord, status: "unavailable" | "moved" | "revoked"): ProjectFolder {
		return parseProjectFolder(
			{
				workspaceId: record.workspaceId,
				bindingId: record.bindingId,
				revision: record.revision,
				displayName: record.displayName,
				status,
				root: null,
			},
			record.workspaceId,
		);
	}
	async function open(record: ProjectFolderRecord): Promise<ProjectFolder> {
		assertOpen();
		if (record.revoked) {
			revoke(record.workspaceId);
			return state(record, "revoked");
		}
		try {
			const info = await lstat(record.canonicalPath, { bigint: true });
			if (
				!info.isDirectory() ||
				info.isSymbolicLink() ||
				info.dev.toString() !== record.device ||
				info.ino.toString() !== record.inode ||
				(await realpath(record.canonicalPath)) !== record.canonicalPath
			) {
				revoke(record.workspaceId);
				return state(record, "moved");
			}
		} catch {
			revoke(record.workspaceId);
			return state(record, "unavailable");
		}
		assertOpen();
		let current = roots.get(record.workspaceId);
		if (current?.bindingId !== record.bindingId) {
			revoke(record.workspaceId);
			current = undefined;
		}
		if (
			current &&
			!(await service.listRoots(record.workspaceId)).some((root) => root.rootId === current?.root.rootId)
		) {
			const revoked = catalog.unbindProjectFolder(record.workspaceId, record.bindingId);
			revoke(record.workspaceId);
			return state(revoked, "revoked");
		}
		assertOpen();
		if (!current) {
			const root = await authority.grantRoot({
				principalId,
				workspaceId: record.workspaceId,
				absolutePath: record.canonicalPath,
				writable: false,
				expectedIdentity: record,
			});
			if (closed) {
				authority.revokeRoot(root.rootId);
				throw new FileServiceError("CLOSED");
			}
			current = { bindingId: record.bindingId, root };
			roots.set(record.workspaceId, current);
		}
		return parseProjectFolder(
			{
				workspaceId: record.workspaceId,
				bindingId: record.bindingId,
				revision: record.revision,
				displayName: record.displayName,
				status: "available",
				root: current.root,
			},
			record.workspaceId,
		);
	}
	async function capture(absolutePath: string) {
		assertOpen();
		if (!isAbsolute(absolutePath) || absolutePath.length > 4096 || absolutePath.includes("\0"))
			throw new FileServiceError("INVALID_PATH");
		const chosen = await lstat(absolutePath);
		if (!chosen.isDirectory() || chosen.isSymbolicLink()) throw new FileServiceError("BLOCKED_RESOURCE");
		const canonicalPath = await realpath(absolutePath);
		const info = await lstat(canonicalPath, { bigint: true });
		if (!info.isDirectory() || info.isSymbolicLink()) throw new FileServiceError("BLOCKED_RESOURCE");
		assertOpen();
		return {
			canonicalPath,
			device: info.dev.toString(),
			inode: info.ino.toString(),
			displayName: rootDisplayName(canonicalPath) ?? null,
		};
	}
	async function bind(
		workspaceId: string,
		identity: Awaited<ReturnType<typeof capture>>,
		expectedBindingId: string | null,
	): Promise<ProjectFolder> {
		assertOpen();
		const candidate = { ...identity, workspaceId, bindingId: randomUUID(), revoked: false as const };
		// Grant first, commit second: a failed identity check never replaces a prior binding.
		const root = await authority.grantRoot({
			principalId,
			workspaceId,
			absolutePath: identity.canonicalPath,
			writable: false,
			expectedIdentity: identity,
		});
		try {
			assertOpen();
			const record = catalog.bindProjectFolder(candidate, expectedBindingId);
			revoke(workspaceId);
			roots.set(workspaceId, { bindingId: record.bindingId, root });
			return parseProjectFolder(
				{
					workspaceId,
					bindingId: record.bindingId,
					revision: record.revision,
					displayName: record.displayName,
					status: "available",
					root,
				},
				workspaceId,
			);
		} catch (error) {
			authority.revokeRoot(root.rootId);
			throw error;
		}
	}
	return {
		prepare: (absolutePath: string): Promise<ProjectFolderSelection> =>
			exclusive("project-selection", async () => {
				for (const [id, selection] of selections) if (selection.expires <= Date.now()) selections.delete(id);
				if (selections.size >= 8) throw new FileServiceError("LIMIT_EXCEEDED");
				const identity = await capture(absolutePath);
				const selectionId = randomUUID();
				selections.set(selectionId, { ...identity, expires: Date.now() + 15 * 60_000 });
				return { selectionId, displayName: identity.displayName };
			}),
		attach: (workspaceId: string, selectionId: string): Promise<ProjectFolder> =>
			exclusive(workspaceId, async () => {
				catalog.readProjectFolder(workspaceId);
				const selection = selections.get(fileIdentifier(selectionId));
				if (!selection || selection.expires <= Date.now()) {
					selections.delete(selectionId);
					throw new FileServiceError("UNAUTHORIZED");
				}
				selections.delete(selectionId);
				return bind(workspaceId, selection, null);
			}),
		forget: (selectionId: string): void => {
			assertOpen();
			selections.delete(fileIdentifier(selectionId));
		},
		get: (workspaceId: string): Promise<ProjectFolder> => {
			const prior = reads.get(workspaceId);
			if (prior) return prior;
			const result = exclusive<ProjectFolder>(workspaceId, async () => {
				const record = catalog.readProjectFolder(workspaceId);
				if (record) return open(record);
				revoke(workspaceId);
				return { workspaceId, status: "unbound", bindingId: null, revision: 0, displayName: null, root: null };
			});
			reads.set(workspaceId, result);
			void result.finally(() => reads.delete(workspaceId)).catch(() => undefined);
			return result;
		},
		bind: (workspaceId: string, absolutePath: string, expectedBindingId: string | null): Promise<ProjectFolder> =>
			exclusive(workspaceId, async () => {
				if (expectedBindingId !== null) fileIdentifier(expectedBindingId);
				const prior = catalog.readProjectFolder(workspaceId);
				if ((prior?.bindingId ?? null) !== expectedBindingId) throw new FileServiceError("VERSION_CONFLICT");
				return bind(workspaceId, await capture(absolutePath), expectedBindingId);
			}),
		unbind: (workspaceId: string, expectedBindingId: string): Promise<ProjectFolder> =>
			exclusive(workspaceId, async () => {
				const record = catalog.unbindProjectFolder(workspaceId, fileIdentifier(expectedBindingId));
				revoke(workspaceId);
				return state(record, "revoked");
			}),
		revokeRoot: (workspaceId: string, rootId: string): boolean => {
			assertOpen();
			const current = roots.get(workspaceId);
			if (!current || current.root.rootId !== rootId) return false;
			if (active.has(workspaceId)) throw new FileServiceError("BUSY");
			catalog.unbindProjectFolder(workspaceId, current.bindingId);
			revoke(workspaceId);
			return true;
		},
		close: async (): Promise<void> => {
			closed = true;
			selections.clear();
			for (const workspaceId of roots.keys()) revoke(workspaceId);
			if (active.size === 0) drained.resolve();
			await drained.promise;
		},
	};
}
