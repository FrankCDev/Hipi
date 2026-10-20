import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NavigationProjection } from "../../src/navigation/projection.ts";
import { type NavigationPosition, navigationQuery } from "../../src/navigation/query.ts";
import { NAVIGATION_SCHEMA } from "../../src/navigation/schema.ts";

function fixture() {
	const db = new DatabaseSync(":memory:"),
		cycle = randomUUID(),
		generation = randomUUID();
	db.exec(NAVIGATION_SCHEMA);
	db.exec(
		"CREATE TABLE presentation_state(singleton INTEGER,generation INTEGER); INSERT INTO presentation_state VALUES(1,0); CREATE TABLE conversation_presentations(workspace_id TEXT,public_id TEXT,pin_ordinal INTEGER,PRIMARY KEY(workspace_id,public_id)); BEGIN",
	);
	db.prepare("INSERT INTO navigation_state VALUES(1,?,0,0,?,'',NULL,'',NULL,NULL,1,0)").run(generation, cycle);
	db.prepare("UPDATE navigation_publication SET cycle=?,generation=?").run(cycle, generation);
	const insert = db.prepare("INSERT INTO navigation_sources VALUES(?,?,?,?,?,?,?,?)");
	for (let i = 0; i < 20000; i++) {
		const workspaceId = i % 2 ? "b" : "a",
			conversationId = `c${String(i).padStart(5, "0")}`,
			recency = i >= 19000 ? null : Math.floor((19000 - i) / 10);
		insert.run(
			workspaceId,
			conversationId,
			JSON.stringify(["source", 1]),
			cycle,
			i,
			JSON.stringify({
				workspaceId,
				conversationId,
				title: conversationId,
				revision: 1,
				createdAt: 1,
				archivedAt: null,
			}),
			recency,
			recency === null ? "unknown" : "creation",
		);
		if (i < 500) db.prepare("INSERT INTO conversation_presentations VALUES(?,?,1)").run(workspaceId, conversationId);
	}
	db.exec("COMMIT");
	return { db, cycle };
}

test("actual global/workspace SQL seeks first/deep/unknown keysets without a temp sort or corpus scan", () => {
	const { db, cycle } = fixture();
	let visits = 0;
	db.function("navigation_visit", () => {
		visits++;
		return 1;
	});
	try {
		for (const workspace of [undefined, "a"])
			for (const after of [undefined, [500, "a", 14000, "c14000"], [-1, "a", 19400, "c19400"]] as (
				| NavigationPosition
				| undefined
			)[]) {
				const query = navigationQuery(cycle, workspace, after);
				const plan = db
					.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
					.all(...query.params)
					.map((row) => String(row.detail));
				assert.ok(plan.some((detail) => detail.includes(workspace ? "navigation_workspace" : "navigation_recent")));
				assert.ok(plan.every((detail) => !detail.includes("TEMP B-TREE")));
				if (after)
					assert.ok(
						plan.some((detail) => detail.includes("recency_key") && detail.includes(">")),
						plan.join("\n"),
					);
				visits = 0;
				const rows = db
					.prepare(query.sql.replace("WHERE n.cycle=?", "WHERE navigation_visit() AND n.cycle=?"))
					.all(...query.params);
				assert.equal(rows.length, 129);
				assert.ok(visits <= 130, `${workspace ?? "recent"} visited ${visits}`);
				if (after?.[0] === -1) assert.ok(rows.every((row) => row.recency_at === null));
			}
	} finally {
		db.close();
	}
});

test("indexed pages preserve canonical ties, unknown-last ordering and authoritative pin exclusion", async () => {
	const { db, cycle } = fixture();
	const unexpected = () => {
		throw new Error("Published list must not read sources");
	};
	const projection = new NavigationProjection(db, "store", {
		nextWorkspace: unexpected,
		prepareWorkspace: unexpected,
		nextConversation: unexpected,
		read: unexpected,
		hasWorkspace: (id) => id === "a" || id === "b",
	});
	try {
		for (const workspace of [undefined, "a"]) {
			const actual: string[] = [];
			let cursor: string | undefined;
			let emptyContinuation = false;
			do {
				const page = projection.list({
					view: workspace ? { kind: "workspace", workspaceId: workspace } : { kind: "recent" },
					...(cursor ? { cursor } : {}),
				});
				if (!page.items.length && page.nextCursor) emptyContinuation = true;
				actual.push(...page.items.map((item) => item.conversation.conversationId));
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
			const expected = db
				.prepare(
					`SELECT public_id FROM navigation_sources WHERE cycle=? AND ordinal>=500 ${workspace ? "AND workspace_id=?" : ""} ORDER BY recency_at DESC,workspace_id,ordinal,public_id`,
				)
				.all(cycle, ...(workspace ? [workspace] : []))
				.map((row) => String(row.public_id));
			assert.deepEqual(actual, expected);
			assert.equal(new Set(actual).size, actual.length);
			assert.equal(emptyContinuation, true);
		}
	} finally {
		await projection.close();
		db.close();
	}
});
