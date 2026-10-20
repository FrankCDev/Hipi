import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PRESENTATION_ORDER_SCHEMA, PRESENTATION_SCHEMA } from "../../src/conversation-presentation.ts";
import { initializeProjectStore } from "../../src/projects/schema.ts";
import { parseSidebarPinParams } from "../../src/sidebar-pins/contracts.ts";
import {
	initializeSidebarPinStore,
	sidebarPinCommandDigest,
	validateSidebarPinStore,
} from "../../src/sidebar-pins/schema.ts";

function fixture(migrate = true) {
	const database = new DatabaseSync(":memory:");
	database.exec(
		"CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY,ready INTEGER); INSERT INTO workspaces VALUES ('a',1),('b',1),('hidden',1)",
	);
	database.exec(PRESENTATION_SCHEMA);
	database.exec("INSERT INTO presentation_state VALUES (1,12,9)");
	database.exec(PRESENTATION_ORDER_SCHEMA);
	initializeProjectStore(database, { pristine: false });
	database.exec(
		"INSERT INTO projects VALUES ('p1','One',1,'a','legacy','ready'),('p2','Two',1,'b','legacy','ready'),('hidden','Hidden',1,'hidden','legacy','default'); INSERT INTO project_presentations VALUES ('p1',1,1,9),('p2',1,1,4),('hidden',1,1,1); UPDATE project_presentation_state SET order_generation=12,next_ordinal=9; INSERT INTO conversation_presentations VALUES ('a','same',1,7,1,0),('b','same',1,2,1,0),('a','archived',2,NULL,NULL,2)",
	);
	if (migrate) initializeSidebarPinStore(database);
	return database;
}

test("schema12 migration preserves complete legacy subsequences and gaps while excluding hidden default projects", () => {
	const database = fixture(false);
	try {
		const conversations = database
			.prepare("SELECT * FROM conversation_presentations ORDER BY workspace_id,public_id")
			.all();
		const projects = database.prepare("SELECT * FROM project_presentations ORDER BY project_id").all();
		initializeSidebarPinStore(database);
		validateSidebarPinStore(database);
		assert.deepEqual(
			database
				.prepare("SELECT * FROM sidebar_pin_order ORDER BY ordinal")
				.all()
				.map((row) => ({ ...row })),
			[
				{ kind: "conversation", project_id: null, workspace_id: "b", conversation_id: "same", ordinal: 1 },
				{ kind: "conversation", project_id: null, workspace_id: "a", conversation_id: "same", ordinal: 2 },
				{ kind: "project", project_id: "p2", workspace_id: null, conversation_id: null, ordinal: 3 },
				{ kind: "project", project_id: "p1", workspace_id: null, conversation_id: null, ordinal: 4 },
			],
		);
		assert.deepEqual(
			{ ...database.prepare("SELECT * FROM sidebar_pin_state").get() },
			{ singleton: 1, order_revision: 1, next_ordinal: 4 },
		);
		assert.deepEqual(
			database.prepare("SELECT * FROM conversation_presentations ORDER BY workspace_id,public_id").all(),
			conversations,
		);
		assert.deepEqual(database.prepare("SELECT * FROM project_presentations ORDER BY project_id").all(), projects);
		const plan = database
			.prepare("EXPLAIN QUERY PLAN SELECT * FROM sidebar_pin_order WHERE ordinal>? ORDER BY ordinal LIMIT 51")
			.all(1)
			.map((row) => row.detail)
			.join("\n");
		assert.match(plan, /sidebar_pin_ordinal/);
		assert.doesNotMatch(plan, /TEMP B-TREE/);
	} finally {
		database.close();
	}
});

test("empty mixed migration starts at revision zero", () => {
	const database = fixture(false);
	try {
		database.exec("DELETE FROM conversation_presentations; DELETE FROM project_presentations");
		initializeSidebarPinStore(database);
		validateSidebarPinStore(database);
		assert.deepEqual(
			{ ...database.prepare("SELECT * FROM sidebar_pin_state").get() },
			{ singleton: 1, order_revision: 0, next_ordinal: 0 },
		);
		database.exec("UPDATE sidebar_pin_state SET next_ordinal=1");
		assert.throws(() => validateSidebarPinStore(database), { code: "STORE_MISMATCH" });
	} finally {
		database.close();
	}
});

for (const sql of [
	"DELETE FROM sidebar_pin_order WHERE kind='project' AND project_id='p1'",
	"DELETE FROM sidebar_pin_order WHERE kind='conversation' AND workspace_id='a'",
	"UPDATE sidebar_pin_order SET project_id='missing' WHERE project_id='p1'",
	"UPDATE sidebar_pin_order SET conversation_id='archived' WHERE workspace_id='a'",
	"UPDATE sidebar_pin_order SET project_id='hidden' WHERE project_id='p1'",
	"UPDATE sidebar_pin_order SET ordinal=9 WHERE project_id='p1'",
	"UPDATE sidebar_pin_order SET ordinal=1.5 WHERE project_id='p1'",
	"UPDATE sidebar_pin_order SET ordinal=9007199254740992 WHERE project_id='p1'",
	"UPDATE sidebar_pin_state SET order_revision=-1",
	"UPDATE sidebar_pin_state SET order_revision=0",
	"UPDATE sidebar_pin_order SET workspace_id='a'||char(10) WHERE workspace_id='a'",
	"UPDATE sidebar_pin_order SET ordinal=-ordinal WHERE kind='project'; UPDATE sidebar_pin_order SET ordinal=7+ordinal WHERE kind='project'",
	"UPDATE sidebar_pin_order SET ordinal=-ordinal WHERE kind='conversation'; UPDATE sidebar_pin_order SET ordinal=3+ordinal WHERE kind='conversation'",
	"PRAGMA ignore_check_constraints=ON; UPDATE sidebar_pin_order SET conversation_id='foreign' WHERE project_id='p1'",
	"DROP INDEX sidebar_pin_conversation; CREATE UNIQUE INDEX sidebar_pin_conversation ON sidebar_pin_order(conversation_id,workspace_id) WHERE kind='conversation'",
	"DROP INDEX sidebar_pin_ordinal; CREATE INDEX sidebar_pin_ordinal ON sidebar_pin_order(ordinal)",
]) {
	test(`schema12 rejects broken typed membership/order: ${sql}`, () => {
		const database = fixture();
		try {
			database.exec(sql);
			assert.throws(() => validateSidebarPinStore(database), { code: "STORE_MISMATCH" });
		} finally {
			database.close();
		}
	});
}

test("typed indexes reject duplicate identities and ordinals", () => {
	const database = fixture();
	try {
		for (const sql of [
			"INSERT INTO sidebar_pin_order VALUES ('project','p1',NULL,NULL,5)",
			"INSERT INTO sidebar_pin_order VALUES ('conversation',NULL,'a','same',5)",
			"INSERT INTO sidebar_pin_order VALUES ('project','new',NULL,NULL,1)",
			"INSERT INTO sidebar_pin_order VALUES ('project',NULL,NULL,NULL,5)",
			"INSERT INTO sidebar_pin_order VALUES ('conversation',NULL,'a',NULL,5)",
		])
			assert.throws(() => database.exec(sql));
		validateSidebarPinStore(database);
	} finally {
		database.close();
	}
});

test("mixed immutable receipt survives later unpin but rejects changed digest, result and malformed JSON", () => {
	const database = fixture();
	try {
		const params = parseSidebarPinParams("reorderSidebarPin", {
			requestId: "move",
			moved: { kind: "project", projectId: "p1" },
			before: null,
			expectedOrderRevision: 1,
		});
		const digest = sidebarPinCommandDigest(params);
		database
			.prepare("INSERT INTO sidebar_pin_commands VALUES (?,?,?,?)")
			.run(params.requestId, digest, JSON.stringify(params), JSON.stringify({ orderRevision: 1 }));
		validateSidebarPinStore(database);
		database.exec(
			"DELETE FROM sidebar_pin_order WHERE project_id='p1'; UPDATE project_presentations SET pinned=0,pin_ordinal=NULL,revision=2 WHERE project_id='p1'; UPDATE sidebar_pin_state SET order_revision=2",
		);
		validateSidebarPinStore(database);
		for (const sql of [
			"UPDATE sidebar_pin_commands SET digest=printf('%064d',0)",
			"UPDATE sidebar_pin_commands SET result='{\"orderRevision\":3}'",
			"UPDATE sidebar_pin_commands SET params='malformed'",
		]) {
			database.exec("SAVEPOINT corruption");
			database.exec(sql);
			assert.throws(() => validateSidebarPinStore(database), { code: "STORE_MISMATCH" });
			database.exec("ROLLBACK TO corruption; RELEASE corruption");
		}
		database.prepare("UPDATE sidebar_pin_commands SET params=?").run("x".repeat(8193));
		assert.throws(() => validateSidebarPinStore(database), { code: "CAPACITY_EXCEEDED" });
	} finally {
		database.close();
	}
});

test("persisted reorder cannot claim success against the empty revision-zero state", () => {
	const database = fixture();
	try {
		const params = parseSidebarPinParams("reorderSidebarPin", {
			requestId: "impossible-zero",
			moved: { kind: "project", projectId: "p1" },
			before: null,
			expectedOrderRevision: 0,
		});
		database
			.prepare("INSERT INTO sidebar_pin_commands VALUES (?,?,?,?)")
			.run(
				params.requestId,
				sidebarPinCommandDigest(params),
				JSON.stringify(params),
				JSON.stringify({ orderRevision: 1 }),
			);
		assert.throws(() => validateSidebarPinStore(database), { code: "STORE_MISMATCH" });
	} finally {
		database.close();
	}
});
