import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export function probeSqlite() {
	assert.ok(process.versions.electron, "This probe requires the Electron executable");
	const database = new DatabaseSync(":memory:");
	try {
		const row = database.prepare("SELECT 42 AS value").get();
		assert.equal(row?.value, 42);
		return { version: 1, kind: "sqlite-result", electron: process.versions.electron, node: process.versions.node, value: 42 };
	} finally {
		database.close();
	}
}
