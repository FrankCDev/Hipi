import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { SqliteExecutor } from "../src/sqlite/database.ts";
import { NodeSqliteDatabase, openNodeSqliteDatabaseReadOnly } from "../src/sqlite/node.ts";

describe("Node read-only SQLite", () => {
	it("never reports a failed native close as successful on retry", async () => {
		const native = new DatabaseSync(":memory:");
		const database = new NodeSqliteDatabase(native, { readOnly: true });
		const close = vi.spyOn(native, "close").mockImplementation(() => {
			throw new Error("injected close failure");
		});
		try {
			await expect(database.close()).rejects.toMatchObject({ code: "READONLY_CLOSE_FAILED" });
			await expect(database.close()).rejects.toMatchObject({ code: "READONLY_CLOSE_FAILED" });
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			close.mockRestore();
			native.close();
		}
	});

	it("does not create a missing database or its directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "chord-readonly-"));
		try {
			await expect(openNodeSqliteDatabaseReadOnly(join(directory, "missing", "db.sqlite"))).rejects.toThrow();
			await expect(stat(join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("preserves DELETE journal mode and serializes rollback, reads, and close", async () => {
		const directory = await mkdtemp(join(tmpdir(), "chord-readonly-"));
		const path = join(directory, "db.sqlite");
		const writer = new DatabaseSync(path);
		writer.exec("CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (1)");
		writer.close();
		const before = await readFile(path);
		const database = await openNodeSqliteDatabaseReadOnly(path, { busyTimeoutMs: 12 });
		try {
			expect(await database.get("PRAGMA journal_mode")).toEqual({ journal_mode: "delete" });
			expect(await database.get("PRAGMA trusted_schema")).toEqual({ trusted_schema: 0 });
			expect(await database.get("PRAGMA busy_timeout")).toEqual({ timeout: 12 });
			await expect(database.run("INSERT INTO sample VALUES (2)")).rejects.toThrow();
			const started = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			let handle: SqliteExecutor | undefined;
			const transaction = database.transaction(async (current) => {
				handle = current;
				expect(await current.get("SELECT value FROM sample")).toEqual({ value: 1 });
				started.resolve();
				await gate.promise;
				throw new Error("rollback read");
			});
			const rejected = expect(transaction).rejects.toThrow("rollback read");
			await started.promise;
			const read = database.get("SELECT value FROM sample");
			let closed = false;
			const close = database.close().then(() => {
				closed = true;
			});
			await Promise.resolve();
			expect(closed).toBe(false);
			gate.resolve();
			await rejected;
			expect(await read).toEqual({ value: 1 });
			await close;
			expect(handle).toBeDefined();
			await expect(handle?.get("SELECT 1")).rejects.toThrow("no longer active");
			expect(await readFile(path)).toEqual(before);
			await expect(stat(`${path}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await database.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
