import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppError, type Conversation, type Scope } from "../../src/contracts.ts";
import { PRESENTATION_ORDER_SCHEMA, PRESENTATION_SCHEMA } from "../../src/conversation-presentation.ts";
import { initializeProjectStore } from "../../src/projects/schema.ts";
import { SIDEBAR_PIN_CANDIDATES, SidebarPins } from "../../src/sidebar-pins/catalog.ts";
import { initializeSidebarPinStore, validateSidebarPinStore } from "../../src/sidebar-pins/schema.ts";

function fixture(count = 20000) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY,ready INTEGER);INSERT INTO workspaces VALUES('w',1)");
	db.exec(PRESENTATION_SCHEMA);
	db.exec("INSERT INTO presentation_state VALUES(1,0,0)");
	db.exec(PRESENTATION_ORDER_SCHEMA);
	initializeProjectStore(db, { pristine: true });
	db.exec("BEGIN");
	const pin = db.prepare("INSERT INTO conversation_presentations VALUES('w',?,1,?,1,0)");
	for (let i = 0; i < count; i++) pin.run(`c${String(i).padStart(5, "0")}`, i + 1);
	db.prepare("UPDATE presentation_state SET generation=?,next_ordinal=?,order_generation=?").run(count, count, count);
	db.exec("COMMIT");
	initializeSidebarPinStore(db);
	let reads = 0;
	let onRead: undefined | (() => void);
	const catalog = new SidebarPins(db, "store", {
		getProject() {
			throw new AppError("NOT_FOUND");
		},
		getProjectPresentation() {
			throw new AppError("NOT_FOUND");
		},
		async getConversation(scope: Scope): Promise<Conversation> {
			reads++;
			onRead?.();
			return { ...scope, title: scope.conversationId, revision: 1, createdAt: null, archivedAt: null };
		},
		recordArchive() {},
		getConversationPresentation(scope) {
			return { ...scope, pinned: true, revision: 1 };
		},
		getMembership(scope) {
			return { ...scope, projectId: null, revision: 1 };
		},
	});
	return {
		db,
		catalog,
		reads: () => reads,
		onRead: (fn: () => void) => {
			onRead = fn;
		},
	};
}

test("mixed list seeks20k index and hydrates at most51 including truthful unloaded anchor", async () => {
	const f = fixture();
	try {
		const plan = f.db
			.prepare(`EXPLAIN QUERY PLAN ${SIDEBAR_PIN_CANDIDATES}`)
			.all(19000, 51)
			.map((x) => String(x.detail))
			.join("\n");
		assert.match(plan, /SEARCH.*sidebar_pin_ordinal/);
		assert.doesNotMatch(plan, /TEMP B-TREE|SCAN/);
		const first = await f.catalog.list({});
		assert.equal(first.items.length, 50);
		assert.equal(f.reads(), 51);
		assert.deepEqual(first.nextPinKey, { kind: "conversation", workspaceId: "w", conversationId: "c00050" });
		assert.ok(first.nextCursor);
		const second = await f.catalog.list({ cursor: first.nextCursor });
		assert.equal(second.items[0].kind, "conversation");
		if (second.items[0].kind === "conversation") assert.equal(second.items[0].conversation.conversationId, "c00050");
		assert.equal(f.reads(), 102);
		f.onRead(() => {
			throw new AppError("NOT_FOUND");
		});
		await assert.rejects(f.catalog.list({}), { code: "NOT_FOUND" });
	} finally {
		f.db.close();
	}
});

test("mixed revision race during hydration rejects whole page and stale continuation before reads", async () => {
	const f = fixture(60);
	try {
		const page = await f.catalog.list({});
		let once = false;
		f.onRead(() => {
			if (!once) {
				once = true;
				f.db.exec("UPDATE sidebar_pin_state SET order_revision=order_revision+1");
			}
		});
		await assert.rejects(f.catalog.list({}), { code: "CURSOR_STALE" });
		const before = f.reads();
		await assert.rejects(f.catalog.list({ cursor: page.nextCursor! }), { code: "CURSOR_STALE" });
		assert.equal(f.reads(), before);
	} finally {
		f.db.close();
	}
});

test("receipt write failure rolls back mixed and derived legacy rotations and all order fences", async () => {
	const f = fixture(4);
	try {
		const before = f.db.prepare("SELECT * FROM sidebar_pin_order ORDER BY ordinal").all(),
			legacy = f.db.prepare("SELECT * FROM conversation_presentations ORDER BY pin_ordinal").all(),
			state = f.db.prepare("SELECT * FROM presentation_state").get();
		f.db.exec(
			"CREATE TRIGGER reject_pin_receipt BEFORE INSERT ON sidebar_pin_commands BEGIN SELECT RAISE(FAIL,'receipt failed');END",
		);
		const params = {
			requestId: "move",
			moved: { kind: "conversation" as const, workspaceId: "w", conversationId: "c00003" },
			before: { kind: "conversation" as const, workspaceId: "w", conversationId: "c00000" },
			expectedOrderRevision: 1,
		};
		await assert.rejects(f.catalog.execute({ method: "reorderSidebarPin", params }), /receipt failed/);
		assert.deepEqual(f.db.prepare("SELECT * FROM sidebar_pin_order ORDER BY ordinal").all(), before);
		assert.deepEqual(f.db.prepare("SELECT * FROM conversation_presentations ORDER BY pin_ordinal").all(), legacy);
		assert.deepEqual(f.db.prepare("SELECT * FROM presentation_state").get(), state);
		assert.equal(f.db.prepare("SELECT order_revision FROM sidebar_pin_state").get()?.order_revision, 1);
		f.db.exec("DROP TRIGGER reject_pin_receipt");
		assert.deepEqual(await f.catalog.execute({ method: "reorderSidebarPin", params }), { orderRevision: 2 });
		validateSidebarPinStore(f.db);
	} finally {
		f.db.close();
	}
});

test("mixed long-range rotations preserve both complete legacy subsequences and unloaded gaps", () => {
	const f = fixture(80);
	try {
		f.db.exec("BEGIN");
		for (let i = 0; i < 80; i++) {
			const id = `p${i}`;
			f.db.prepare("INSERT INTO workspaces VALUES(?,1)").run(id);
			f.db.prepare("INSERT INTO projects VALUES(?,?,1,?,'legacy','ready')").run(id, id, id);
			f.db.prepare("INSERT INTO project_presentations VALUES(?,1,1,?)").run(id, (i + 1) * 3);
			f.db.prepare("INSERT INTO sidebar_pin_order VALUES('project',?,NULL,NULL,?)").run(id, (i + 81) * 2);
		}
		f.db.exec(
			"UPDATE project_presentation_state SET order_generation=80,next_ordinal=240;UPDATE sidebar_pin_state SET order_revision=2,next_ordinal=320;COMMIT",
		);
		const expected = f.db
			.prepare("SELECT kind,project_id,workspace_id,conversation_id FROM sidebar_pin_order ORDER BY ordinal")
			.all()
			.map((row) =>
				row.kind === "project"
					? { kind: "project" as const, projectId: String(row.project_id) }
					: {
							kind: "conversation" as const,
							workspaceId: String(row.workspace_id),
							conversationId: String(row.conversation_id),
						},
			);
		let seed = 91;
		for (let step = 0; step < 200; step++) {
			seed = (seed * 16807) % 2147483647;
			const from = seed % expected.length;
			seed = (seed * 16807) % 2147483647;
			const target = seed % (expected.length + 1);
			if (target === from) continue;
			const moved = expected[from],
				before = expected[target] ?? null;
			expected.splice(from, 1);
			const destination = before === null ? expected.length : expected.indexOf(before);
			expected.splice(destination, 0, moved);
			f.db.exec("BEGIN");
			f.catalog.reorderInside(moved, before);
			f.db.exec("COMMIT");
			const actual = f.db
				.prepare("SELECT kind,project_id,workspace_id,conversation_id FROM sidebar_pin_order ORDER BY ordinal")
				.all()
				.map((row) =>
					row.kind === "project"
						? { kind: "project", projectId: String(row.project_id) }
						: {
								kind: "conversation",
								workspaceId: String(row.workspace_id),
								conversationId: String(row.conversation_id),
							},
				);
			assert.deepEqual(actual, expected);
			validateSidebarPinStore(f.db);
		}
	} finally {
		f.db.close();
	}
});
