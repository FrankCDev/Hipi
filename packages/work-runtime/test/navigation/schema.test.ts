import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { NAVIGATION_SCHEMA, validateNavigationStore } from "../../src/navigation/schema.ts";

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY,ready INTEGER); INSERT INTO workspaces VALUES ('w',1)",
	);
	db.exec(NAVIGATION_SCHEMA);
	const cycle = randomUUID();
	db.prepare("INSERT INTO navigation_state VALUES (1,?,0,0,?,'',NULL,'',NULL,NULL,NULL,1)").run(randomUUID(), cycle);
	db.prepare("INSERT INTO navigation_sources VALUES ('w','c',?,?,0,?,10,'accepted')").run(
		JSON.stringify(["source", 1]),
		cycle,
		JSON.stringify({
			workspaceId: "w",
			conversationId: "c",
			title: "Conversation",
			revision: 1,
			createdAt: 1,
			archivedAt: null,
		}),
	);
	return db;
}

test("navigation schema validates bounded canonical sources without runtime readers", () => {
	const db = fixture();
	try {
		validateNavigationStore(db);
		const corruptions: [string, string, SQLInputValue][] = [
			["navigation_state", "revision", -1],
			["navigation_state", "inventory_generation", 0.5],
			["navigation_state", "completed_at", 9007199254740992n],
			["navigation_state", "generation", "not-a-generation"],
			["navigation_state", "active", 0],
			["navigation_state", "position", "x".repeat(16385)],
			["navigation_state", "position", "[]"],
			["navigation_state", "workspace_id", "../escape"],
			["navigation_sources", "workspace_id", "unregistered"],
			["navigation_sources", "public_id", "x".repeat(129)],
			["navigation_sources", "ordinal", -1],
			["navigation_sources", "recency_at", 1.1],
			["navigation_sources", "basis", "observer_arrival"],
			["navigation_sources", "basis", "unknown"],
			["navigation_sources", "source_generation", '["source",0]'],
			["navigation_sources", "source_generation", '["source",1,"extra"]'],
			["navigation_sources", "conversation", "{}"],
		];
		for (const [table, column, value] of corruptions) {
			db.exec("SAVEPOINT corrupt");
			try {
				db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
				assert.throws(() => validateNavigationStore(db), `${table}.${column}`);
			} finally {
				db.exec("ROLLBACK TO corrupt; RELEASE corrupt");
			}
		}
		db.exec("UPDATE navigation_sources SET recency_at=NULL,basis='unknown'");
		validateNavigationStore(db);
	} finally {
		db.close();
	}
});

test("navigation keyset schema validates generated expression and exact indexes", () => {
	const db = fixture();
	try {
		assert.equal(db.prepare("SELECT recency_key FROM navigation_sources").get()?.recency_key, -10);
		db.exec("UPDATE navigation_sources SET recency_at=NULL,basis='unknown'");
		assert.equal(db.prepare("SELECT recency_key FROM navigation_sources").get()?.recency_key, 1);
		for (const sql of [
			"DROP INDEX navigation_workspace",
			"DROP INDEX navigation_recent; CREATE INDEX navigation_recent ON navigation_sources(cycle,recency_at DESC,workspace_id,ordinal,public_id)",
			"DROP INDEX navigation_workspace; CREATE INDEX navigation_workspace ON navigation_sources(cycle,recency_key,workspace_id,ordinal,public_id)",
			"DROP INDEX navigation_recent; CREATE INDEX navigation_recent ON navigation_sources(cycle,recency_key DESC,workspace_id,ordinal,public_id)",
		]) {
			db.exec("SAVEPOINT corrupt");
			try {
				db.exec(sql);
				assert.throws(() => validateNavigationStore(db), /Invalid navigation schema/);
			} finally {
				db.exec("ROLLBACK TO corrupt; RELEASE corrupt");
			}
		}
		validateNavigationStore(db);
	} finally {
		db.close();
	}
	for (const schema of [
		NAVIGATION_SCHEMA.replace("-coalesce(recency_at,-1)", "-coalesce(recency_at,0)"),
		NAVIGATION_SCHEMA.replace("VIRTUAL", "STORED"),
		NAVIGATION_SCHEMA.replace(
			"recency_key INTEGER GENERATED ALWAYS AS (-coalesce(recency_at,-1)) VIRTUAL",
			"recency_key INTEGER",
		),
	]) {
		const malformed = new DatabaseSync(":memory:");
		try {
			malformed.exec(schema);
			assert.throws(() => validateNavigationStore(malformed), /Invalid navigation schema/);
		} finally {
			malformed.close();
		}
	}
});

test("navigation schema changes roll back together with a failed schema identity write", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(
			"CREATE TABLE identity (version INTEGER); INSERT INTO identity VALUES (9); CREATE TRIGGER reject_version BEFORE UPDATE ON identity BEGIN SELECT RAISE(ABORT,'injected'); END",
		);
		db.exec("BEGIN IMMEDIATE");
		assert.throws(() => {
			try {
				db.exec(NAVIGATION_SCHEMA);
				db.exec("UPDATE identity SET version=10; COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}, /injected/);
		assert.equal(db.prepare("SELECT version FROM identity").get()?.version, 9);
		assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='navigation_state'").get(), undefined);
		assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='navigation_sources'").get(), undefined);
		assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='navigation_publication'").get(), undefined);
	} finally {
		db.close();
	}
});

test("navigation publication is paired and cycle-scoped sources preserve published rows during staging", () => {
	const db = fixture();
	try {
		const original = db.prepare("SELECT cycle FROM navigation_sources").get()?.cycle;
		assert.ok(typeof original === "string");
		const next = randomUUID();
		db.prepare("UPDATE navigation_publication SET cycle=?,generation=?").run(original, randomUUID());
		db.prepare(
			"INSERT INTO navigation_sources SELECT workspace_id,public_id,source_generation,?,ordinal,conversation,recency_at,basis FROM navigation_sources",
		).run(next);
		validateNavigationStore(db);
		assert.equal(db.prepare("SELECT count(*) AS total FROM navigation_sources").get()?.total, 2);
		for (const [cycle, generation] of [
			[null, randomUUID()],
			[randomUUID(), null],
			["x".repeat(36), randomUUID()],
			[randomUUID(), "x".repeat(36)],
			["x".repeat(1000), randomUUID()],
		]) {
			db.prepare("UPDATE navigation_publication SET cycle=?,generation=?").run(cycle, generation);
			assert.throws(() => validateNavigationStore(db));
		}
	} finally {
		db.close();
	}
});

test("navigation maintenance validates resumable activity positions without importing source readers", () => {
	const db = fixture();
	const position = {
		source: JSON.stringify(["source", 1]),
		phase: "tasks",
		entry: 0,
		slot: 0,
		upper: 0,
		recencyAt: 10,
		basis: "accepted",
		execution: true,
		cursor: { version: 1, lastId: 32, nested: { values: ["opaque", null, true] } },
	};
	try {
		const update = (patch: object) =>
			db
				.prepare("UPDATE navigation_state SET workspace_id='w',current_id='c',position=?")
				.run(JSON.stringify({ ...position, ...patch }));
		update({});
		validateNavigationStore(db);
		for (const patch of [
			{ phase: "unknown" },
			{ entry: -1 },
			{ slot: 0.5 },
			{ upper: Number.MAX_SAFE_INTEGER + 1 },
			{ source: '["source",0]' },
			{ cursor: "" },
			{ cursor: [] },
			{ cursor: null },
			{ phase: "messages" },
			{ execution: 1 },
			{ recencyAt: null },
			{ extra: true },
		]) {
			update(patch);
			assert.throws(() => validateNavigationStore(db));
		}
	} finally {
		db.close();
	}
});
