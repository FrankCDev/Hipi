import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseProjectParams } from "../../src/projects/contracts.ts";
import { initializeProjectStore, projectCommandDigest, validateProjectStore } from "../../src/projects/schema.ts";

function fixture() {
	const database = new DatabaseSync(":memory:");
	database.exec(
		"CREATE TABLE identity (singleton INTEGER PRIMARY KEY, store_id TEXT); INSERT INTO identity VALUES (1,'store'); CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, ready INTEGER); INSERT INTO workspaces VALUES ('home',1),('other',1); CREATE TABLE conversations (workspace_id TEXT, public_id TEXT)",
	);
	initializeProjectStore(database, { pristine: false });
	database.exec(
		"INSERT INTO projects VALUES ('project','Current name',3,'home','created','ready'); INSERT INTO project_memberships VALUES ('home','same','project',1,'created'),('other','same',NULL,2,'created'); INSERT INTO project_presentations VALUES ('project',1,1,1); UPDATE project_presentation_state SET order_generation=1,next_ordinal=1; UPDATE project_catalog_state SET membership_generation=3,metadata_generation=3",
	);
	const params = parseProjectParams("renameProject", {
		requestId: "rename",
		projectId: "project",
		expectedRevision: 1,
		name: "Previous name",
	});
	database
		.prepare("INSERT INTO project_commands VALUES (?,?,?,?,?,'complete',?)")
		.run(
			params.requestId,
			"renameProject",
			projectCommandDigest("renameProject", params),
			JSON.stringify(params),
			"{}",
			JSON.stringify({ projectId: "project", name: "Previous name", revision: 2, homeWorkspaceId: "home" }),
		);
	const pending = parseProjectParams("createProject", { requestId: "pending", name: "Pending project" });
	database
		.prepare("INSERT INTO project_commands VALUES (?,?,?,?,?,'reserved',NULL)")
		.run(
			pending.requestId,
			"createProject",
			projectCommandDigest("createProject", pending),
			JSON.stringify(pending),
			JSON.stringify({ projectId: "reserved_project", workspaceId: "reserved_workspace" }),
		);
	return database;
}

test("schema11 leaves the default role absent for pristine and legacy project-only stores", () => {
	for (const pristine of [true, false]) {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec("CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, ready INTEGER)");
			initializeProjectStore(database, { pristine });
			validateProjectStore(database);
			const state = database
				.prepare("SELECT state,default_workspace_id,default_provenance FROM project_catalog_state")
				.get();
			assert.deepEqual({ ...state }, { state: "ready", default_workspace_id: null, default_provenance: null });
			assert.equal(database.prepare("SELECT count(*) AS total FROM projects").get()?.total, 0);
		} finally {
			database.close();
		}
	}
});

test("membership survives projection deletion, preserves canonical scopes and immutable historical results", () => {
	const database = fixture();
	try {
		validateProjectStore(database);
		database.exec("DELETE FROM conversations");
		validateProjectStore(database);
		assert.deepEqual(
			database
				.prepare("SELECT workspace_id,conversation_id,project_id FROM project_memberships ORDER BY workspace_id")
				.all()
				.map((row) => ({ ...row })),
			[
				{ workspace_id: "home", conversation_id: "same", project_id: "project" },
				{ workspace_id: "other", conversation_id: "same", project_id: null },
			],
		);
		assert.equal(
			database.prepare("SELECT stage FROM project_commands WHERE request_id='pending'").get()?.stage,
			"reserved",
		);
	} finally {
		database.close();
	}
});

for (const corruption of [
	"UPDATE projects SET home_workspace_id='missing'",
	"UPDATE projects SET project_id='project'||char(10)",
	"UPDATE projects SET revision=9007199254740992",
	"UPDATE project_memberships SET project_id='missing' WHERE workspace_id='home'",
	"UPDATE project_memberships SET revision=0",
	"UPDATE project_presentations SET pin_ordinal=2",
	"UPDATE project_presentation_state SET order_generation=0",
	"UPDATE project_catalog_state SET adoption_workspace_after='home'",
	"UPDATE project_commands SET digest=printf('%064d',0) WHERE request_id='rename'",
	"UPDATE project_commands SET reserved_ids='{}' WHERE request_id='pending'",
	"UPDATE project_commands SET result='{}' WHERE request_id='pending'",
	"UPDATE project_commands SET stage='reserved' WHERE request_id='rename'",
	"UPDATE project_commands SET result=json_set(result,'$.projectId','missing') WHERE request_id='rename'",
	"UPDATE project_commands SET result=json_set(result,'$.revision',3) WHERE request_id='rename'",
	"UPDATE project_commands SET params=json_set(params,'$.name','Changed input') WHERE request_id='rename'",
	"UPDATE project_commands SET params=json_set(params,'$.extra',true) WHERE request_id='pending'",
	"UPDATE project_commands SET params='not-json' WHERE request_id='pending'",
	"DROP INDEX project_membership_scope; CREATE INDEX project_membership_scope ON project_memberships(project_id)",
	"DROP INDEX project_pin_order; CREATE INDEX project_pin_order ON project_presentations(pin_ordinal)",
]) {
	test(`schema11 rejects corrupt metadata: ${corruption}`, () => {
		const database = fixture();
		try {
			database.exec(corruption);
			assert.throws(() => validateProjectStore(database), { code: "STORE_MISMATCH" });
		} finally {
			database.close();
		}
	});
}

test("schema11 byte budgets reject oversized command JSON before decoding", () => {
	const database = fixture();
	try {
		database.prepare("UPDATE project_commands SET params=? WHERE request_id='pending'").run("x".repeat(8192 * 3 + 1));
		assert.throws(() => validateProjectStore(database), { code: "CAPACITY_EXCEEDED" });
	} finally {
		database.close();
	}
});

test("created default role is bound to the exact pending creation command and reserved workspace", () => {
	const database = fixture();
	try {
		const params = parseProjectParams("createProjectConversation", {
			requestId: "default",
			projectId: null,
			title: "Default chat",
		});
		database
			.prepare("INSERT INTO project_commands VALUES (?,?,?,?,?,'workspace_created',NULL)")
			.run(
				params.requestId,
				"createProjectConversation",
				projectCommandDigest("createProjectConversation", params),
				JSON.stringify(params),
				JSON.stringify({ workspaceId: "other", innerRequestId: "physical", createDefault: true }),
			);
		database
			.prepare("UPDATE project_catalog_state SET default_workspace_id='other',default_provenance=?")
			.run(JSON.stringify({ kind: "created", requestId: "default" }));
		validateProjectStore(database);
		database
			.prepare("UPDATE project_catalog_state SET default_provenance=?")
			.run(JSON.stringify({ kind: "created", requestId: "missing" }));
		assert.throws(() => validateProjectStore(database), { code: "STORE_MISMATCH" });
		database
			.prepare("UPDATE project_catalog_state SET default_provenance=?")
			.run(JSON.stringify({ kind: "created", requestId: "default" }));
		database.exec(
			"UPDATE project_commands SET reserved_ids=json_set(reserved_ids,'$.workspaceId','home') WHERE request_id='default'",
		);
		assert.throws(() => validateProjectStore(database), { code: "STORE_MISMATCH" });
	} finally {
		database.close();
	}
});

test("adoption preserves a temporary legacy mapping but cannot publish it as the default project", () => {
	const database = fixture();
	try {
		const provenance = { storeId: "store", markerVersion: 1, role: "default-chat-workspace", workspaceId: "home" };
		const params = parseProjectParams("adoptLegacyDefaultWorkspace", {
			requestId: "adopt",
			workspaceId: "home",
			expectedCatalogGeneration: 0,
			expectedDefaultWorkspaceId: null,
			provenance,
		});
		database
			.prepare("INSERT INTO project_commands VALUES (?,?,?,?,?,'backfilling',NULL)")
			.run(
				params.requestId,
				"adoptLegacyDefaultWorkspace",
				projectCommandDigest("adoptLegacyDefaultWorkspace", params),
				JSON.stringify(params),
				JSON.stringify({ workspaceId: "home" }),
			);
		database
			.prepare(
				"UPDATE project_catalog_state SET state='adopting',default_workspace_id='home',default_provenance=?,adoption_request_id='adopt'",
			)
			.run(JSON.stringify(provenance));
		database.exec("UPDATE projects SET status='default'");
		validateProjectStore(database);
		database.exec("UPDATE projects SET status='ready'");
		assert.throws(() => validateProjectStore(database), { code: "STORE_MISMATCH" });
		database.exec("UPDATE projects SET status='default'");
		database.exec("UPDATE project_catalog_state SET state='ready'");
		assert.throws(() => validateProjectStore(database), { code: "STORE_MISMATCH" });
		database.exec(
			"UPDATE project_memberships SET project_id=NULL WHERE workspace_id='home'; UPDATE project_catalog_state SET adoption_request_id=NULL",
		);
		database
			.prepare("UPDATE project_commands SET stage='complete',result=? WHERE request_id='adopt'")
			.run(JSON.stringify({ state: "ready", generation: 0, defaultWorkspaceId: "home" }));
		validateProjectStore(database);
		database
			.prepare("UPDATE project_catalog_state SET default_provenance=?")
			.run(JSON.stringify({ ...provenance, storeId: "foreign" }));
		assert.throws(() => validateProjectStore(database), { code: "STORE_MISMATCH" });
	} finally {
		database.close();
	}
});
