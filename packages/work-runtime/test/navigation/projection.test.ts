import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type ConversationId, MemoryStorage } from "@earendil-works/pi-durable";
import { type Conversation, PROTOCOL_VERSION, parseRequest, parseResult } from "../../src/contracts.ts";
import { type NavigationPorts, NavigationProjection } from "../../src/navigation/projection.ts";
import { NAVIGATION_SCHEMA } from "../../src/navigation/schema.ts";

function conversation(workspaceId: string, conversationId: string, createdAt = 10): Conversation {
	return { workspaceId, conversationId, title: conversationId, revision: 1, createdAt, archivedAt: null };
}
async function fixture(count = 1) {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY,ready INTEGER); INSERT INTO workspaces VALUES ('a',1),('b',1); CREATE TABLE presentation_state(singleton INTEGER,generation INTEGER,order_generation INTEGER); INSERT INTO presentation_state VALUES(1,0,0); CREATE TABLE conversation_presentations(workspace_id TEXT,public_id TEXT,pin_ordinal INTEGER,PRIMARY KEY(workspace_id,public_id))",
	);
	db.exec(NAVIGATION_SCHEMA);
	const cycle = randomUUID();
	db.prepare("INSERT INTO navigation_state VALUES(1,?,0,0,?,'',NULL,'',NULL,NULL,NULL,1)").run(randomUUID(), cycle);
	const storage = new MemoryStorage();
	const durableId = await storage.mintId<ConversationId>();
	await storage.commit([{ type: "conversation", value: { id: durableId } }], context);
	const values = Array.from({ length: count }, (_, i) =>
		conversation(i % 2 ? "b" : "a", `c${String(i).padStart(4, "0")}`),
	);
	const ports: NavigationPorts = {
		nextWorkspace: (after) =>
			["a", "b"].filter((id) => id > after).map((workspaceId) => ({ workspaceId, name: workspaceId }))[0],
		prepareWorkspace: async () => true,
		nextConversation: (workspaceId, after) => {
			const index = values.findIndex((value) => value.workspaceId === workspaceId && value.conversationId > after);
			return index < 0 ? undefined : { conversation: values[index], ordinal: index };
		},
		read: (scope, operation) => {
			const value = values.find(
				(item) => item.workspaceId === scope.workspaceId && item.conversationId === scope.conversationId,
			);
			assert.ok(value);
			return operation(storage, {
				generation: "source",
				durableId,
				revision: value.revision,
				title: value.title,
				archived: value.archivedAt !== null,
			});
		},
		hasWorkspace: (workspaceId) => workspaceId === "a" || workspaceId === "b",
	};
	const projection = new NavigationProjection(db, "store", ports);
	const complete = async () => {
		for (let i = 0; i < count * 3 + 20; i++) {
			const status = await projection.refresh({});
			if (status.state === "ready") return status;
		}
		throw new Error("Projection did not complete");
	};
	return { db, ports, projection, values, complete, storage, durableId };
}
test("global coverage includes cold workspaces, stable source-order ties, archive filters and authoritative unloaded pins", async () => {
	const f = await fixture(180);
	try {
		assert.equal(f.projection.list({ view: { kind: "recent" } }).coverage.state, "building");
		await f.complete();
		const insert = f.db.prepare("INSERT INTO conversation_presentations VALUES(?,?,?)");
		for (let i = 0; i < 132; i++) insert.run(f.values[i].workspaceId, f.values[i].conversationId, i + 1);
		f.db.exec("UPDATE presentation_state SET generation=132,order_generation=132");
		const seen: Conversation[] = [];
		let cursor: string | undefined;
		do {
			const page = f.projection.list({ view: { kind: "recent" }, ...(cursor ? { cursor } : {}) });
			parseResult("listSidebarConversations", page);
			seen.push(...page.items.map((row) => row.conversation));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		assert.equal(seen.length, 48);
		assert.ok(seen.some((c) => c.workspaceId === "a") && seen.some((c) => c.workspaceId === "b"));
		assert.deepEqual(
			seen.filter((c) => c.workspaceId === "a").map((c) => c.conversationId),
			f.values
				.slice(132)
				.filter((c) => c.workspaceId === "a")
				.map((c) => c.conversationId),
		);
		const target = f.values[178];
		target.archivedAt = 100;
		target.revision++;
		f.projection.invalidate();
		await f.complete();
		assert.equal(
			f.projection.list({ view: { kind: "workspace", workspaceId: "a" }, filter: "archived" }).items[0]?.conversation
				.conversationId,
			target.conversationId,
		);
		const all = f.projection.list({ view: { kind: "recent" }, filter: "all" });
		assert.equal(
			all.items.length +
				(all.nextCursor
					? f.projection.list({ view: { kind: "recent" }, filter: "all", cursor: all.nextCursor }).items.length
					: 0),
			48,
		);
	} finally {
		await f.projection.close();
		f.db.close();
		await f.storage.close(context);
	}
});
test("bounded excluded-candidate pages may be empty with continuation", async () => {
	const f = await fixture(300);
	try {
		await f.complete();
		for (const value of f.values)
			f.db
				.prepare("INSERT INTO conversation_presentations VALUES(?,?,1)")
				.run(value.workspaceId, value.conversationId);
		const page = f.projection.list({ view: { kind: "recent" } });
		assert.deepEqual(page.items, []);
		assert.ok(page.nextCursor);
		const second = f.projection.list({ view: { kind: "recent" }, cursor: page.nextCursor });
		assert.deepEqual(second.items, []);
		assert.ok(second.nextCursor);
		const last = f.projection.list({ view: { kind: "recent" }, cursor: second.nextCursor });
		assert.equal(last.nextCursor, null);
	} finally {
		await f.projection.close();
		f.db.close();
		await f.storage.close(context);
	}
});
test("cursors bind query/store/generation/membership, but pure order changes do not invalidate", async () => {
	const f = await fixture(120);
	try {
		await f.complete();
		const first = f.projection.list({ view: { kind: "recent" } });
		assert.ok(first.nextCursor);
		f.db.exec("UPDATE presentation_state SET order_generation=1");
		assert.equal(f.projection.list({ view: { kind: "recent" }, cursor: first.nextCursor }).items.length, 50);
		for (const input of [
			{ view: { kind: "workspace" as const, workspaceId: "a" }, cursor: first.nextCursor },
			{ view: { kind: "recent" as const }, filter: "all" as const, cursor: first.nextCursor },
			{
				view: { kind: "recent" as const },
				cursor: Buffer.from(
					JSON.stringify({
						...JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()),
						storeId: "foreign",
					}),
				).toString("base64url"),
			},
			{
				view: { kind: "recent" as const },
				cursor: Buffer.from(
					JSON.stringify({ ...JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()), extra: 1 }),
				).toString("base64url"),
			},
		])
			assert.throws(() => f.projection.list(input), { code: "INVALID_REQUEST" });
		f.db.exec("UPDATE presentation_state SET generation=1");
		assert.throws(() => f.projection.list({ view: { kind: "recent" }, cursor: first.nextCursor ?? undefined }), {
			code: "CURSOR_STALE",
		});
		f.projection.invalidate();
		const stale = f.projection.list({ view: { kind: "recent" } });
		assert.equal(stale.coverage.state, "refreshing");
		assert.equal(stale.items.length, 50);
	} finally {
		await f.projection.close();
		f.db.close();
		await f.storage.close(context);
	}
});
test("continuous activity cannot starve first publication; refresh pages stay coherent until atomic replacement", async () => {
	const f = await fixture(120);
	try {
		let first: ReturnType<NavigationProjection["list"]> | undefined;
		for (let i = 0; i < 180; i++) {
			f.projection.invalidate();
			await f.projection.refresh({});
			const page = f.projection.list({ view: { kind: "recent" } });
			if (page.items.length) {
				first = page;
				break;
			}
		}
		assert.ok(first);
		assert.equal(first.coverage.state, "refreshing");
		assert.ok(first.nextCursor);
		const originalGeneration = first.coverage.generation;
		const second = f.projection.list({ view: { kind: "recent" }, cursor: first.nextCursor });
		assert.equal(second.coverage.generation, originalGeneration);
		assert.equal(second.items.length, 50);
		f.values[0].title = "New title";
		f.values[0].revision++;
		f.values.splice(1, 1);
		for (let i = 0; i < 200; i++) {
			await f.projection.refresh({});
			const page = f.projection.list({ view: { kind: "recent" } });
			if (page.coverage.generation !== originalGeneration) break;
			assert.equal(page.items[0].conversation.title, first.items[0].conversation.title);
			if (i === 199) assert.fail("Replacement not published");
		}
		assert.throws(() => f.projection.list({ view: { kind: "recent" }, cursor: first.nextCursor ?? undefined }), {
			code: "CURSOR_STALE",
		});
		const current = f.projection.list({ view: { kind: "recent" } });
		assert.equal(current.items[0].conversation.title, "New title");
		for (let i = 0; i < 5; i++) await f.projection.refresh({});
		assert.ok(Number(f.db.prepare("SELECT count(DISTINCT cycle) AS n FROM navigation_sources").get()?.n) <= 2);
		f.projection.start();
		assert.equal(f.projection.list({ view: { kind: "recent" } }).coverage.state, "building");
	} finally {
		await f.projection.close();
		f.db.close();
		await f.storage.close(context);
	}
});
test("committed metadata atomically replaces published filters without changing activity; unknown metadata fails closed", async () => {
	const f = await fixture(120);
	try {
		await f.complete();
		const first = f.projection.list({ view: { kind: "recent" } });
		const target = f.values[0];
		f.db
			.prepare("INSERT INTO conversation_presentations VALUES(?,?,1)")
			.run(target.workspaceId, target.conversationId);
		target.archivedAt = 100;
		target.revision++;
		f.projection.invalidate({
			conversations: [{ conversation: target, generation: "source", durableId: f.durableId }],
			reset: false,
		});
		const archived = f.projection.list({ view: { kind: "recent" }, filter: "archived" });
		assert.equal(archived.coverage.state, "refreshing");
		assert.notEqual(archived.coverage.generation, first.coverage.generation);
		assert.equal(archived.items[0]?.conversation.conversationId, target.conversationId);
		assert.equal(archived.items[0]?.recencyAt, first.items[0]?.recencyAt);
		assert.throws(() => f.projection.list({ view: { kind: "recent" }, cursor: first.nextCursor ?? undefined }), {
			code: "CURSOR_STALE",
		});
		f.projection.invalidate({ conversations: [], reset: true });
		const missing = f.projection.list({ view: { kind: "recent" } });
		assert.equal(missing.coverage.state, "building");
		assert.deepEqual(missing.items, []);
	} finally {
		await f.projection.close();
		f.db.close();
		await f.storage.close(context);
	}
});
test("replacement source identity cannot patch or retain an old same-Scope publication", async () => {
	const f = await fixture(2);
	try {
		await f.complete();
		const target = f.values[0];
		const old = f.projection.list({ view: { kind: "recent" } });
		f.projection.invalidate({
			conversations: [
				{ conversation: { ...target, title: "Replacement" }, generation: "replacement", durableId: f.durableId },
			],
			reset: false,
		});
		assert.equal(f.projection.list({ view: { kind: "recent" } }).coverage.state, "building");
		assert.equal(
			JSON.parse(
				String(
					f.db
						.prepare("SELECT conversation FROM navigation_sources WHERE public_id=? LIMIT 1")
						.get(target.conversationId)?.conversation,
				),
			).title,
			target.title,
		);
		await f.complete();
		assert.notEqual(f.projection.list({ view: { kind: "recent" } }).coverage.generation, old.coverage.generation);
		const read = f.ports.read;
		f.ports.read = (scope, operation) =>
			read(scope, (storage, source) => operation(storage, { ...source, generation: "replacement" }));
		await assert.rejects(f.projection.refresh({}), { code: "CURSOR_STALE" });
		const discovered = f.projection.list({ view: { kind: "recent" } });
		assert.equal(discovered.coverage.state, "building");
		assert.deepEqual(discovered.items, []);
		await f.complete();
		assert.equal(f.projection.list({ view: { kind: "recent" } }).coverage.state, "ready");
	} finally {
		await f.projection.close();
		f.db.close();
		await f.storage.close(context);
	}
});
test("mid-workspace replacement discards the entire staged old-source prefix", async () => {
	const f = await fixture(4);
	try {
		await f.projection.refresh({});
		const oldCycle = f.db.prepare("SELECT cycle FROM navigation_state").get()?.cycle;
		assert.equal(typeof oldCycle, "string");
		const read = f.ports.read;
		f.ports.read = (scope, operation) =>
			read(scope, (storage, source) => operation(storage, { ...source, generation: "new" }));
		await assert.rejects(f.projection.refresh({}), { code: "CURSOR_STALE" });
		assert.equal(f.projection.list({ view: { kind: "recent" } }).coverage.state, "building");
		await f.complete();
		assert.equal(
			f.db.prepare("SELECT count(*) AS n FROM navigation_sources WHERE cycle=?").get(String(oldCycle))?.n,
			0,
		);
		const rows = f.db
			.prepare(
				"SELECT source_generation FROM navigation_sources WHERE cycle=(SELECT cycle FROM navigation_publication)",
			)
			.all();
		assert.equal(rows.length, 4);
		assert.ok(rows.every((row) => JSON.parse(String(row.source_generation))[0] === "new"));
	} finally {
		await f.projection.close();
		f.db.close();
		await f.storage.close(context);
	}
});
test("cancelled preparation commits no progress; inventory changes during await cannot publish complete coverage", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<boolean>();
	f.ports.prepareWorkspace = async () => {
		entered.resolve();
		return release.promise;
	};
	try {
		const abort = new AbortController(),
			before = f.db.prepare("SELECT revision FROM navigation_state").get()?.revision;
		const pending = f.projection.refresh({}, abort.signal);
		await entered.promise;
		abort.abort();
		release.resolve(true);
		await assert.rejects(pending, { code: "CLOSED" });
		assert.equal(f.db.prepare("SELECT revision FROM navigation_state").get()?.revision, before);
		f.ports.prepareWorkspace = async () => {
			f.projection.inventoryChanged();
			return true;
		};
		await assert.rejects(f.projection.refresh({}), { code: "CURSOR_STALE" });
		assert.notEqual(f.projection.list({ view: { kind: "recent" } }).coverage.state, "ready");
	} finally {
		await f.projection.close();
		f.db.close();
		await f.storage.close(context);
	}
});
test("new protocol strictly rejects malformed view and preserves archived browsing", () => {
	assert.equal(
		parseRequest({
			version: PROTOCOL_VERSION,
			method: "listSidebarConversations",
			params: { view: { kind: "recent" }, filter: "archived" },
		}).method,
		"listSidebarConversations",
	);
	for (const view of [
		{ kind: "recent", workspaceId: "a" },
		{ kind: "workspace" },
		{ kind: "project" },
		{ kind: "project", projectId: "a", workspaceId: "a" },
	])
		assert.throws(
			() => parseRequest({ version: PROTOCOL_VERSION, method: "listSidebarConversations", params: { view } }),
			{ code: "INVALID_REQUEST" },
		);
});
