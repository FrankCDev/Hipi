import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PINNED_PROJECT_CANDIDATES, ProjectCatalog, UNPINNED_PROJECT_CANDIDATES } from "../../src/projects/catalog.ts";
import { initializeProjectStore } from "../../src/projects/schema.ts";

test("project list uses indexed bounded candidates across 20k sparse pinned exclusions", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY,name TEXT,ready INTEGER)");
	initializeProjectStore(db, { pristine: true });
	db.exec("BEGIN");
	const project = db.prepare("INSERT INTO projects VALUES (?, ?, 1, ?, 'legacy', 'ready')");
	const pin = db.prepare("INSERT INTO project_presentations VALUES (?,1,1,?)");
	for (let i = 0; i < 20000; i++) {
		const id = `p${String(i).padStart(5, "0")}`;
		project.run(id, id, id);
		if (i < 19999) pin.run(id, i + 1);
	}
	db.exec("COMMIT");
	const denied = async (): Promise<never> => {
		throw new Error("list must not access physical storage");
	};
	const catalog = new ProjectCatalog(db, "store", {
		getWorkspace: denied,
		verifyWorkspace: denied,
		getConversation: denied,
		prepareWorkspace: denied,
		getConversationCommandResult: denied,
	});
	try {
		for (const [sql, anchor] of [
			[PINNED_PROJECT_CANDIDATES, 0],
			[UNPINNED_PROJECT_CANDIDATES, ""],
		] as const) {
			const plan = db
				.prepare(`EXPLAIN QUERY PLAN ${sql}`)
				.all(anchor, 51)
				.map((row) => String(row.detail))
				.join("\n");
			assert.match(plan, /SEARCH/);
			assert.doesNotMatch(plan, /TEMP B-TREE|SCAN p\b|SCAN s\b/);
			let visits = 0;
			db.function("visit", (value) => {
				visits++;
				return value;
			});
			assert.equal(db.prepare(sql.replace("p.name", "visit(p.name) AS name")).all(anchor, 51).length, 51);
			assert.equal(visits, 51);
		}
		let page = catalog.list({}),
			count = page.items.length,
			emptyContinuation = false;
		while (page.nextCursor) {
			page = catalog.list({ cursor: page.nextCursor });
			count += page.items.length;
			if (!page.items.length && page.nextCursor) emptyContinuation = true;
		}
		assert.equal(count, 20000);
		assert.equal(emptyContinuation, true);
		assert.equal(page.items.at(-1)?.project.projectId, "p19999");
		const first = catalog.list({});
		db.exec("UPDATE project_presentation_state SET order_generation=1");
		assert.throws(() => catalog.list({ cursor: first.nextCursor! }), { code: "CURSOR_STALE" });
	} finally {
		db.close();
	}
});
