import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	openNodeSqliteStorageReadOnly,
	type ReadonlySqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { readToolActivities, readToolActivityText } from "../activities/storage.ts";
import { AppError, LIMITS, parseResult, type Scope } from "../contracts.ts";
import { readHistory, readMessageText, textEnd } from "../history.ts";
import { StoreOwnerLease } from "../store-owner.ts";
import { archiveEntries, archiveMessages } from "./archive-history.ts";
import { type BackupReservation, MaintenanceError } from "./contracts.ts";
import { canonicalDirectory, syncPath } from "./paths.ts";
import { openRecoveryCatalog, type RecoveryManifest, verifyRecovery } from "./recovery-format.ts";
import { closeRecoveryDatabase, closeRecoveryStorage, retainOwnerOnCloseFailure } from "./recovery-resources.ts";

export type ArchiveIdentity = { storeId: string };
export type ArchiveScope = ArchiveIdentity & Scope;
export type ArchiveInfo = {
	storeId: string;
	restoreId: string;
	backupId: string;
	sourceStoreId: string;
	snapshotAt: string;
	mode: "recovery_archive";
	readOnly: true;
	reservations: BackupReservation[];
};
export async function openRecoveryArchive({ directory }: { directory: string }): Promise<RecoveryArchive> {
	return RecoveryArchive.open(directory);
}
/** No execution, approval, credentials, package installation or file-grant capabilities. */
export class RecoveryArchive {
	readonly info: ArchiveInfo;
	readonly #root: string;
	readonly #owner: StoreOwnerLease;
	readonly #db: DatabaseSync;
	readonly #manifest: RecoveryManifest;
	#closed = false;
	#closeFailed = false;
	#active = 0;
	private constructor(root: string, owner: StoreOwnerLease, db: DatabaseSync, manifest: RecoveryManifest) {
		this.#root = root;
		this.#owner = owner;
		this.#db = db;
		this.#manifest = manifest;
		this.info = Object.freeze({
			storeId: manifest.storeId,
			restoreId: manifest.restoreId,
			backupId: manifest.backupManifest.backupId,
			sourceStoreId: manifest.backupManifest.sourceStoreId,
			snapshotAt: manifest.backupManifest.createdAt,
			mode: "recovery_archive",
			readOnly: true,
			reservations: manifest.backupManifest.reservations.map((x) => ({ ...x })),
		});
	}
	static async open(directory: string): Promise<RecoveryArchive> {
		const root = await canonicalDirectory(directory);
		const owner = await StoreOwnerLease.acquire(root);
		try {
			const manifest = await verifyRecovery(root);
			return new RecoveryArchive(root, owner, openRecoveryCatalog(join(root, "catalog.sqlite")), manifest);
		} catch (error) {
			if (!retainOwnerOnCloseFailure(error, owner)) owner.close();
			throw error;
		}
	}
	#check(input: ArchiveIdentity): void {
		if (this.#closed) throw new AppError("CLOSED");
		if (input.storeId !== this.info.storeId) throw new AppError("STORE_MISMATCH");
	}
	#encode(scope: string, after: string): string {
		return Buffer.from(JSON.stringify({ v: 1, storeId: this.info.storeId, scope, after })).toString("base64url");
	}
	#decode(cursor: string | undefined, scope: string): string | undefined {
		if (cursor === undefined) return undefined;
		try {
			if (cursor.length > LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
			const p: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
			if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error();
			const row = p as Record<string, unknown>;
			if (
				Object.keys(row).sort().join() !== "after,scope,storeId,v" ||
				row.v !== 1 ||
				row.storeId !== this.info.storeId ||
				row.scope !== scope ||
				typeof row.after !== "string"
			)
				throw new Error();
			return row.after;
		} catch {
			throw new AppError("INVALID_REQUEST");
		}
	}
	async listWorkspaces(input: ArchiveIdentity & { cursor?: string }) {
		this.#check(input);
		const after = this.#decode(input.cursor, "workspaces") ?? "";
		const rows = this.#db
			.prepare("SELECT workspace_id FROM workspaces WHERE ready=1 AND workspace_id>? ORDER BY workspace_id LIMIT 51")
			.all(after);
		const items = rows.slice(0, 50).map((row) => {
			const workspace = this.#manifest.backupManifest.workspaces.find((w) => w.workspaceId === row.workspace_id);
			if (!workspace) throw new MaintenanceError("IDENTITY_MISMATCH");
			return { ...workspace };
		});
		return {
			items,
			nextCursor: rows.length > 50 ? this.#encode("workspaces", items[items.length - 1].workspaceId) : null,
		};
	}
	async listConversations(input: ArchiveIdentity & { workspaceId: string; cursor?: string }) {
		this.#check(input);
		this.#workspace(input.workspaceId);
		const scope = `conversations:${input.workspaceId}`;
		const after = this.#decode(input.cursor, scope) ?? "";
		const rows = this.#db
			.prepare(
				"SELECT public_id,value FROM archive_conversations WHERE workspace_id=? AND public_id>? ORDER BY public_id LIMIT 51",
			)
			.all(input.workspaceId, after);
		const items = rows.slice(0, 50).map((row) => {
			if (typeof row.value !== "string") throw new MaintenanceError("INTEGRITY_FAILED");
			return parseResult("getConversation", JSON.parse(row.value));
		});
		return {
			items,
			nextCursor: rows.length > 50 ? this.#encode(scope, items[items.length - 1].conversationId) : null,
		};
	}
	#workspace(id: string): void {
		if (!this.#manifest.backupManifest.workspaces.some((w) => w.workspaceId === id)) throw new AppError("NOT_FOUND");
	}
	async #read<T>(
		input: ArchiveScope,
		action: (
			entries: ReturnType<typeof archiveEntries>,
			storage: ReadonlySqliteStorage,
			durableId: number,
		) => Promise<T>,
	): Promise<T> {
		this.#check(input);
		this.#workspace(input.workspaceId);
		const row = this.#db
			.prepare("SELECT durable_id FROM archive_conversations WHERE workspace_id=? AND public_id=?")
			.get(input.workspaceId, input.conversationId);
		if (!row || typeof row.durable_id !== "number") throw new AppError("NOT_FOUND");
		this.#active++;
		try {
			const storage = await openNodeSqliteStorageReadOnly(join(this.#root, input.workspaceId, "workspace.sqlite"));
			try {
				return await action(archiveEntries(storage, row.durable_id), storage, row.durable_id);
			} finally {
				await closeRecoveryStorage(storage);
			}
		} catch (error) {
			if (retainOwnerOnCloseFailure(error, this.#owner)) this.#closeFailed = true;
			throw error;
		} finally {
			this.#active--;
		}
	}
	async getHistory(input: ArchiveScope & { cursor?: string }) {
		const scope = `history:${input.workspaceId}:${input.conversationId}`;
		const page = await this.#read(input, (entries) =>
			readHistory(
				entries,
				{ workspaceId: input.workspaceId, conversationId: input.conversationId },
				this.#decode(input.cursor, scope),
			),
		);
		return {
			...page,
			storeId: this.info.storeId,
			nextCursor: page.nextCursor === null ? null : this.#encode(scope, page.nextCursor),
		};
	}
	async getMessageText(input: ArchiveScope & { messageId: string; offset: number }) {
		return this.#read(input, async (entries) => ({
			...(await readMessageText(
				entries,
				{ workspaceId: input.workspaceId, conversationId: input.conversationId },
				input.messageId,
				input.offset,
			)),
			storeId: this.info.storeId,
		}));
	}
	async getToolActivities(input: ArchiveScope & { cursor?: string }) {
		return this.#read(input, async (_entries, storage, durableId) => {
			const approvalExpiryEvaluatedAt = Date.now();
			const page = await readToolActivities(
				storage,
				{ ...input, durableId, generation: this.info.storeId },
				input.cursor,
			);
			return {
				...page,
				storeId: this.info.storeId,
				snapshotAt: this.info.snapshotAt,
				readOnly: true as const,
				evidence: "snapshot_only" as const,
				approvalExpiryEvaluatedAt,
			};
		});
	}
	async getToolActivityText(input: ArchiveScope & { activityId: string; cursor?: string }) {
		return this.#read(input, async (_entries, storage, durableId) => ({
			...(await readToolActivityText(
				storage,
				{ ...input, durableId, generation: this.info.storeId },
				input.activityId,
				input.cursor,
			)),
			storeId: this.info.storeId,
			snapshotAt: this.info.snapshotAt,
			readOnly: true as const,
			evidence: "snapshot_only" as const,
		}));
	}
	async exportHistory(
		input: ArchiveScope & { destination: string },
	): Promise<{ destination: string; messages: number }> {
		this.#check(input);
		this.#active++;
		try {
			const destination = join(
				await canonicalDirectory(dirname(resolve(input.destination))),
				basename(input.destination),
			);
			// Export cannot introduce artifacts into the sealed archive itself.
			const delta = relative(this.#root.toLowerCase(), destination.toLowerCase());
			if (delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta)))
				throw new MaintenanceError("INVALID_PATH");
			const file = await open(destination, "wx", 0o600);
			let messages = 0;
			try {
				await file.writeFile(
					`${JSON.stringify({ type: "snapshot", ...this.info, order: "chronological", workspaceId: input.workspaceId, conversationId: input.conversationId, warning: "Historical snapshot only. Pending, approved and unknown effects are not resumed or revalidated. Content may contain private data and secrets." })}\n`,
				);
				await this.#read(input, async (_entries, storage, durableId) => {
					for await (const { message, text } of archiveMessages(storage, durableId)) {
						messages++;
						await file.writeFile(`${JSON.stringify({ type: "message", ...message })}\n`);
						let offset = 0;
						do {
							const end = textEnd(text, offset, LIMITS.textChunk);
							await file.writeFile(
								`${JSON.stringify({ type: "text", storeId: this.info.storeId, workspaceId: input.workspaceId, conversationId: input.conversationId, messageId: message.id, text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, textLength: text.length })}\n`,
							);
							offset = end;
						} while (offset < text.length);
					}
				});
				await file.writeFile(`${JSON.stringify({ type: "complete", messages })}\n`);
				await file.sync();
			} finally {
				await file.close();
			}
			await syncPath(dirname(destination));
			return { destination, messages };
		} finally {
			this.#active--;
		}
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		if (this.#active || this.#closeFailed) throw new MaintenanceError("BUSY");
		try {
			closeRecoveryDatabase(this.#db);
		} catch (error) {
			retainOwnerOnCloseFailure(error, this.#owner);
			this.#closeFailed = true;
			throw error;
		}
		this.#owner.close();
		this.#closed = true;
	}
}
