import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Conversation, Scope } from "../../src/contracts.ts";
import type { SidebarView, SidebarWindowRequest, SidebarWindowResult } from "../../src/navigation/contracts.ts";
import { NavigationProjection } from "../../src/navigation/projection.ts";
import { type NavigationPosition, navigationIdentityQuery, navigationQuery } from "../../src/navigation/query.ts";
import { NAVIGATION_SCHEMA } from "../../src/navigation/schema.ts";
import { initializeProjectStore } from "../../src/projects/schema.ts";

type Window = Extract<SidebarWindowResult, { kind: "window" }>;
function fixture(count = 800) {
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
	for (let index = 0; index < count; index++) {
		const s = scope(index),
			recency = index >= count - 20 ? null : Math.floor((count - index) / 10);
		const conversation: Conversation = {
			...s,
			title: s.conversationId,
			revision: 1,
			createdAt: recency,
			archivedAt: null,
		};
		insert.run(
			s.workspaceId,
			s.conversationId,
			JSON.stringify(["source", 1]),
			cycle,
			index,
			JSON.stringify(conversation),
			recency,
			recency === null ? "unknown" : "creation",
		);
		membership.run(s.workspaceId, s.conversationId, index % 3 === 0 ? null : index % 2 ? "second" : "first");
	}
	db.exec("COMMIT");
	const unexpected = () => {
		throw new Error("Window reads must not open durable sources");
	};
	const projection = new NavigationProjection(db, "store", {
		nextWorkspace: unexpected,
		prepareWorkspace: unexpected,
		nextConversation: unexpected,
		read: unexpected,
		hasWorkspace: (id) => id === "a" || id === "b",
	});
	let fetched = 0;
	const prepare = db.prepare.bind(db);
	// Count each row materialized by the actual production point/range SELECT.
	db.function("window_visit", () => {
		fetched++;
		return 1;
	});
	db.prepare = (sql) =>
		prepare(
			sql.startsWith("SELECT n.*,") ? sql.replace("SELECT n.*,", "SELECT n.*,window_visit() AS window_visit,") : sql,
		);
	const read = (input: SidebarWindowRequest) => {
		fetched = 0;
		const result = projection.window(input);
		assert.ok(fetched <= 128, `Fetched ${fetched} navigation source rows`);
		if (result.kind === "window") {
			assert.ok(result.items.length <= 50);
			assert.ok(result.retained.eligible.length + result.retained.unavailable.length <= 2);
			for (const proof of result.retained.eligible)
				if (proof.placement === "inside")
					assert.ok(result.items.some((item) => key(item.conversation) === key(proof.row.conversation)));
		}
		return result;
	};
	const window = (input: SidebarWindowRequest): Window => {
		const result = read(input);
		assert.equal(result.kind, "window");
		return result as Window;
	};
	const ordered = (view: SidebarView) => {
		const items = [];
		let cursor: string | undefined;
		do {
			const page = projection.list({ view, cursor });
			items.push(...page.items);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return items;
	};
	return {
		db,
		cycle,
		projection,
		read,
		window,
		ordered,
		get fetched() {
			return fetched;
		},
		close: async () => {
			await projection.close();
			db.close();
		},
	};
}
const key = (s: Scope) => JSON.stringify([s.workspaceId, s.conversationId]);
const keys = (window: Window) => window.items.map((item) => key(item.conversation));
const scope = (index: number): Scope => ({
	workspaceId: index % 2 ? "b" : "a",
	conversationId: `c${String(Math.floor(index / 2)).padStart(5, "0")}`,
});

test("bidirectional windows cross retention-scale history without omissions, duplicates or tie-order guesses", async () => {
	const f = fixture();
	try {
		for (const view of [
			{ kind: "recent" },
			{ kind: "workspace", workspaceId: "a" },
			{ kind: "project", projectId: "first" },
			{ kind: "project", projectId: null },
			{ kind: "project_recent" },
		] as SidebarView[]) {
			const expected = f.ordered(view).map((item) => key(item.conversation));
			let page = f.window({ view, position: { kind: "head" } });
			assert.equal(page.previousCursor, null);
			const forwards = [...keys(page)];
			while (page.nextCursor) {
				page = f.window({ view, position: { kind: "continue", cursor: page.nextCursor } });
				forwards.push(...keys(page));
			}
			assert.deepEqual(forwards, expected);
			const backwards = [...keys(page)];
			while (page.previousCursor) {
				page = f.window({ view, position: { kind: "continue", cursor: page.previousCursor } });
				backwards.unshift(...keys(page));
			}
			assert.deepEqual(backwards, expected);
		}
	} finally {
		await f.close();
	}
});

test("filtered-empty intervals advance both directions with truthful consumed-range placement", async () => {
	const f = fixture(1000),
		view = { kind: "recent" } as const;
	try {
		f.db.exec(
			"INSERT INTO conversation_presentations SELECT workspace_id,public_id,1 FROM navigation_sources WHERE ordinal BETWEEN 100 AND 850",
		);
		const expected = f.ordered(view).map((item) => key(item.conversation));
		let page = f.window({ view, position: { kind: "head" } });
		const forward = [...keys(page)];
		let empty = false;
		while (page.nextCursor) {
			const cursor = page.nextCursor;
			page = f.window({ view, position: { kind: "continue", cursor }, retainedScopes: [scope(0), scope(999)] });
			if (!page.items.length) {
				empty = true;
				assert.ok(page.nextCursor && page.nextCursor !== cursor);
				assert.deepEqual(
					page.retained.eligible.map((proof) => proof.placement),
					["before", "after"],
				);
			}
			forward.push(...keys(page));
		}
		assert.equal(empty, true);
		assert.deepEqual(forward, expected);
		const backward = [...keys(page)];
		while (page.previousCursor) {
			page = f.window({ view, position: { kind: "continue", cursor: page.previousCursor } });
			backward.unshift(...keys(page));
		}
		assert.deepEqual(backward, expected);
	} finally {
		await f.close();
	}
});

test("around splits one budget, includes anchor once and never refills edge allocations", async () => {
	const f = fixture(),
		view = { kind: "recent" } as const;
	try {
		const all = f.ordered(view);
		for (const index of [0, 1, 24, 25, 400, all.length - 1]) {
			const anchor = all[index].conversation;
			const page = f.window({ view, position: { kind: "around", anchor }, retainedScopes: [scope(10), scope(12)] });
			assert.deepEqual(
				keys(page),
				all.slice(Math.max(0, index - 24), index + 26).map((item) => key(item.conversation)),
			);
			assert.equal(keys(page).filter((value) => value === key(anchor)).length, 1);
			assert.equal(page.previousCursor === null, index <= 24);
			assert.equal(page.nextCursor === null, index + 26 >= all.length);
		}
		const anchor = all[400].conversation;
		const reused = f.window({ view, position: { kind: "around", anchor }, retainedScopes: [anchor, anchor] });
		assert.equal(f.fetched, 128);
		assert.equal(reused.retained.eligible.length, 1);
		assert.equal(reused.retained.eligible[0].placement, "inside");
	} finally {
		await f.close();
	}
});

test("retained proofs are canonical, membership-fenced and bounded without exposed ordinal", async () => {
	const f = fixture(),
		view = { kind: "project_recent" } as const;
	try {
		const all = f.ordered(view),
			left = all[1].conversation,
			right = all[2].conversation;
		const page = f.window({
			view,
			position: { kind: "around", anchor: all[400].conversation },
			retainedScopes: [right, left],
		});
		assert.deepEqual(
			page.retained.eligible.map((proof) => key(proof.row.conversation)),
			[key(left), key(right)],
		);
		assert.ok(
			page.retained.eligible.every((proof) => proof.placement === "before" && !Object.hasOwn(proof, "position")),
		);
		f.db.prepare("INSERT INTO conversation_presentations VALUES(?,?,1)").run(left.workspaceId, left.conversationId);
		f.db.exec("UPDATE presentation_state SET generation=1");
		const unavailable = f.window({
			view,
			position: { kind: "head" },
			retainedScopes: [left, { workspaceId: "a", conversationId: "absent" }],
		});
		assert.deepEqual(
			unavailable.retained.unavailable.map((proof) => proof.reason),
			["ineligible", "missing"],
		);
		f.db.exec(
			"INSERT INTO project_presentations VALUES('first',1,1,1); UPDATE project_presentation_state SET order_generation=1",
		);
		const pinned = f.read({ view, position: { kind: "around", anchor: scope(8) } });
		assert.equal(pinned.kind, "anchor_unavailable");
		if (pinned.kind === "anchor_unavailable") assert.equal(pinned.reason, "ineligible");
		assert.ok(
			f
				.window({ view: { kind: "project", projectId: "first" }, position: { kind: "around", anchor: scope(8) } })
				.items.some((row) => key(row.conversation) === key(scope(8))),
		);
	} finally {
		await f.close();
	}
});

test("published missing, ineligible, corruption and unpublished are distinct outcomes", async () => {
	const f = fixture(),
		view = { kind: "project", projectId: "first" } as const;
	try {
		const missing = f.read({
			view,
			position: { kind: "around", anchor: { workspaceId: "a", conversationId: "absent" } },
		});
		assert.equal(missing.kind, "anchor_unavailable");
		if (missing.kind === "anchor_unavailable") assert.equal(missing.reason, "missing");
		const wrong = f.read({ view, position: { kind: "around", anchor: scope(1) } });
		assert.equal(wrong.kind, "anchor_unavailable");
		if (wrong.kind === "anchor_unavailable") assert.equal(wrong.reason, "ineligible");
		f.db.exec("DELETE FROM project_memberships WHERE workspace_id='a' AND conversation_id='c00001'");
		assert.throws(() => f.read({ view, position: { kind: "around", anchor: scope(2) } }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
		f.db.exec("UPDATE navigation_publication SET cycle=NULL,generation=NULL");
		assert.equal(f.read({ view, position: { kind: "around", anchor: scope(2) } }).kind, "unpublished");
	} finally {
		await f.close();
	}
});

test("directional cursor kinds, all generation fences, query identities and zero-range rejection", async () => {
	const f = fixture(),
		view = { kind: "project_recent" } as const;
	try {
		const cursor = f.window({ view, position: { kind: "head" } }).nextCursor;
		assert.ok(cursor);
		const data: Record<string, unknown> = JSON.parse(Buffer.from(cursor, "base64url").toString());
		for (const change of [
			{ direction: "sideways" },
			{ storeId: "other" },
			{ boundary: [-1, "a", 99999, "absent"] },
			{ extra: true },
		]) {
			const invalid = Buffer.from(JSON.stringify({ ...data, ...change })).toString("base64url");
			assert.throws(() => f.read({ view, position: { kind: "continue", cursor: invalid } }), {
				code: "INVALID_REQUEST",
			});
		}
		const legacy = f.projection.list({ view }).nextCursor;
		assert.ok(legacy);
		assert.throws(() => f.read({ view, position: { kind: "continue", cursor: legacy } }), {
			code: "INVALID_REQUEST",
		});
		assert.throws(() => f.projection.list({ view, cursor }), { code: "INVALID_REQUEST" });
		assert.throws(() => f.read({ view: { kind: "recent" }, position: { kind: "continue", cursor } }), {
			code: "INVALID_REQUEST",
		});
		assert.throws(() => f.read({ view, filter: "all", position: { kind: "continue", cursor } }), {
			code: "INVALID_REQUEST",
		});
		for (const sql of [
			"UPDATE navigation_publication SET generation='replacement'",
			"UPDATE presentation_state SET generation=generation+1",
			"UPDATE project_catalog_state SET membership_generation=membership_generation+1",
			"UPDATE project_presentation_state SET order_generation=order_generation+1",
		]) {
			const next = f.window({ view, position: { kind: "head" } }).nextCursor;
			assert.ok(next);
			f.db.exec(sql);
			assert.throws(() => f.read({ view, position: { kind: "continue", cursor: next } }), { code: "CURSOR_STALE" });
		}
		const first = f.db
			.prepare(
				"SELECT * FROM navigation_sources WHERE cycle=? ORDER BY recency_key,workspace_id,ordinal,public_id LIMIT 1",
			)
			.get(f.cycle);
		assert.ok(first);
		const fresh = f.window({ view, position: { kind: "head" } }).nextCursor;
		assert.ok(fresh);
		const base: Record<string, unknown> = JSON.parse(Buffer.from(fresh, "base64url").toString());
		const invalidEnd = Buffer.from(
			JSON.stringify({
				...base,
				direction: "previous",
				boundary: [first.recency_at ?? -1, first.workspace_id, first.ordinal, first.public_id],
			}),
		).toString("base64url");
		assert.throws(() => f.read({ view, position: { kind: "continue", cursor: invalidEnd } }), {
			code: "INVALID_REQUEST",
		});
	} finally {
		await f.close();
	}
});

test("empty head, refreshing publication and sparse strict128 budgets", async () => {
	const empty = fixture(0);
	try {
		const page = empty.window({ view: { kind: "recent" }, position: { kind: "head" }, retainedScopes: [scope(0)] });
		assert.deepEqual(page.items, []);
		assert.equal(page.previousCursor, null);
		assert.equal(page.nextCursor, null);
		assert.equal(page.retained.unavailable[0].reason, "missing");
	} finally {
		await empty.close();
	}
	const f = fixture(2000),
		view = { kind: "project", projectId: "first" } as const;
	try {
		f.db.exec("UPDATE project_memberships SET project_id='second' WHERE conversation_id!='c00200'");
		const page = f.window({ view, position: { kind: "head" }, retainedScopes: [scope(400), scope(402)] });
		assert.equal(f.fetched, 128);
		assert.deepEqual(page.items, []);
		assert.ok(page.nextCursor);
		f.window({
			view,
			position: { kind: "continue", cursor: page.nextCursor },
			retainedScopes: [scope(400), scope(402)],
		});
		assert.equal(f.fetched, 128);
		const around = f.window({
			view,
			position: { kind: "around", anchor: scope(400) },
			retainedScopes: [scope(2), scope(4)],
		});
		assert.equal(f.fetched, 128);
		assert.equal(around.items.length, 1);
		f.projection.invalidate();
		assert.equal(f.window({ view, position: { kind: "head" } }).coverage.state, "refreshing");
	} finally {
		await f.close();
	}
});

test("20k production forward/reverse/identity queries use existing indexes without sorting or corpus scan", async () => {
	const f = fixture(20000);
	try {
		for (const workspace of [undefined, "a"])
			for (const direction of ["previous", "next"] as const)
				for (const boundary of [
					[600, "a", 14000, "c07000"],
					[-1, "a", 19992, "c09996"],
				] as NavigationPosition[]) {
					const query = navigationQuery(f.cycle, workspace, boundary, true, direction, 62);
					const plan = f.db
						.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
						.all(...query.params)
						.map((row) => String(row.detail));
					assert.ok(
						plan.some(
							(line) =>
								line.includes(workspace ? "navigation_workspace" : "navigation_recent") &&
								line.includes(direction === "previous" ? "<" : ">"),
						),
						plan.join("\n"),
					);
					assert.ok(
						plan.every((line) => !line.includes("TEMP B-TREE") && !line.startsWith("SCAN n")),
						plan.join("\n"),
					);
				}
		const identity = navigationIdentityQuery(f.cycle, scope(14000), true);
		const plan = f.db
			.prepare(`EXPLAIN QUERY PLAN ${identity.sql}`)
			.all(...identity.params)
			.map((row) => String(row.detail));
		assert.ok(
			plan.some(
				(line) =>
					line.includes("sqlite_autoindex_navigation_sources_1") &&
					line.includes("cycle=?") &&
					line.includes("workspace_id=?") &&
					line.includes("public_id=?"),
			),
			plan.join("\n"),
		);
		assert.ok(
			plan.every((line) => !line.startsWith("SCAN") && !line.includes("TEMP B-TREE")),
			plan.join("\n"),
		);
		f.window({
			view: { kind: "project_recent" },
			position: { kind: "around", anchor: scope(14000) },
			retainedScopes: [scope(19400), scope(19390)],
		});
		assert.equal(f.fetched, 128);
	} finally {
		await f.close();
	}
});

test("exact candidate edges and filtered prefix/tail remain reversible", async () => {
	for (const count of [1, 49, 50, 51, 126, 127, 128, 129, 500]) {
		const f = fixture(count),
			view = { kind: "recent" } as const;
		try {
			if (count === 500)
				f.db.exec(
					"INSERT INTO conversation_presentations SELECT workspace_id,public_id,1 FROM navigation_sources WHERE ordinal<150 OR ordinal>349",
				);
			const expected = f.ordered(view).map((row) => key(row.conversation));
			let page = f.window({ view, position: { kind: "head" } });
			const forward = [...keys(page)];
			while (page.nextCursor) {
				page = f.window({ view, position: { kind: "continue", cursor: page.nextCursor } });
				forward.push(...keys(page));
			}
			assert.deepEqual(forward, expected);
			const backward = [...keys(page)];
			while (page.previousCursor) {
				page = f.window({ view, position: { kind: "continue", cursor: page.previousCursor } });
				backward.unshift(...keys(page));
			}
			assert.deepEqual(backward, expected);
		} finally {
			await f.close();
		}
	}
});

test("archive eligibility and pure pin reorder share legacy semantics; forged present tuples fail", async () => {
	const f = fixture(),
		view = { kind: "recent" } as const;
	try {
		f.db.exec(
			"UPDATE navigation_sources SET conversation=json_set(conversation,'$.archivedAt',123) WHERE ordinal%2=0",
		);
		for (const filter of ["active", "archived", "all"] as const) {
			let page = f.window({ view, filter, position: { kind: "head" } }),
				cursor: string | undefined;
			const actual = [...keys(page)],
				expected: string[] = [];
			while (page.nextCursor) {
				page = f.window({ view, filter, position: { kind: "continue", cursor: page.nextCursor } });
				actual.push(...keys(page));
			}
			do {
				const old = f.projection.list({ view, filter, cursor });
				expected.push(...old.items.map((row) => key(row.conversation)));
				cursor = old.nextCursor ?? undefined;
			} while (cursor);
			assert.deepEqual(actual, expected);
		}
		const cursor = f.window({ view, position: { kind: "head" } }).nextCursor;
		assert.ok(cursor);
		f.db.exec("UPDATE presentation_state SET order_generation=order_generation+1");
		f.window({ view, position: { kind: "continue", cursor } });
		const data = JSON.parse(Buffer.from(cursor, "base64url").toString());
		for (const index of [0, 2]) {
			const boundary = [...data.boundary];
			boundary[index]++;
			const forged = Buffer.from(JSON.stringify({ ...data, boundary })).toString("base64url");
			assert.throws(() => f.read({ view, position: { kind: "continue", cursor: forged } }), {
				code: "INVALID_REQUEST",
			});
		}
	} finally {
		await f.close();
	}
});

test("dirty metadata uses only live-cycle identity seeks and resets on live source replacement", async () => {
	const f = fixture(20000),
		view = { kind: "recent" } as const;
	try {
		const staging = randomUUID(),
			retired = randomUUID(),
			s = scope(4);
		for (const cycle of [staging, retired])
			f.db
				.prepare(
					"INSERT INTO navigation_sources(workspace_id,public_id,source_generation,cycle,ordinal,conversation,recency_at,basis) SELECT workspace_id,public_id,source_generation,?,ordinal,conversation,recency_at,basis FROM navigation_sources WHERE cycle=? AND workspace_id=? AND public_id=?",
				)
				.run(cycle, f.cycle, s.workspaceId, s.conversationId);
		f.db.prepare("UPDATE navigation_state SET cycle=?,active=1").run(staging);
		f.db
			.prepare("UPDATE navigation_sources SET source_generation=? WHERE cycle=?")
			.run(JSON.stringify(["retired", 9]), retired);
		const conversation = JSON.parse(
			String(
				f.db
					.prepare("SELECT conversation FROM navigation_sources WHERE cycle=? AND workspace_id=? AND public_id=?")
					.get(f.cycle, s.workspaceId, s.conversationId)?.conversation,
			),
		);
		const statements: string[] = [];
		const prepare = f.db.prepare.bind(f.db);
		f.db.prepare = (sql) => {
			statements.push(sql);
			return prepare(sql);
		};
		f.projection.invalidate({
			reset: false,
			conversations: [
				{ conversation: { ...conversation, title: "updated", revision: 2 }, generation: "source", durableId: 1 },
			],
		});
		const result = f.window({ view, position: { kind: "around", anchor: s } });
		assert.equal(result.items.find((row) => key(row.conversation) === key(s))?.conversation.title, "updated");
		assert.equal(result.coverage.state, "refreshing");
		const rows = f.db
			.prepare("SELECT cycle,conversation FROM navigation_sources WHERE workspace_id=? AND public_id=?")
			.all(s.workspaceId, s.conversationId);
		for (const row of rows)
			assert.equal(
				JSON.parse(String(row.conversation)).title,
				row.cycle === retired ? conversation.title : "updated",
			);
		const maintenance = statements.filter(
			(sql) =>
				sql.startsWith("SELECT 1 FROM navigation_sources") ||
				sql.startsWith("UPDATE navigation_sources SET conversation"),
		);
		assert.equal(maintenance.length, 4);
		for (const sql of maintenance) {
			const plan = f.db
				.prepare(`EXPLAIN QUERY PLAN ${sql}`)
				.all(...Array(sql.split("?").length - 1).fill("x"))
				.map((row) => String(row.detail));
			assert.ok(
				plan.some(
					(line) =>
						line.includes("sqlite_autoindex_navigation_sources_1") &&
						line.includes("cycle=? AND workspace_id=? AND public_id=?"),
				),
				plan.join("\n"),
			);
			assert.ok(
				plan.every((line) => !line.startsWith("SCAN")),
				plan.join("\n"),
			);
		}
		f.projection.invalidate({
			reset: false,
			conversations: [{ conversation: { ...conversation, revision: 3 }, generation: "replacement", durableId: 2 }],
		});
		assert.equal(f.read({ view, position: { kind: "head" } }).kind, "unpublished");
	} finally {
		await f.close();
	}
});
