import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { type SearchPorts, SearchProjection } from "../src/search/index.ts";
import { SEARCH_SCHEMA, validateSearchStore } from "../src/search/schema.ts";
import { indexSource, type SearchReader, type SearchSource } from "../src/search/storage.ts";

function database() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY,name TEXT,ready INTEGER)");
	db.exec(SEARCH_SCHEMA);
	const cycle = randomUUID();
	db.prepare("INSERT INTO search_state VALUES (1,?,?,0,'',NULL,'',NULL,NULL,1)").run(randomUUID(), cycle);
	db.prepare("INSERT INTO workspaces VALUES ('w','Work',1)").run();
	return { db, cycle };
}
function source(publicId: string, generation = "g", revision = 1): SearchSource {
	return {
		workspaceId: "w",
		conversationId: publicId,
		generation,
		durableId: 1,
		title: publicId,
		workspaceName: "Work",
		revision,
		archived: false,
	};
}
function putSource(db: DatabaseSync, item: SearchSource, cycle: string, indexed = 0) {
	db.prepare("INSERT INTO search_sources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
		item.workspaceId,
		item.conversationId,
		item.generation,
		cycle,
		item.durableId,
		item.title,
		item.workspaceName,
		0,
		item.revision,
		indexed,
		0,
		0,
		0,
		indexed,
	);
}
type TestEntry = { id: number; model: { role: "user"; content: string }[] };
function ports(item: SearchSource, entries: TestEntry[] = []): SearchPorts {
	const storage = {
		async scanEntries(query: { minEntryId?: number; maxEntryId?: number; order?: string }, limit: number) {
			const values = entries.filter(
				(entry) =>
					(query.minEntryId === undefined || entry.id >= query.minEntryId) &&
					(query.maxEntryId === undefined || entry.id <= query.maxEntryId),
			);
			values.sort((a, b) => (query.order === "ascending" ? a.id - b.id : b.id - a.id));
			return { items: values.slice(0, limit) };
		},
	} as unknown as SearchReader;
	return {
		nextWorkspace: (after) => (after < "w" ? { workspaceId: "w", name: "Work" } : undefined),
		prepareWorkspace: async () => true,
		nextConversation: (_workspace, after) =>
			after < item.conversationId ? { ...item, createdAt: null, archivedAt: null } : undefined,
		read: (_scope, operation) => operation(storage, item),
	};
}
test("replacement source can reset to lower entry and metadata revisions", async () => {
	const { db, cycle } = database();
	putSource(db, source("a", "old", 10), cycle, 100);
	const projection = new SearchProjection(
		db,
		"store",
		ports(source("a", "new", 1), [{ id: 1, model: [{ role: "user", content: "needle" }] }]),
	);
	try {
		await projection.refresh();
		assert.equal(projection.query("needle").items.length, 1);
	} finally {
		await projection.close();
		db.close();
	}
});
test("revalidating old chunk IDs invalidates query pagination membership", async () => {
	const { db, cycle } = database();
	putSource(db, source("a"), cycle, 200);
	putSource(db, source("b"), "older-cycle", 100);
	const insert = db.prepare(
		"INSERT INTO search_chunks(id,workspace_id,public_id,message_id,offset,text_length,text) VALUES (?,'w',?,?,0,6,'needle')",
	);
	for (let id = 1; id <= 200; id++) insert.run(id, id <= 100 ? "b" : "a", `${id}_0`);
	db.prepare("UPDATE search_state SET workspace_id='w',conversation_after='a',current_id='b'").run();
	const projection = new SearchProjection(db, "store", ports(source("b"), [{ id: 100, model: [] }]));
	try {
		const first = projection.query("needle");
		assert.ok(first.nextCursor);
		await projection.refresh();
		assert.throws(() => projection.query("needle", first.nextCursor ?? undefined), { code: "CURSOR_STALE" });
	} finally {
		await projection.close();
		db.close();
	}
});
for (const prepared of [false, true]) {
	test(`directory preparation (${prepared}) cannot overwrite concurrent invalidation`, async () => {
		const { db, cycle } = database();
		putSource(db, source("a"), cycle);
		db.prepare("UPDATE search_state SET workspace_after='b'").run();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<boolean>();
		const p = ports(source("a"));
		p.nextWorkspace = () => ({ workspaceId: "w", name: "Work" });
		p.prepareWorkspace = async () => {
			started.resolve();
			return release.promise;
		};
		const projection = new SearchProjection(db, "store", p);
		try {
			const pending = projection.refresh();
			await started.promise;
			projection.invalidate({ workspaceId: "w", conversationId: "a" });
			const generation = db.prepare("SELECT generation FROM search_state").get()?.generation;
			release.resolve(prepared);
			await assert.rejects(pending, { code: "CURSOR_STALE" });
			const state = db.prepare("SELECT * FROM search_state").get();
			assert.equal(state?.workspace_after, "");
			assert.equal(state?.generation, generation);
		} finally {
			release.resolve(false);
			await projection.close();
			db.close();
		}
	});
}
test("cancelled refresh commits no progress and projection query never reads source", async () => {
	const { db, cycle } = database();
	putSource(db, source("a"), cycle);
	const p = ports(source("a"));
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<boolean>();
	let reads = 0;
	p.prepareWorkspace = async () => {
		started.resolve();
		return release.promise;
	};
	p.read = async () => {
		reads++;
		throw new Error("Unexpected source read");
	};
	const projection = new SearchProjection(db, "store", p),
		abort = new AbortController();
	try {
		const revision = db.prepare("SELECT revision FROM search_state").get()?.revision;
		const pending = projection.refresh(undefined, abort.signal);
		await started.promise;
		abort.abort();
		release.resolve(false);
		await assert.rejects(pending, { code: "CLOSED" });
		assert.equal(db.prepare("SELECT revision FROM search_state").get()?.revision, revision);
		assert.equal(projection.query("needle").items.length, 0);
		assert.equal(reads, 0);
	} finally {
		release.resolve(false);
		await projection.close();
		db.close();
	}
});
test("search validator rejects malformed numeric, encoded and UTF16 fields", () => {
	const { db, cycle } = database();
	putSource(db, source("a"), cycle);
	try {
		validateSearchStore(db);
		for (const value of ["x".repeat(4096), 1.5, -1, 9007199254740992n]) {
			db.prepare("UPDATE search_state SET completed_at=?").run(value);
			assert.throws(() => validateSearchStore(db));
		}
		db.exec("UPDATE search_state SET completed_at=NULL");
		db.prepare("UPDATE search_sources SET title=?").run("😀".repeat(65));
		assert.throws(() => validateSearchStore(db));
		db.prepare("UPDATE search_sources SET title='Valid', pending_slot=0.5").run();
		assert.throws(() => validateSearchStore(db));
	} finally {
		db.close();
	}
});

test("large multipart text assembles once per message per step and is not retained between steps", async () => {
	let assemblies = 0;
	const firstText = "large multipart ".repeat(14000);
	const entry = {
		id: 1,
		model: [
			{
				role: "user",
				content: [
					{
						type: "text",
						get text() {
							assemblies++;
							return firstText;
						},
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "text",
						get text() {
							assemblies++;
							return "second message";
						},
					},
				],
			},
		],
	};
	const storage = {
		async scanEntries(query: { minEntryId?: number }) {
			return { items: (query.minEntryId ?? 0) <= 1 ? [entry] : [] };
		},
	} as unknown as SearchReader;
	let batch = await indexSource(storage, source("a"), {
		indexedEntry: 0,
		pendingEntry: 0,
		pendingSlot: 0,
		pendingOffset: 0,
		upperEntry: 1,
	});
	assert.equal(batch.chunks.length, 32);
	assert.equal(batch.complete, false);
	assert.equal(assemblies, 1, "chunk visits must reuse the step-local assembly");
	let steps = 1;
	while (!batch.complete) {
		const before: number = assemblies;
		batch = await indexSource(storage, source("a"), batch.position);
		steps++;
		assert.equal(
			assemblies - before,
			batch.complete ? 2 : 1,
			"resumed steps assemble again; changing slots uses fresh text",
		);
	}
	assert.ok(steps > 1);
	assert.equal(batch.chunks.at(-1)?.text, "second message");
	assert.equal(assemblies, steps + 1);
});
