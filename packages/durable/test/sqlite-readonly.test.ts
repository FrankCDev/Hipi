import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageRequestError } from "../src/errors.ts";
import { idFromNumber } from "../src/ids.ts";
import { ReadonlyCapacityError, SqliteStorage } from "../src/storage/sqlite/index.ts";
import {
	openNodeSqliteDatabaseReadOnly,
	openNodeSqliteStorage,
	openNodeSqliteStorageReadOnly,
	type ReadonlySqliteStorage,
} from "../src/storage/sqlite/node.ts";
import { type ConversationId, type DocumentId, type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const storages: ReadonlySqliteStorage[] = [];

afterEach(async () => {
	for (const storage of storages.splice(0)) await storage.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(prefix?: string) {
	const directory = await mkdtemp(join(tmpdir(), "durable-readonly-"));
	directories.push(directory);
	const path = join(directory, "db.sqlite");
	const writer = await openNodeSqliteStorage(path, { prefix, walAutoCheckpointPages: 0 });
	storages.push(writer);
	return { path, writer };
}

describe("read-only durable SQLite", () => {
	it.each([false, true])("retains failed-close ownership, including failed open: %s", async (invalid) => {
		const { path, writer } = await fixture();
		await writer.close(context);
		if (invalid) {
			const native = new DatabaseSync(path);
			native.exec("UPDATE durable_schema SET version = 99");
			native.close();
		}
		const database = await openNodeSqliteDatabaseReadOnly(path);
		const close = vi.spyOn(database, "close").mockRejectedValue(new Error("injected close failure"));
		try {
			if (invalid) {
				await expect(SqliteStorage.openReadOnly(database)).rejects.toMatchObject({ code: "READONLY_CLOSE_FAILED" });
			} else {
				const reader = await SqliteStorage.openReadOnly(database);
				await expect(reader.close(context)).rejects.toMatchObject({ code: "READONLY_CLOSE_FAILED" });
				await expect(reader.close(context)).rejects.toMatchObject({ code: "READONLY_CLOSE_FAILED" });
			}
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			close.mockRestore();
			await database.close();
		}
	});

	it.each([
		"INSERT INTO conversations (id, record) VALUES (2, ?)",
		"INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (2, 1, 1, ?)",
		"INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (2, 1, 'fixture', 'pending', 0, 0, ?)",
		"INSERT INTO submissions (id, conversation_id, status, record) VALUES (2, 1, 'queued', ?)",
		"INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) VALUES (2, 'fixture', 0, '', 'session', 0, 1, ?)",
		"INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (2, 1, 'base', 1, ?)",
	])("preflights every JSON column before materialization: %s", async (sql) => {
		const { path, writer } = await fixture();
		await writer.close(context);
		const database = new DatabaseSync(path);
		database.prepare(sql).run(JSON.stringify({ text: "界".repeat(100) }));
		database.close();
		const before = await readFile(path);
		await expect(openNodeSqliteStorageReadOnly(path, { limits: { maxJsonBytes: 256 } })).rejects.toThrow(
			ReadonlyCapacityError,
		);
		expect(await readFile(path)).toEqual(before);
	});

	it("bounds revision count and total literal growth before rebuilding documents", async () => {
		const { path, writer } = await fixture();
		const id = await writer.mintId<DocumentId>();
		await writer.commit(
			[
				{
					type: "document.create",
					record: { id, kind: "fixture", scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { text: "" } },
				},
			],
			context,
		);
		for (let index = 0; index < 4; index++) {
			await writer.commit(
				[
					{
						type: "document.change",
						id,
						content: { kind: "delta", version: 1, ops: [["a", ["text"], "x".repeat(100)]] },
					},
				],
				context,
			);
		}
		// Every individual delta fits; their cumulative payload and chain length do not.
		await expect(openNodeSqliteStorageReadOnly(path, { limits: { maxDocumentBytes: 256 } })).rejects.toMatchObject({
			code: "READONLY_CAPACITY_EXCEEDED",
		});
		await expect(openNodeSqliteStorageReadOnly(path, { limits: { maxDocumentRevisions: 4 } })).rejects.toThrow(
			ReadonlyCapacityError,
		);
		const reader = await openNodeSqliteStorageReadOnly(path, { limits: { maxDocumentRevisions: 5 } });
		storages.push(reader);
		expect((await reader.document(id, "current", context))?.value).toEqual({ text: "x".repeat(400) });
	});

	it("rejects oversized metadata before fetching it and rejects raised limits", async () => {
		const { path, writer } = await fixture();
		await expect(openNodeSqliteStorageReadOnly(path, { limits: { maxJsonBytes: 1024 * 1024 + 1 } })).rejects.toThrow(
			"Invalid read-only SQLite resource limit",
		);
		await writer.close(context);
		const database = new DatabaseSync(path);
		database.prepare("UPDATE durable_metadata SET next_id = ?").run("2".repeat(1024));
		database.close();
		await expect(openNodeSqliteStorageReadOnly(path)).rejects.toThrow("Invalid durable SQLite metadata");
	});

	it("bounds damaged ancestry loops and rejects unbounded page sizes", async () => {
		const { path, writer } = await fixture();
		await writer.commit(
			[
				{
					type: "conversation",
					value: {
						id: ROOT_CONVERSATION_ID,
						parent: { conversationId: ROOT_CONVERSATION_ID, at: idFromNumber<EntryId>(100) },
					},
				},
			],
			context,
		);
		const reader = await openNodeSqliteStorageReadOnly(path);
		storages.push(reader);
		for (const order of ["ascending", "descending"] as const) {
			await expect(
				reader.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order }, 1, undefined, context),
			).rejects.toThrow(ReadonlyCapacityError);
		}
		await expect(reader.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context)).rejects.toThrow(
			ReadonlyCapacityError,
		);
		await expect(reader.scanConversations({}, 101, undefined, context)).rejects.toThrow("scan limit");
		await expect(
			reader.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, -1, undefined, context),
		).rejects.toThrow("scan limit");
		// The normal writer retains its pre-existing scan behavior.
		expect((await writer.scanConversations({}, 101, undefined, context)).items).toHaveLength(1);
	});

	it("reads WAL, delta documents and fork history without changing main/WAL business bytes", async () => {
		const { path, writer } = await fixture();
		const parentEntry = await writer.mintId<EntryId>();
		const hiddenEntry = await writer.mintId<EntryId>();
		const fork = await writer.mintId<ConversationId>();
		const childEntry = await writer.mintId<EntryId>();
		const document = await writer.mintId<DocumentId>();
		await writer.commit(
			[
				{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
				{
					type: "entry",
					value: { id: parentEntry, conversationId: ROOT_CONVERSATION_ID, kind: "message", data: "parent" },
				},
				{
					type: "entry",
					value: { id: hiddenEntry, conversationId: ROOT_CONVERSATION_ID, kind: "message", data: "excluded" },
				},
				{
					type: "conversation",
					value: { id: fork, parent: { conversationId: ROOT_CONVERSATION_ID, at: parentEntry } },
				},
				{ type: "entry", value: { id: childEntry, conversationId: fork, kind: "message", data: "child" } },
				{
					type: "document.create",
					record: { id: document, kind: "fixture", scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { count: 1 } },
				},
			],
			context,
		);
		await writer.commit(
			[
				{
					type: "document.change",
					id: document,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] },
				},
			],
			context,
		);
		const expectedDocument = await writer.document(document, "current", context);
		const before = await Promise.all([readFile(path), readFile(`${path}-wal`)]);
		expect(before[1]?.length).toBeGreaterThan(0);
		const reader = await openNodeSqliteStorageReadOnly(path);
		storages.push(reader);
		expect(await reader.document(document, "current", context)).toEqual(expectedDocument);
		for (const order of ["ascending", "descending"] as const) {
			const query = { conversationId: fork, order };
			expect(await reader.scanEntries(query, 10, undefined, context)).toEqual(
				await writer.scanEntries(query, 10, undefined, context),
			);
		}
		expect(
			(await reader.scanEntries({ conversationId: fork, order: "ascending" }, 10, undefined, context)).items.map(
				(entry) => entry.id,
			),
		).toEqual([parentEntry, childEntry]);
		expect(reader).toBeInstanceOf(SqliteStorage);
		if (!(reader instanceof SqliteStorage)) throw new Error("Expected shared storage implementation");
		await expect(reader.commit([], context)).rejects.toThrow(StorageRequestError);
		await expect(reader.mintId()).rejects.toThrow("Durable SQLite storage is read-only");
		// Multi-query ancestry scans admitted before close must drain before the connection closes.
		const pending = reader.scanEntries({ conversationId: fork }, 10, undefined, context);
		const closing = reader.close(context);
		expect((await pending).items.map((entry) => entry.id)).toEqual([childEntry, parentEntry]);
		await closing;
		await expect(reader.document(document, "current", context)).rejects.toThrow("closed");
		// SHM read marks/lock metadata are intentionally excluded; main and WAL bytes are authoritative here.
		expect(await Promise.all([readFile(path), readFile(`${path}-wal`)])).toEqual(before);
	});

	it.each([0, 1, 3, 999])("rejects schema %s without migration or repair", async (version) => {
		const { path, writer } = await fixture();
		await writer.close(context);
		const database = new DatabaseSync(path);
		database.prepare("UPDATE durable_schema SET version = ?").run(version);
		database.close();
		const before = await readFile(path);
		await expect(openNodeSqliteStorageReadOnly(path)).rejects.toThrow("Unsupported durable SQLite schema version");
		expect(await readFile(path)).toEqual(before);
	});

	it.each([
		"DELETE FROM durable_metadata",
		"UPDATE durable_metadata SET next_id = 'NaN'",
		"UPDATE durable_metadata SET next_id = '1'",
		"UPDATE durable_metadata SET next_seq = 0",
		"DROP TABLE entries",
	])("rejects incomplete metadata/schema: %s", async (sql) => {
		const { path, writer } = await fixture();
		await writer.close(context);
		const database = new DatabaseSync(path);
		database.exec(sql);
		database.close();
		const before = await readFile(path);
		await expect(openNodeSqliteStorageReadOnly(path)).rejects.toThrow(StorageRequestError);
		expect(await readFile(path)).toEqual(before);
	});

	it("supports prefixed storage and leaves the normal writer usable", async () => {
		const { path, writer } = await fixture("pi_");
		await writer.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const reader = await openNodeSqliteStorageReadOnly(path, { prefix: "pi_" });
		storages.push(reader);
		expect(await reader.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
		await reader.close(context);
		const id = await writer.mintId<EntryId>();
		await writer.commit(
			[{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "message" } }],
			context,
		);
		expect(await writer.entry(idFromNumber<EntryId>(id), context)).toBeDefined();
	});
});
