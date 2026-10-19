import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readWorkspaceDirectory, StoreCatalog } from "../src/store-catalog.ts";
import { openTestRuntime } from "../src/testing.ts";

test("all Hipi workspace SQLite connection paths request FULL on the actual connection", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-sqlite-durability-"));
	const observed: string[] = [];
	let phase = "runtime";
	const originalExec = DatabaseSync.prototype.exec;
	// Run the real factory and SQL, then inspect that same native handle. synchronous is connection-local.
	t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
		originalExec.call(this, sql);
		if (/^PRAGMA synchronous = /.test(sql)) {
			assert.equal(this.prepare("PRAGMA synchronous").get()?.synchronous, 2);
			assert.equal(this.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
			observed.push(phase);
		}
	});
	const runtime = await openTestRuntime(directory);
	let catalog: StoreCatalog | undefined;
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Durable work" });
		await runtime.close();
		assert.ok(observed.includes("runtime"));

		phase = "directory";
		await readWorkspaceDirectory(join(directory, "work"), "work");
		assert.ok(observed.includes("directory"));

		phase = "recovery";
		catalog = await StoreCatalog.open(directory);
		phase = "feature-read";
		await catalog.listToolPacks({ workspaceId: "work" });
		assert.ok(observed.includes("feature-read"));

		phase = "conversation-list";
		await catalog.listConversations({ workspaceId: "work" });
		assert.ok(observed.includes("conversation-list"));
	} finally {
		await runtime.close();
		catalog?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
