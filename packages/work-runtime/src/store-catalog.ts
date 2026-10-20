import { randomUUID } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readToolActivities, readToolActivityText } from "./activities/storage.ts";
import { readAgentCommandResult } from "./agent-tools/authorization-store.ts";
import {
	AppError,
	CUSTOM_PROVIDER_LIMITS,
	LIMITS,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type Result,
	type Workspace,
} from "./contracts.ts";
import { commandKey, DIRECTORY_LIMITS, directoryDigest } from "./conversation-directory.ts";
import { previewToolPack } from "./extensions/lifecycle.ts";
import {
	readActiveToolPackBindings,
	readToolPackBindings,
	readToolPackCommandResult,
	readToolPackSource,
	readToolPacks,
} from "./extensions/lifecycle-read.ts";
import { FileServiceError } from "./files/contracts.ts";
import { fileIdentifier } from "./files/protocol.ts";
import { type ProjectFolderBinding, type ProjectFolderRecord, parseProjectFolderRecord } from "./project-folders.ts";
import { checkDatabasePath, StoreOwnerLease } from "./store-owner.ts";

async function readDocument(storage: Storage, kind: string, key?: string) {
	const record = await storage.findDocument(
		{ kind, scope: { kind: "session" }, ...(key === undefined ? {} : { key }) },
		"current",
		BACKGROUND_CONTEXT,
	);
	const doc = record ? await storage.document(record.id, "current", BACKGROUND_CONTEXT) : undefined;
	if (doc && doc.version !== 1) throw new AppError("INVALID_REQUEST");
	return doc?.value;
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("INVALID_REQUEST");
	return value;
}

export { checkDatabasePath } from "./store-owner.ts";

/** Reads public PI storage documents without opening a Harness or scheduling work. */
export async function readWorkspaceDirectory(path: string, workspaceId: string) {
	const database = join(path, "workspace.sqlite");
	await checkDatabasePath(database);
	try {
		await lstat(database);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new AppError("NOT_FOUND");
		throw error;
	}
	const storage = await openNodeSqliteStorage(database, { synchronous: "FULL" });
	try {
		const header = await readDocument(storage, "hipi.workspace-directory");
		const doc = header?.initialized === true ? header : await readDocument(storage, "hipi.workspace");
		if (!doc) throw new AppError("NOT_FOUND");
		const workspace = parseResult("openWorkspace", { workspaceId: doc.workspaceId, name: doc.name });
		if (workspace.workspaceId !== workspaceId) throw new AppError("INVALID_REQUEST");
		return { workspace };
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

/** Root directory authority: single owner, persistent identity and recoverable workspace registration. */
export class StoreCatalog {
	readonly storeId: string;
	readonly #root: string;
	readonly #owner: StoreOwnerLease;
	readonly #database: DatabaseSync;
	#closed = false;
	#projection: Promise<unknown> = Promise.resolve();
	private constructor(root: string, owner: StoreOwnerLease, database: DatabaseSync, storeId: string) {
		this.#root = root;
		this.#owner = owner;
		this.#database = database;
		this.storeId = storeId;
	}
	static async open(root: string): Promise<StoreCatalog> {
		const catalogPath = join(root, "catalog.sqlite");
		await checkDatabasePath(catalogPath);
		const owner = await StoreOwnerLease.acquire(root);
		let database: DatabaseSync | undefined;
		let connectionCloseFailed = false;
		try {
			// Recovery markers are a one-way execution fence, even when identity was lost.
			// Inspect existing data read-only before CREATE, migration or directory recovery.
			const recoveryMarker = await lstat(join(root, "recovery-manifest.json")).catch((error) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			});
			if (recoveryMarker) throw new AppError("STORE_MISMATCH");
			const existing = await lstat(catalogPath).catch((error) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			});
			if (existing) {
				database = new DatabaseSync(catalogPath, { readOnly: true, allowExtension: false });
				database.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON");
				if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name='recovery_state'").get())
					throw new AppError("STORE_MISMATCH");
				if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name='identity' AND type='table'").get()) {
					const row = database.prepare("SELECT version FROM identity WHERE singleton=1").get();
					if (
						row &&
						row.version !== 1 &&
						row.version !== 2 &&
						row.version !== 3 &&
						row.version !== 5 &&
						row.version !== 6
					)
						throw new AppError("STORE_MISMATCH");
					if (
						row?.version === 6 &&
						!database.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_folders' AND type='table'").get()
					)
						throw new AppError("STORE_MISMATCH");
				}
				try {
					database.close();
				} catch (error) {
					connectionCloseFailed = true;
					owner.retainUntilExit();
					throw error;
				}
				database = undefined;
			}
			database = new DatabaseSync(catalogPath);
			database.exec(
				"PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, store_id TEXT NOT NULL, root TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspaces (workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)))",
			);
			let identity = database.prepare("SELECT version, store_id, root FROM identity WHERE singleton=1").get();
			if (!identity) {
				// A lost root identity is not an empty store. Never silently assign existing PI data a new owner.
				for await (const entry of await opendir(root)) {
					if (!entry.isDirectory()) continue;
					try {
						await lstat(join(root, entry.name, "workspace.sqlite"));
					} catch (error) {
						if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
						throw error;
					}
					throw new AppError("STORE_MISMATCH");
				}
				database.prepare("INSERT INTO identity VALUES (1,1,?,?)").run(randomUUID(), root);
				identity = database.prepare("SELECT version, store_id, root FROM identity WHERE singleton=1").get();
			}
			if (
				!identity ||
				(identity.version !== 1 &&
					identity.version !== 2 &&
					identity.version !== 3 &&
					identity.version !== 5 &&
					identity.version !== 6) ||
				identity.root !== root
			)
				throw new AppError("STORE_MISMATCH");
			// Version 6 adds local project associations; older runtimes cannot silently omit their revocation state.
			// Version 4 remains reserved for non-executing recovery archives.
			// Schema and version move together under the existing exclusive root owner.
			database.exec("BEGIN IMMEDIATE");
			try {
				database.exec(
					"CREATE TABLE IF NOT EXISTS conversations (workspace_id TEXT NOT NULL, public_id TEXT NOT NULL, ordinal INTEGER NOT NULL, revision INTEGER NOT NULL, archived INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace_id,public_id)); CREATE INDEX IF NOT EXISTS conversation_page ON conversations(workspace_id,archived,ordinal,public_id); CREATE TABLE IF NOT EXISTS directory_checkpoints (workspace_id TEXT PRIMARY KEY,generation TEXT NOT NULL,seq INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS custom_providers (provider TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS provider_commands (request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS project_folders (workspace_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, revision INTEGER NOT NULL, canonical_path TEXT, device TEXT, inode TEXT, display_name TEXT, revoked INTEGER NOT NULL CHECK(revoked IN (0,1))); UPDATE identity SET version=6 WHERE singleton=1 AND version IN (1,2,3,5)",
				);
				if (database.prepare("SELECT version FROM identity WHERE singleton=1").get()?.version !== 6)
					throw new AppError("STORE_MISMATCH");
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			const { storeId } = parseResult("handshake", {
				protocolVersion: PROTOCOL_VERSION,
				storeId: identity.store_id,
			});
			const catalog = new StoreCatalog(root, owner, database, storeId);
			catalog.listCustomProviders();
			await catalog.#recover();
			return catalog;
		} catch (error) {
			if (connectionCloseFailed) throw error;
			try {
				database?.close();
			} catch (closeError) {
				owner.retainUntilExit();
				throw closeError;
			}
			owner.close();
			throw error;
		}
	}
	/** Local host capability only. AppClient has no path-bearing catalog command. */
	readProjectFolder(workspaceId: string): ProjectFolderRecord | null {
		if (this.#closed) throw new FileServiceError("CLOSED");
		fileIdentifier(workspaceId);
		if (!this.registered(workspaceId)) throw new FileServiceError("UNAUTHORIZED");
		if (
			this.#database
				.prepare(
					"SELECT 1 FROM project_folders WHERE workspace_id=? AND (length(CAST(binding_id AS BLOB))>128 OR length(CAST(canonical_path AS BLOB))>12288 OR length(CAST(device AS BLOB))>40 OR length(CAST(inode AS BLOB))>40 OR length(CAST(display_name AS BLOB))>1020)",
				)
				.get(workspaceId)
		)
			throw new AppError("STORE_MISMATCH");
		const row = this.#database.prepare("SELECT * FROM project_folders WHERE workspace_id=?").get(workspaceId);
		if (!row) return null;
		if (
			typeof row.binding_id !== "string" ||
			typeof row.revision !== "number" ||
			(row.display_name !== null && typeof row.display_name !== "string") ||
			(row.revoked !== 0 && row.revoked !== 1)
		)
			throw new AppError("STORE_MISMATCH");
		const base = {
			workspaceId,
			bindingId: row.binding_id,
			revision: row.revision,
			displayName: row.display_name,
		};
		if (row.revoked === 1) {
			if (row.canonical_path !== null || row.device !== null || row.inode !== null)
				throw new AppError("STORE_MISMATCH");
			return parseProjectFolderRecord({ ...base, revoked: true, canonicalPath: null, device: null, inode: null });
		}
		if (typeof row.canonical_path !== "string" || typeof row.device !== "string" || typeof row.inode !== "string")
			throw new AppError("STORE_MISMATCH");
		return parseProjectFolderRecord({
			...base,
			revoked: false,
			canonicalPath: row.canonical_path,
			device: row.device,
			inode: row.inode,
		});
	}
	bindProjectFolder(input: ProjectFolderBinding, expectedBindingId: string | null): ProjectFolderRecord {
		const prior = this.readProjectFolder(input.workspaceId);
		if ((prior?.bindingId ?? null) !== expectedBindingId) throw new FileServiceError("VERSION_CONFLICT");
		const record = parseProjectFolderRecord({
			...input,
			revision: (prior?.revision ?? 0) + 1,
		});
		this.#database
			.prepare(
				"INSERT INTO project_folders VALUES (?,?,?,?,?,?,?,0) ON CONFLICT(workspace_id) DO UPDATE SET binding_id=excluded.binding_id,revision=excluded.revision,canonical_path=excluded.canonical_path,device=excluded.device,inode=excluded.inode,display_name=excluded.display_name,revoked=0",
			)
			.run(
				record.workspaceId,
				record.bindingId,
				record.revision,
				record.canonicalPath,
				record.device,
				record.inode,
				record.displayName,
			);
		return record;
	}
	unbindProjectFolder(workspaceId: string, expectedBindingId: string): ProjectFolderRecord {
		const prior = this.readProjectFolder(workspaceId);
		if (!prior || prior.bindingId !== expectedBindingId) throw new FileServiceError("VERSION_CONFLICT");
		if (prior.revoked) return prior;
		const record = parseProjectFolderRecord({
			...prior,
			revision: prior.revision + 1,
			revoked: true,
			canonicalPath: null,
			device: null,
			inode: null,
		});
		this.#database
			.prepare(
				"UPDATE project_folders SET revision=?,canonical_path=NULL,device=NULL,inode=NULL,revoked=1 WHERE workspace_id=? AND binding_id=?",
			)
			.run(record.revision, workspaceId, expectedBindingId);
		return record;
	}
	listCustomProviders(): Result<"listCustomProviders"> {
		if (
			this.#database
				.prepare(
					"SELECT 1 FROM custom_providers WHERE length(CAST(provider AS BLOB))>71 OR length(CAST(value AS BLOB))>? LIMIT 1",
				)
				.get(CUSTOM_PROVIDER_LIMITS.configurationBytes)
		)
			throw new AppError("CAPACITY_EXCEEDED");
		const rows = this.#database
			.prepare("SELECT provider,value FROM custom_providers ORDER BY provider LIMIT ?")
			.all(CUSTOM_PROVIDER_LIMITS.providers + 1);
		return parseResult("listCustomProviders", {
			providers: rows.map((row) => {
				if (typeof row.value !== "string") throw new AppError("STORE_MISMATCH");
				const config = parseResult("saveCustomProvider", JSON.parse(row.value));
				if (config.provider !== row.provider) throw new AppError("STORE_MISMATCH");
				return config;
			}),
		});
	}
	/** Synchronous transaction: config, identity replacement and permanent replay result commit together. */
	saveCustomProvider(input: Params<"saveCustomProvider">): Result<"saveCustomProvider"> {
		return this.#providerCommand("saveCustomProvider", input, () => {
			const providers = this.listCustomProviders().providers;
			const prior = input.provider ? providers.find((entry) => entry.provider === input.provider) : undefined;
			if (input.provider && !prior) throw new AppError("NOT_FOUND");
			if (!prior && providers.length >= CUSTOM_PROVIDER_LIMITS.providers) throw new AppError("CAPACITY_EXCEEDED");
			const provider =
				prior && prior.baseUrl === input.baseUrl && prior.protocol === input.protocol
					? prior.provider
					: `custom_${randomUUID()}`;
			const value = parseResult("saveCustomProvider", {
				provider,
				vendorId: input.vendorId,
				name: input.name,
				protocol: input.protocol,
				baseUrl: input.baseUrl,
				models: input.models,
			});
			if (prior && prior.provider !== provider)
				this.#database.prepare("DELETE FROM custom_providers WHERE provider=?").run(prior.provider);
			this.#database
				.prepare("INSERT OR REPLACE INTO custom_providers VALUES (?,?)")
				.run(provider, JSON.stringify(value));
			return value;
		});
	}
	removeCustomProvider(input: Params<"removeCustomProvider">): Result<"removeCustomProvider"> {
		return this.#providerCommand("removeCustomProvider", input, () => {
			this.#database.prepare("DELETE FROM custom_providers WHERE provider=?").run(input.provider);
			return { provider: input.provider, removed: true };
		});
	}
	#providerCommand<M extends "saveCustomProvider" | "removeCustomProvider">(
		method: M,
		input: Params<M>,
		operation: () => Result<M>,
	): Result<M> {
		const digest = directoryDigest(method, input);
		const prior = this.#database
			.prepare("SELECT digest,result FROM provider_commands WHERE request_id=?")
			.get(input.requestId);
		if (prior) {
			if (prior.digest !== digest || typeof prior.result !== "string") throw new AppError("IDEMPOTENCY_CONFLICT");
			return parseResult(method, JSON.parse(prior.result));
		}
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.#database
				.prepare("INSERT INTO provider_commands VALUES (?,?,?)")
				.run(input.requestId, digest, JSON.stringify(result));
			this.#database.exec("COMMIT");
			return result;
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}
	async #recover(): Promise<void> {
		// Covers a crash after PI commit but before directory registration, including phase-one stores.
		// Bound traversal instead of silently omitting directories beyond the supported workload.
		const directory = await opendir(this.#root);
		for await (const entry of directory) {
			if (entry.isSymbolicLink()) throw new AppError("INVALID_REQUEST");
			if (!entry.isDirectory()) continue;
			parseRequest({ version: PROTOCOL_VERSION, method: "openWorkspace", params: { workspaceId: entry.name } });
			const existing = this.#database
				.prepare("SELECT name, ready FROM workspaces WHERE workspace_id=?")
				.get(entry.name);
			if (existing?.ready === 1) continue;
			try {
				const { workspace } = await readWorkspaceDirectory(join(this.#root, entry.name), entry.name);
				this.reserve(workspace);
				this.ready(workspace);
			} catch (error) {
				if (error instanceof AppError && error.code === "NOT_FOUND") continue;
				throw error;
			}
		}
	}
	reserve(workspace: Workspace): void {
		const prior = this.#database
			.prepare("SELECT name FROM workspaces WHERE workspace_id=?")
			.get(workspace.workspaceId);
		if (prior) {
			if (prior.name !== workspace.name) throw new AppError("IDEMPOTENCY_CONFLICT");
			return;
		}
		this.#database.prepare("INSERT INTO workspaces VALUES (?,?,0)").run(workspace.workspaceId, workspace.name);
	}
	registered(workspaceId: string): boolean {
		return this.#database.prepare("SELECT ready FROM workspaces WHERE workspace_id=?").get(workspaceId)?.ready === 1;
	}
	ready(workspace: Workspace): void {
		this.#database
			.prepare("UPDATE workspaces SET ready=1 WHERE workspace_id=? AND name=?")
			.run(workspace.workspaceId, workspace.name);
	}
	async getWorkspace(input: Params<"getWorkspace">): Promise<Workspace> {
		const row = this.#database
			.prepare("SELECT workspace_id AS workspaceId,name FROM workspaces WHERE workspace_id=? AND ready=1")
			.get(input.workspaceId);
		if (!row) throw new AppError("NOT_FOUND");
		return parseResult("openWorkspace", row);
	}
	async #readWorkspace<T>(workspaceId: string, read: (storage: Storage) => Promise<T>): Promise<T> {
		const workspace = await this.getWorkspace({ workspaceId });
		const directory = join(this.#root, workspaceId);
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError("INVALID_REQUEST");
		const path = join(directory, "workspace.sqlite");
		await checkDatabasePath(path);
		await lstat(path).catch(() => {
			throw new AppError("NOT_FOUND");
		});
		const storage = await openNodeSqliteStorage(path, { synchronous: "FULL" });
		try {
			const head = await readDocument(storage, "hipi.workspace-directory");
			const identity = head?.initialized === true ? head : await readDocument(storage, "hipi.workspace");
			if (!identity || identity.workspaceId !== workspaceId || identity.name !== workspace.name)
				throw new AppError("STORE_MISMATCH");
			return await read(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	}
	async #featureScope(storage: Storage, workspaceId: string, conversationId?: string) {
		const head = await readDocument(storage, "hipi.workspace-directory");
		if (head?.initialized !== true || typeof head.generation !== "string" || !head.generation)
			throw new AppError("INDEX_RECOVERY_REQUIRED");
		if (conversationId === undefined) return { generation: head.generation, durableId: undefined };
		const record = await readDocument(storage, "hipi.conversation-metadata", conversationId);
		if (record === undefined) throw new AppError("NOT_FOUND");
		const value = record.value;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INDEX_RECOVERY_REQUIRED");
		if (value.workspaceId !== workspaceId || value.conversationId !== conversationId)
			throw new AppError("STORE_MISMATCH");
		const durableId = count(value.durableId);
		if (durableId < 1) throw new AppError("INDEX_RECOVERY_REQUIRED");
		if (!(await storage.conversation(durableId as ConversationId, BACKGROUND_CONTEXT)))
			throw new AppError("INDEX_RECOVERY_REQUIRED");
		return { generation: head.generation, durableId };
	}
	async previewToolPack(input: Params<"previewToolPack">): Promise<Result<"previewToolPack">> {
		await this.getWorkspace(input);
		return previewToolPack(input.packageText);
	}
	async listToolPacks(input: Params<"listToolPacks">): Promise<Result<"listToolPacks">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const scope = await this.#featureScope(storage, input.workspaceId);
			return readToolPacks(storage, input.workspaceId, JSON.stringify([this.storeId, scope.generation]), input);
		});
	}
	async getToolPackSource(input: Params<"getToolPackSource">): Promise<Result<"getToolPackSource">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			await this.#featureScope(storage, input.workspaceId);
			return readToolPackSource(storage, input.workspaceId, input);
		});
	}
	async listToolPackBindings(input: Params<"listToolPackBindings">): Promise<Result<"listToolPackBindings">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const scope = await this.#featureScope(storage, input.workspaceId, input.conversationId);
			if (scope.durableId === undefined) throw new AppError("INDEX_RECOVERY_REQUIRED");
			return readToolPackBindings(
				storage,
				input.workspaceId,
				JSON.stringify([this.storeId, scope.generation]),
				input,
				scope.durableId,
			);
		});
	}
	async listActiveToolPackBindings(
		input: Params<"listActiveToolPackBindings">,
	): Promise<Result<"listActiveToolPackBindings">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const scope = await this.#featureScope(storage, input.workspaceId, input.conversationId);
			if (scope.durableId === undefined) throw new AppError("INDEX_RECOVERY_REQUIRED");
			return readActiveToolPackBindings(storage, input.workspaceId, input, scope.durableId);
		});
	}
	async getToolPackCommandResult(
		input: Params<"getToolPackCommandResult">,
	): Promise<Result<"getToolPackCommandResult">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const scope = await this.#featureScope(
				storage,
				input.workspaceId,
				"conversationId" in input ? input.conversationId : undefined,
			);
			return readToolPackCommandResult(storage, input, scope.durableId);
		});
	}
	async getToolActivities(input: Params<"getToolActivities">): Promise<Result<"getToolActivities">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const scope = await this.#featureScope(storage, input.workspaceId, input.conversationId);
			if (scope.durableId === undefined) throw new AppError("INDEX_RECOVERY_REQUIRED");
			return readToolActivities(
				storage,
				{
					workspaceId: input.workspaceId,
					conversationId: input.conversationId,
					durableId: scope.durableId,
					generation: scope.generation,
					storeId: this.storeId,
				},
				input.cursor,
			);
		});
	}
	async getToolActivityText(input: Params<"getToolActivityText">): Promise<Result<"getToolActivityText">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const scope = await this.#featureScope(storage, input.workspaceId, input.conversationId);
			if (scope.durableId === undefined) throw new AppError("INDEX_RECOVERY_REQUIRED");
			return readToolActivityText(
				storage,
				{
					workspaceId: input.workspaceId,
					conversationId: input.conversationId,
					durableId: scope.durableId,
					generation: scope.generation,
					storeId: this.storeId,
				},
				input.activityId,
				input.cursor,
			);
		});
	}
	async getConversation(input: Params<"getConversation">): Promise<Result<"getConversation">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const head = await readDocument(storage, "hipi.workspace-directory");
			if (head?.initialized === true) {
				const record = await readDocument(storage, "hipi.conversation-metadata", input.conversationId);
				const value = record?.value;
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("NOT_FOUND");
				const result = parseResult("getConversation", {
					workspaceId: value.workspaceId,
					conversationId: value.conversationId,
					title: value.title,
					revision: value.revision,
					createdAt: value.createdAt,
					archivedAt: value.archivedAt,
				});
				if (result.workspaceId !== input.workspaceId || result.conversationId !== input.conversationId)
					throw new AppError("STORE_MISMATCH");
				return result;
			}
			const legacy = await readDocument(storage, "hipi.workspace");
			if (
				!legacy ||
				legacy.workspaceId !== input.workspaceId ||
				!Array.isArray(legacy.conversations) ||
				legacy.conversations.length > 16
			)
				throw new AppError("INDEX_RECOVERY_REQUIRED");
			const item = legacy.conversations.find(
				(entry) =>
					entry && typeof entry === "object" && !Array.isArray(entry) && entry.publicId === input.conversationId,
			);
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new AppError("NOT_FOUND");
			return parseResult("getConversation", {
				...input,
				title: item.title,
				revision: 1,
				createdAt: null,
				archivedAt: null,
			});
		});
	}
	async getConversationCommandResult(
		input: Params<"getConversationCommandResult">,
	): Promise<Result<"getConversationCommandResult">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const record = await readDocument(
				storage,
				"hipi.directory-command",
				commandKey(input.workspaceId, input.requestId),
			);
			const result = parseResult("getConversationCommandResult", record?.value ?? null);
			if (result && result.result.workspaceId !== input.workspaceId) throw new AppError("STORE_MISMATCH");
			return result;
		});
	}
	async getAgentCommandResult(input: Params<"getAgentCommandResult">): Promise<Result<"getAgentCommandResult">> {
		return this.#readWorkspace(input.workspaceId, async (storage) => {
			const head = await readDocument(storage, "hipi.workspace-directory");
			// A read must neither migrate a legacy catalog nor report its commands as absent.
			if (head?.initialized !== true) throw new AppError("INDEX_RECOVERY_REQUIRED");
			const record = await readDocument(storage, "hipi.conversation-metadata", input.conversationId);
			const value = record?.value;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("NOT_FOUND");
			if (value.workspaceId !== input.workspaceId || value.conversationId !== input.conversationId)
				throw new AppError("STORE_MISMATCH");
			const durableId = count(value.durableId);
			if (durableId < 1) throw new AppError("INDEX_RECOVERY_REQUIRED");
			return readAgentCommandResult(storage, input.workspaceId, input.conversationId, durableId, input.requestId);
		});
	}
	async listWorkspaces(input: Params<"listWorkspaces"> = {}): Promise<Result<"listWorkspaces">> {
		const cursor = input.cursor === undefined ? undefined : this.#cursor(input.cursor, "workspaces");
		const after = cursor?.after;
		if (after !== undefined && typeof after !== "string") throw new AppError("INVALID_REQUEST");
		const rows = this.#database
			.prepare(
				"SELECT workspace_id AS workspaceId,name FROM workspaces WHERE ready=1 AND workspace_id>? ORDER BY workspace_id LIMIT ?",
			)
			.all(after ?? "", DIRECTORY_LIMITS.page + 1);
		const items = rows.slice(0, DIRECTORY_LIMITS.page).map((row) => parseResult("openWorkspace", row));
		return {
			items,
			nextCursor:
				rows.length > DIRECTORY_LIMITS.page
					? this.#encode({ scope: "workspaces", after: items[items.length - 1].workspaceId })
					: null,
		};
	}
	#encode(value: object): string {
		return Buffer.from(JSON.stringify({ ...value, storeId: this.storeId, version: 1 })).toString("base64url");
	}
	#cursor(raw: string, scope: string): Record<string, unknown> {
		try {
			if (raw.length > LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
			const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
			const result = value as Record<string, unknown>;
			if (result.storeId !== this.storeId || result.version !== 1 || result.scope !== scope) throw new Error();
			return result;
		} catch {
			throw new AppError("INVALID_REQUEST");
		}
	}
	async listConversations(input: Params<"listConversations">): Promise<Result<"listConversations">> {
		const result = this.#projection.then(() => this.#listConversations(input));
		this.#projection = result.catch(() => undefined);
		return result;
	}
	async #listConversations(input: Params<"listConversations">): Promise<Result<"listConversations">> {
		const workspace = await this.getWorkspace(input);
		const path = join(this.#root, input.workspaceId);
		if (!(await lstat(path)).isDirectory()) throw new AppError("INVALID_REQUEST");
		const databasePath = join(path, "workspace.sqlite");
		await checkDatabasePath(databasePath);
		await lstat(databasePath).catch(() => {
			throw new AppError("NOT_FOUND");
		});
		const storage = await openNodeSqliteStorage(databasePath, { synchronous: "FULL" });
		try {
			const head = await readDocument(storage, "hipi.workspace-directory");
			if (!head || head.initialized !== true) {
				// A pre-migration store can be browsed without starting a Harness. Its legacy array was bounded.
				const old = await readDocument(storage, "hipi.workspace");
				if (
					!old ||
					old.workspaceId !== workspace.workspaceId ||
					old.name !== workspace.name ||
					!Array.isArray(old.conversations) ||
					old.conversations.length > 16
				)
					throw new AppError("INDEX_RECOVERY_REQUIRED");
				if (input.cursor) throw new AppError("CURSOR_STALE");
				const items =
					input.filter === "archived"
						? []
						: old.conversations.map((entry) => {
								if (!entry || typeof entry !== "object" || Array.isArray(entry))
									throw new AppError("INVALID_REQUEST");
								return parseResult("getConversation", {
									workspaceId: workspace.workspaceId,
									conversationId: entry.publicId,
									title: entry.title,
									revision: 1,
									createdAt: null,
									archivedAt: null,
								});
							});
				return { items, nextCursor: null };
			}
			if (
				head.workspaceId !== workspace.workspaceId ||
				head.name !== workspace.name ||
				typeof head.generation !== "string"
			)
				throw new AppError("INDEX_RECOVERY_REQUIRED");
			const seq = count(head.changeSeq);
			const total = count(head.nextOrdinal);
			let checkpoint = this.#database
				.prepare("SELECT generation,seq FROM directory_checkpoints WHERE workspace_id=?")
				.get(input.workspaceId);
			const indexed = this.#database
				.prepare("SELECT count(*) AS total FROM conversations WHERE workspace_id=?")
				.get(input.workspaceId);
			if (
				!checkpoint ||
				checkpoint.generation !== head.generation ||
				count(checkpoint.seq) > seq ||
				(checkpoint.seq === seq && indexed?.total !== total)
			) {
				this.#database.exec("BEGIN IMMEDIATE");
				try {
					this.#database.prepare("DELETE FROM conversations WHERE workspace_id=?").run(input.workspaceId);
					this.#database
						.prepare("INSERT OR REPLACE INTO directory_checkpoints VALUES (?,?,0)")
						.run(input.workspaceId, head.generation);
					this.#database.exec("COMMIT");
				} catch (error) {
					this.#database.exec("ROLLBACK");
					throw error;
				}
				checkpoint = { generation: head.generation, seq: 0 };
			}
			let applied = count(checkpoint.seq);
			while (applied < seq) {
				const end = Math.min(seq, applied + 64);
				const values = [];
				for (let index = applied + 1; index <= end; index++) {
					const change = await readDocument(storage, "hipi.directory-change", String(index));
					if (!change || typeof change.publicId !== "string") throw new AppError("INDEX_RECOVERY_REQUIRED");
					const record = await readDocument(storage, "hipi.conversation-metadata", change.publicId);
					const value = record?.value;
					if (!value || typeof value !== "object" || Array.isArray(value))
						throw new AppError("INDEX_RECOVERY_REQUIRED");
					const conversation = parseResult("getConversation", {
						workspaceId: value.workspaceId,
						conversationId: value.conversationId,
						title: value.title,
						revision: value.revision,
						createdAt: value.createdAt,
						archivedAt: value.archivedAt,
					});
					if (
						conversation.workspaceId !== workspace.workspaceId ||
						conversation.conversationId !== change.publicId ||
						conversation.revision < count(change.revision)
					)
						throw new AppError("INDEX_RECOVERY_REQUIRED");
					values.push({ conversation, ordinal: count(value.ordinal) });
				}
				this.#database.exec("BEGIN IMMEDIATE");
				try {
					const put = this.#database.prepare(
						"INSERT INTO conversations VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,public_id) DO UPDATE SET ordinal=excluded.ordinal,revision=excluded.revision,archived=excluded.archived,value=excluded.value WHERE excluded.revision>=conversations.revision",
					);
					for (const { conversation, ordinal } of values)
						put.run(
							input.workspaceId,
							conversation.conversationId,
							ordinal,
							conversation.revision,
							Number(conversation.archivedAt !== null),
							JSON.stringify(conversation),
						);
					this.#database
						.prepare("UPDATE directory_checkpoints SET seq=? WHERE workspace_id=?")
						.run(end, input.workspaceId);
					this.#database.exec("COMMIT");
				} catch (error) {
					this.#database.exec("ROLLBACK");
					throw error;
				}
				applied = end;
			}
			const filter = input.filter ?? "active";
			const scope = `conversations:${input.workspaceId}:${filter}`;
			const cursor = input.cursor ? this.#cursor(input.cursor, scope) : undefined;
			if (cursor && (cursor.generation !== head.generation || cursor.seq !== seq))
				throw new AppError("CURSOR_STALE");
			const after = cursor ? count(cursor.after) : -1;
			const rows = this.#database
				.prepare(
					`SELECT ordinal,value FROM conversations WHERE workspace_id=? AND ordinal>? ${filter === "all" ? "" : "AND archived=?"} ORDER BY ordinal,public_id LIMIT ?`,
				)
				.all(
					input.workspaceId,
					after,
					...(filter === "all" ? [] : [Number(filter === "archived")]),
					DIRECTORY_LIMITS.page + 1,
				);
			const page = rows.slice(0, DIRECTORY_LIMITS.page);
			const items = page.map((row) => {
				if (typeof row.value !== "string") throw new AppError("INDEX_RECOVERY_REQUIRED");
				return parseResult("getConversation", JSON.parse(row.value));
			});
			return {
				items,
				nextCursor:
					rows.length > DIRECTORY_LIMITS.page
						? this.#encode({ scope, generation: head.generation, seq, after: page[page.length - 1].ordinal })
						: null,
			};
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	}

	close(): void {
		if (this.#closed) return;
		try {
			this.#database.close();
		} catch (error) {
			this.#owner.retainUntilExit();
			throw error;
		}
		this.#owner.close();
		this.#closed = true;
	}
}
