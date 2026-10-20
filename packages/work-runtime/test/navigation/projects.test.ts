import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { type Conversation, PROTOCOL_VERSION, parseRequest, parseResult } from "../../src/contracts.ts";
import { NAVIGATION_LIMITS, type SidebarView } from "../../src/navigation/contracts.ts";
import { NavigationProjection } from "../../src/navigation/projection.ts";
import { type NavigationPosition, navigationQuery, PROJECT_SUMMARY_CANDIDATES } from "../../src/navigation/query.ts";
import { NAVIGATION_SCHEMA } from "../../src/navigation/schema.ts";
import { initializeProjectStore } from "../../src/projects/schema.ts";

function fixture(count = 300) {
	const db = new DatabaseSync(":memory:"),
		cycle = randomUUID(),
		generation = randomUUID();
	db.exec(NAVIGATION_SCHEMA);
	initializeProjectStore(db, { pristine: true });
	db.exec(
		"CREATE TABLE presentation_state(singleton INTEGER,generation INTEGER,order_generation INTEGER); INSERT INTO presentation_state VALUES(1,0,0); CREATE TABLE conversation_presentations(workspace_id TEXT,public_id TEXT,pin_ordinal INTEGER,PRIMARY KEY(workspace_id,public_id)); INSERT INTO projects VALUES('first','First',1,'a','created','ready'),('second','Second',1,'b','created','ready'); BEGIN",
	);
	db.prepare("INSERT INTO navigation_state VALUES(1,?,0,0,?,'',NULL,'',NULL,NULL,1,0)").run(generation, cycle);
	db.prepare("UPDATE navigation_publication SET cycle=?,generation=?").run(cycle, generation);
	const insert = db.prepare("INSERT INTO navigation_sources VALUES(?,?,?,?,?,?,?,?)");
	const membership = db.prepare("INSERT INTO project_memberships VALUES(?,?,?,1,'created')");
	const conversations: Conversation[] = [];
	for (let i = 0; i < count; i++) {
		const workspaceId = i % 2 ? "b" : "a",
			conversationId = `c${String(Math.floor(i / 2)).padStart(5, "0")}`,
			recency = i >= count - 10 ? null : Math.floor((count - i) / 10);
		const conversation: Conversation = {
			workspaceId,
			conversationId,
			title: conversationId,
			revision: 1,
			createdAt: recency,
			archivedAt: null,
		};
		conversations.push(conversation);
		insert.run(
			workspaceId,
			conversationId,
			JSON.stringify(["source", 1]),
			cycle,
			i,
			JSON.stringify(conversation),
			recency,
			recency === null ? "unknown" : "creation",
		);
		membership.run(workspaceId, conversationId, "first");
	}
	db.exec("COMMIT");
	const unexpected = () => {
		throw new Error("Published navigation must not read physical sources");
	};
	const projection = new NavigationProjection(db, "store", {
		nextWorkspace: unexpected,
		prepareWorkspace: unexpected,
		nextConversation: unexpected,
		read: unexpected,
		hasWorkspace: (id) => id === "a" || id === "b",
	});
	const collect = (view: SidebarView, filter: "active" | "archived" | "all" = "active") => {
		const items = [];
		let cursor: string | undefined;
		do {
			const page = projection.list({ view, filter, ...(cursor ? { cursor } : {}) });
			assert.ok(page.items.length <= NAVIGATION_LIMITS.page);
			items.push(...page.items);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return items;
	};
	return {
		db,
		cycle,
		projection,
		conversations,
		collect,
		close: async () => {
			await projection.close();
			db.close();
		},
	};
}

test("logical navigation joins canonical identities without changing physical recency or Scope", async () => {
	const f = fixture();
	try {
		const before = f.collect({ kind: "recent" });
		f.db.exec("UPDATE project_memberships SET project_id='second' WHERE workspace_id='b'");
		const first = f.collect({ kind: "project", projectId: "first" });
		const second = f.collect({ kind: "project", projectId: "second" });
		assert.deepEqual(
			first.map((row) => row.conversation),
			before.filter((row) => row.conversation.workspaceId === "a").map((row) => row.conversation),
		);
		assert.deepEqual(
			second.map((row) => row.conversation),
			before.filter((row) => row.conversation.workspaceId === "b").map((row) => row.conversation),
		);
		assert.ok(
			first.some((row) =>
				second.some((other) => other.conversation.conversationId === row.conversation.conversationId),
			),
		);
		for (const row of [...first, ...second]) {
			assert.equal(row.membership?.workspaceId, row.conversation.workspaceId);
			assert.equal(row.membership?.conversationId, row.conversation.conversationId);
			assert.equal(row.membership?.projectId, row.conversation.workspaceId === "a" ? "first" : "second");
			const original = before.find(
				(item) =>
					item.conversation.workspaceId === row.conversation.workspaceId &&
					item.conversation.conversationId === row.conversation.conversationId,
			);
			assert.equal(row.recencyAt, original?.recencyAt);
		}
		assert.deepEqual(f.collect({ kind: "recent" }), before);
		assert.ok(f.collect({ kind: "workspace", workspaceId: "a" }).every((row) => row.membership === undefined));
	} finally {
		await f.close();
	}
});

test("sparse project membership retains bounded empty continuation and explicit projectless rows", async () => {
	const f = fixture();
	try {
		f.db.exec("UPDATE project_memberships SET project_id=NULL WHERE conversation_id>='c00140'");
		const page = f.projection.list({ view: { kind: "project", projectId: null } });
		assert.deepEqual(page.items, []);
		assert.ok(page.nextCursor);
		assert.equal(page.coverage.projectMembershipGeneration, 0);
		const next = f.projection.list({ view: { kind: "project", projectId: null }, cursor: page.nextCursor });
		assert.deepEqual(next.items, []);
		assert.ok(next.nextCursor);
		const result = f.collect({ kind: "project", projectId: null });
		assert.equal(result.length, 20);
		assert.ok(result.every((row) => row.membership?.projectId === null));
		assert.ok(result.slice(-10).every((row) => row.recencyAt === null));
		f.db.exec("DELETE FROM project_memberships WHERE workspace_id='a' AND conversation_id='c00000'");
		assert.throws(() => f.projection.list({ view: { kind: "project", projectId: null } }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
		assert.equal(f.projection.list({ view: { kind: "recent" } }).items.length, 50);
	} finally {
		await f.close();
	}
});

test("logical cursor separately fences membership while labels and conversation pin order leave recency intact", async () => {
	const f = fixture();
	try {
		const first = f.projection.list({ view: { kind: "project", projectId: "first" } });
		const physical = f.projection.list({ view: { kind: "recent" } });
		assert.ok(first.nextCursor);
		assert.ok(physical.nextCursor);
		f.db.exec(
			"UPDATE projects SET name='Renamed',revision=2 WHERE project_id='first'; UPDATE project_catalog_state SET metadata_generation=1; UPDATE presentation_state SET order_generation=1",
		);
		assert.equal(
			f.projection.list({ view: { kind: "project", projectId: "first" }, cursor: first.nextCursor }).items.length,
			50,
		);
		f.db.exec("UPDATE project_catalog_state SET membership_generation=1");
		assert.throws(
			() =>
				f.projection.list({ view: { kind: "project", projectId: "first" }, cursor: first.nextCursor ?? undefined }),
			{ code: "CURSOR_STALE" },
		);
		assert.equal(f.projection.list({ view: { kind: "recent" }, cursor: physical.nextCursor }).items.length, 50);
		const updated = f.projection.list({ view: { kind: "project", projectId: "first" } });
		assert.equal(updated.coverage.projectMembershipGeneration, 1);
		f.db.exec("UPDATE presentation_state SET generation=1");
		assert.throws(
			() =>
				f.projection.list({
					view: { kind: "project", projectId: "first" },
					cursor: updated.nextCursor ?? undefined,
				}),
			{ code: "CURSOR_STALE" },
		);
	} finally {
		await f.close();
	}
});

test("logical cursors reject foreign stores, other views, missing fences and altered anchors", async () => {
	const f = fixture();
	try {
		const first = f.projection.list({ view: { kind: "project", projectId: "first" } });
		assert.ok(first.nextCursor);
		for (const view of [
			{ kind: "recent" },
			{ kind: "project_recent" },
			{ kind: "workspace", workspaceId: "a" },
			{ kind: "project", projectId: null },
			{ kind: "project", projectId: "second" },
		] as SidebarView[])
			assert.throws(() => f.projection.list({ view, cursor: first.nextCursor ?? undefined }), {
				code: "INVALID_REQUEST",
			});
		const original: Record<string, unknown> = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
		for (const change of [
			{ storeId: "foreign" },
			{ projectMembership: undefined },
			{ projectMembership: -1 },
			{ projectOrderGeneration: undefined },
			{ projectOrderGeneration: -1 },
			{ after: [1, "a", 99999, "missing"] },
			{ unexpected: true },
		]) {
			const cursor = Buffer.from(JSON.stringify({ ...original, ...change })).toString("base64url");
			assert.throws(() => f.projection.list({ view: { kind: "project", projectId: "first" }, cursor }), {
				code: "INVALID_REQUEST",
			});
		}
	} finally {
		await f.close();
	}
});

test("adoption never publishes incomplete logical classification or blocks existing physical browsing", async () => {
	const f = fixture(4);
	try {
		for (const state of ["adopting", "recovery_required"]) {
			f.db.prepare("UPDATE project_catalog_state SET state=?").run(state);
			assert.throws(() => f.projection.list({ view: { kind: "project_recent" } }), {
				code: "INDEX_RECOVERY_REQUIRED",
			});
			for (const projectId of [null, "first"])
				assert.throws(() => f.projection.list({ view: { kind: "project", projectId } }), {
					code: "INDEX_RECOVERY_REQUIRED",
				});
			assert.equal(f.projection.list({ view: { kind: "workspace", workspaceId: "a" } }).items.length, 2);
		}
		f.db.exec(
			"UPDATE project_catalog_state SET state='ready'; UPDATE projects SET status='default' WHERE project_id='second'",
		);
		for (const projectId of ["second", "missing"])
			assert.throws(() => f.projection.list({ view: { kind: "project", projectId } }), { code: "NOT_FOUND" });
		f.db.exec("UPDATE project_memberships SET project_id='second' WHERE workspace_id='a'");
		assert.throws(() => f.projection.list({ view: { kind: "project", projectId: "first" } }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
		f.db.exec(
			"UPDATE project_memberships SET project_id='first'; UPDATE navigation_publication SET cycle=NULL,generation=NULL",
		);
		const building = f.projection.list({ view: { kind: "project", projectId: "first" } });
		assert.equal(building.coverage.state, "building");
		assert.equal(building.coverage.projectMembershipGeneration, 0);
		assert.deepEqual(building.items, []);
		assert.ok(building.coverage.nextCursor);
	} finally {
		await f.close();
	}
});

test("logical archive browsing preserves authoritative pin exclusion and does not rewrite titles", async () => {
	const f = fixture(4);
	try {
		const target = f.conversations[0];
		f.db
			.prepare("INSERT INTO conversation_presentations VALUES(?,?,1)")
			.run(target.workspaceId, target.conversationId);
		assert.equal(f.collect({ kind: "project", projectId: "first" }).length, 3);
		f.db
			.prepare("UPDATE navigation_sources SET conversation=? WHERE workspace_id=? AND public_id=?")
			.run(JSON.stringify({ ...target, archivedAt: 100, revision: 2 }), target.workspaceId, target.conversationId);
		const archived = f.collect({ kind: "project", projectId: "first" }, "archived");
		assert.equal(archived.length, 1);
		assert.equal(archived[0].conversation.title, target.title);
		assert.equal(archived[0].membership?.projectId, "first");
		assert.equal(f.collect({ kind: "project", projectId: "first" }, "all").length, 4);
	} finally {
		await f.close();
	}
});

test("logical SQL preserves indexed bounded source windows even with sparse members", async () => {
	const f = fixture(20000);
	let visits = 0;
	f.db.function("navigation_visit", () => ++visits);
	try {
		f.db.exec("UPDATE project_memberships SET project_id='second' WHERE conversation_id='c09999'");
		for (const after of [undefined, [600, "a", 14000, "c07000"], [-1, "a", 19992, "c09996"]] as (
			| NavigationPosition
			| undefined
		)[]) {
			const query = navigationQuery(f.cycle, undefined, after, true);
			const plan = f.db
				.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
				.all(...query.params)
				.map((row) => String(row.detail));
			assert.ok(plan.some((detail) => detail.includes("navigation_recent")));
			assert.ok(plan.every((detail) => !detail.includes("TEMP B-TREE")));
			if (after)
				assert.ok(
					plan.some((detail) => detail.includes("recency_key") && detail.includes(">")),
					plan.join("\n"),
				);
			visits = 0;
			const rows = f.db
				.prepare(query.sql.replace("WHERE n.cycle=?", "WHERE navigation_visit() AND n.cycle=?"))
				.all(...query.params);
			assert.ok(rows.length <= NAVIGATION_LIMITS.candidates + 1);
			assert.ok(visits <= NAVIGATION_LIMITS.candidates + 2, `Visited ${visits} source rows`);
			assert.ok(rows.every((row) => row.membership_revision === 1));
		}
	} finally {
		await f.close();
	}
});

test("logical Recent excludes pinned projects and individual pins but retains projectless conversations", async () => {
	const f = fixture();
	try {
		f.db.exec(
			"UPDATE project_memberships SET project_id=NULL WHERE conversation_id>='c00140'; INSERT INTO project_presentations VALUES('first',1,1,1); UPDATE project_presentation_state SET order_generation=1,next_ordinal=2",
		);
		const initial = f.projection.list({ view: { kind: "project_recent" } });
		assert.deepEqual(initial.items, []);
		assert.ok(initial.nextCursor);
		assert.equal(initial.coverage.projectOrderGeneration, 1);
		assert.equal(f.collect({ kind: "project_recent" }).length, 20);
		assert.equal(f.collect({ kind: "project", projectId: "first" }).length, 280);
		assert.equal(f.collect({ kind: "recent" }).length, 300);
		f.db.exec(
			"INSERT INTO conversation_presentations VALUES('a','c00140',1); UPDATE presentation_state SET generation=1",
		);
		const recent = f.collect({ kind: "project_recent" });
		assert.equal(recent.length, 19);
		assert.ok(recent.every((row) => row.membership?.projectId === null));
		assert.equal(f.collect({ kind: "recent" }).length, 299);
		const logicalCursor = f.projection.list({ view: { kind: "project_recent" } }).nextCursor;
		const projectCursor = f.projection.list({ view: { kind: "project", projectId: "first" } }).nextCursor;
		const physicalCursor = f.projection.list({ view: { kind: "recent" } }).nextCursor;
		assert.ok(logicalCursor && projectCursor && physicalCursor);
		f.db.exec(
			"UPDATE project_presentations SET pinned=0,revision=2,pin_ordinal=NULL; UPDATE project_presentation_state SET order_generation=2",
		);
		assert.throws(() => f.projection.list({ view: { kind: "project_recent" }, cursor: logicalCursor }), {
			code: "CURSOR_STALE",
		});
		assert.throws(() => f.projection.list({ view: { kind: "project", projectId: "first" }, cursor: projectCursor }), {
			code: "CURSOR_STALE",
		});
		assert.equal(f.projection.list({ view: { kind: "recent" }, cursor: physicalCursor }).items.length, 50);
		assert.equal(f.collect({ kind: "project_recent" }).length, 299);
	} finally {
		await f.close();
	}
});

test("project page wire shape requires its membership fence and matching canonical row membership", async () => {
	const f = fixture(4);
	try {
		for (const projectId of [null, "first"])
			assert.equal(
				parseRequest({
					version: PROTOCOL_VERSION,
					method: "listSidebarConversations",
					params: { view: { kind: "project", projectId } },
				}).method,
				"listSidebarConversations",
			);
		assert.equal(
			parseRequest({
				version: PROTOCOL_VERSION,
				method: "listSidebarConversations",
				params: { view: { kind: "project_recent" } },
			}).method,
			"listSidebarConversations",
		);
		for (const view of [
			{ kind: "project_recent", projectId: null },
			{ kind: "project_recent", workspaceId: "a" },
			{ kind: "project", projectId: "first", workspaceId: "a" },
		])
			assert.throws(
				() => parseRequest({ version: PROTOCOL_VERSION, method: "listSidebarConversations", params: { view } }),
				{ code: "INVALID_REQUEST" },
			);
		const page = f.projection.list({ view: { kind: "project", projectId: "first" } });
		assert.deepEqual(parseResult("listSidebarConversations", page), page);
		const row = page.items[0];
		for (const field of ["projectMembershipGeneration", "projectOrderGeneration"])
			for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "1"])
				assert.throws(
					() =>
						parseResult("listSidebarConversations", {
							...page,
							coverage: { ...page.coverage, [field]: invalid },
						}),
					{ code: "INVALID_REQUEST" },
				);
		for (const membership of [undefined, { ...row.membership, workspaceId: "other" }])
			assert.throws(() => parseResult("listSidebarConversations", { ...page, items: [{ ...row, membership }] }), {
				code: "INVALID_REQUEST",
			});
		assert.throws(
			() =>
				parseResult("listSidebarConversations", {
					...page,
					coverage: { ...page.coverage, projectMembershipGeneration: undefined },
				}),
			{ code: "INVALID_REQUEST" },
		);
		assert.throws(
			() =>
				parseResult("listSidebarConversations", {
					...page,
					coverage: { ...page.coverage, projectOrderGeneration: undefined },
				}),
			{ code: "INVALID_REQUEST" },
		);
		assert.deepEqual(
			parseResult("listSidebarConversations", f.projection.list({ view: { kind: "project_recent" } })),
			f.projection.list({ view: { kind: "project_recent" } }),
		);
		const physical = f.projection.list({ view: { kind: "recent" } });
		assert.equal(physical.coverage.projectMembershipGeneration, undefined);
		assert.deepEqual(parseResult("listSidebarConversations", physical), physical);
	} finally {
		await f.close();
	}
});

test("project count includes pinned members and explicit archive filters independently of sidebar exclusion", async () => {
	const f = fixture(8);
	try {
		for (const c of f.conversations.slice(0, 3))
			f.db.prepare("INSERT INTO conversation_presentations VALUES(?,?,1)").run(c.workspaceId, c.conversationId);
		f.db.exec("INSERT INTO project_presentations VALUES('first',1,1,1)");
		const c = f.conversations[0];
		f.db
			.prepare("UPDATE navigation_sources SET conversation=? WHERE workspace_id=? AND public_id=?")
			.run(JSON.stringify({ ...c, archivedAt: 5, revision: 2 }), c.workspaceId, c.conversationId);
		assert.equal(f.projection.projectSummary({ projectId: "first", filter: "all" }).matchedAtLeast, 8);
		assert.equal(f.projection.projectSummary({ projectId: "first", filter: "active" }).matchedAtLeast, 7);
		assert.equal(f.projection.projectSummary({ projectId: "first", filter: "archived" }).matchedAtLeast, 1);
		const summary = f.projection.projectSummary({ projectId: "first", filter: "all" });
		assert.equal(summary.complete, true);
		assert.deepEqual(parseResult("getProjectConversationSummary", summary), summary);
		f.db
			.prepare("UPDATE project_memberships SET project_id='second' WHERE workspace_id=? AND conversation_id=?")
			.run(c.workspaceId, c.conversationId);
		f.db.exec("UPDATE project_catalog_state SET membership_generation=membership_generation+1");
		const changed = f.projection.projectSummary({ projectId: "first", filter: "all" });
		assert.equal(changed.matchedAtLeast, 7);
		assert.equal(changed.coverage.projectMembershipGeneration, summary.coverage.projectMembershipGeneration + 1);
		assert.throws(() => f.projection.projectSummary({ projectId: "missing", filter: "all" }), { code: "NOT_FOUND" });
	} finally {
		await f.close();
	}
});

test("project count never calls missing, rebuilding or unfinished metadata a complete zero", async () => {
	const f = fixture(4);
	try {
		f.db.exec("DELETE FROM navigation_sources");
		const missing = f.projection.projectSummary({ projectId: "first", filter: "all" });
		assert.equal(missing.matchedAtLeast, 0);
		assert.equal(missing.complete, false);
		f.db.exec("UPDATE navigation_publication SET cycle=NULL,generation=NULL");
		const building = f.projection.projectSummary({ projectId: "first", filter: "all" });
		assert.equal(building.coverage.state, "building");
		assert.equal(building.complete, false);
		assert.deepEqual(parseResult("getProjectConversationSummary", building), building);
		f.db.exec("UPDATE project_catalog_state SET state='adopting'");
		assert.throws(() => f.projection.projectSummary({ projectId: "first", filter: "all" }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
	} finally {
		await f.close();
	}
});

test("project count drives bounded membership seek at20k rows without count scans or pin predicates", async () => {
	const f = fixture(20000);
	try {
		const plan = f.db
			.prepare(`EXPLAIN QUERY PLAN ${PROJECT_SUMMARY_CANDIDATES}`)
			.all(f.cycle, "first", 129)
			.map((row) => String(row.detail))
			.join("\n");
		assert.match(plan, /SEARCH m USING COVERING INDEX project_membership_scope/);
		assert.match(plan, /SEARCH n USING INDEX sqlite_autoindex_navigation_sources/);
		assert.doesNotMatch(plan, /TEMP B-TREE|SCAN/);
		assert.equal(f.db.prepare(PROJECT_SUMMARY_CANDIDATES).all(f.cycle, "first", 129).length, 129);
		const result = f.projection.projectSummary({ projectId: "first", filter: "all" });
		assert.equal(result.matchedAtLeast, 128);
		assert.equal(result.complete, false);
		f.db.exec("UPDATE navigation_state SET active=1");
		const empty = f.projection.projectSummary({ projectId: "second", filter: "all" });
		assert.equal(empty.matchedAtLeast, 0);
		assert.equal(empty.complete, false);
		assert.equal(empty.coverage.state, "refreshing");
	} finally {
		await f.close();
	}
});
