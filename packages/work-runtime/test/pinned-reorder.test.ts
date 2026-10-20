import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	type Conversation,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type Scope,
} from "../src/contracts.ts";
import {
	ConversationPresentations,
	PRESENTATION_ORDER_SCHEMA,
	PRESENTATION_SCHEMA,
	validatePresentationStore,
} from "../src/conversation-presentation.ts";
import { backupStore, restoreStore, verifyBackup } from "../src/maintenance/index.ts";
import { inspectCatalog } from "../src/maintenance/sqlite.ts";
import { openTestRuntime } from "../src/testing.ts";

const scope = (value: Scope): Scope => ({
	workspaceId: value.workspaceId,
	conversationId: value.conversationId,
});

function fixture(count = 54) {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY,ready INTEGER NOT NULL); INSERT INTO workspaces VALUES ('one',1),('two',1)",
	);
	db.exec(PRESENTATION_SCHEMA);
	db.exec("INSERT INTO presentation_state VALUES (1,0,0)");
	db.exec(PRESENTATION_ORDER_SCHEMA);
	const conversations: Conversation[] = Array.from({ length: count }, (_, index) => ({
		workspaceId: index % 2 ? "two" : "one",
		conversationId: `conversation-${index}`,
		title: `Conversation ${index}`,
		revision: 1,
		createdAt: null,
		archivedAt: null,
	}));
	let beforeRead: (() => Promise<void>) | undefined;
	let afterRead: (() => Promise<void>) | undefined;
	const presentations = new ConversationPresentations(
		db,
		"store",
		async (target) => {
			await beforeRead?.();
			const conversation = conversations.find(
				(item) => item.workspaceId === target.workspaceId && item.conversationId === target.conversationId,
			);
			assert.ok(conversation);
			return { ...conversation };
		},
		async (point) => {
			if (point === "after_read") await afterRead?.();
		},
	);
	return {
		db,
		conversations,
		presentations,
		holdRead(value: typeof beforeRead) {
			beforeRead = value;
		},
		holdMutation(value: typeof afterRead) {
			afterRead = value;
		},
		async pinAll() {
			for (const [index, conversation] of conversations.entries())
				await presentations.set({
					...scope(conversation),
					requestId: `pin-${index}`,
					expectedPresentationRevision: 0,
					pinned: true,
				});
		},
		order() {
			return db
				.prepare(
					"SELECT public_id FROM conversation_presentations WHERE pin_ordinal IS NOT NULL ORDER BY pin_ordinal",
				)
				.all()
				.map((row) => row.public_id);
		},
		reorder(moved: number, before: number | null, generation: number, requestId = "move") {
			return presentations.reorder({
				requestId,
				moved: scope(conversations[moved]),
				before: before === null ? null : scope(conversations[before]),
				expectedOrderGeneration: generation,
			});
		},
	};
}

test("reorder protocol binds both exact scopes, generation, result and permanent command kind", () => {
	const input: Params<"reorderPinnedConversation"> = {
		requestId: "move",
		moved: { workspaceId: "one", conversationId: "first" },
		before: { workspaceId: "two", conversationId: "second" },
		expectedOrderGeneration: 2,
	};
	const parse = (params: unknown) =>
		parseRequest({ version: PROTOCOL_VERSION, method: "reorderPinnedConversation", params });
	assert.deepEqual(parse(input).params, input);
	for (const patch of [
		{ before: undefined },
		{ before: input.moved },
		{ moved: { ...input.moved, projectId: "forbidden" } },
		{ before: { ...input.before, pinned: true } },
		{ expectedOrderGeneration: -1 },
		{ expectedOrderGeneration: 1.5 },
		{ expectedOrderGeneration: Number.MAX_SAFE_INTEGER + 1 },
		{ requestId: "invalid!" },
		{ orderedIds: ["first", "second"] },
	])
		assert.throws(() => parse({ ...input, ...patch }), { code: "INVALID_REQUEST" });
	assert.deepEqual(parse({ ...input, before: null }).params, { ...input, before: null });
	const receipt = { method: "reorderPinnedConversation", params: input, result: { orderGeneration: 3 } };
	assert.deepEqual(parseResult("getPresentationCommandResult", receipt), receipt);
	for (const orderGeneration of [1, 4, -1, 2.1])
		assert.throws(() => parseResult("getPresentationCommandResult", { ...receipt, result: { orderGeneration } }));
	for (const patch of [
		{ nextPinnedScope: input.moved, nextCursor: null },
		{ nextPinnedScope: null, nextCursor: "cursor" },
		{ orderGeneration: undefined },
	])
		assert.throws(() =>
			parseResult("listPinnedConversations", {
				items: [],
				nextCursor: null,
				nextPinnedScope: null,
				orderGeneration: 2,
				...patch,
			}),
		);
});

test("partial-page reorder preserves every unloaded pin, revisions, gaps and immutable receipts", async () => {
	const f = fixture();
	try {
		await f.pinAll();
		await f.presentations.set({
			...scope(f.conversations[10]),
			requestId: "remove-gap",
			expectedPresentationRevision: 1,
			pinned: false,
		});
		const baseline = f.db
			.prepare(
				"SELECT workspace_id,public_id,revision,pin_conversation_revision,archived_revision FROM conversation_presentations ORDER BY public_id",
			)
			.all();
		const first = await f.presentations.list({});
		assert.equal(first.orderGeneration, 55);
		assert.equal(first.items.length, 50);
		assert.deepEqual(first.nextPinnedScope, scope(f.conversations[51]));
		assert.ok(first.nextCursor);
		const forward = await f.reorder(0, 51, first.orderGeneration);
		assert.deepEqual(forward, { orderGeneration: 56 });
		await assert.rejects(f.presentations.list({ cursor: first.nextCursor }), { code: "CURSOR_STALE" });
		const expected = f.conversations.map((item) => item.conversationId).filter((id) => id !== "conversation-10");
		expected.shift();
		expected.splice(expected.indexOf("conversation-51"), 0, "conversation-0");
		assert.deepEqual(f.order(), expected);
		assert.deepEqual(
			f.db
				.prepare(
					"SELECT workspace_id,public_id,revision,pin_conversation_revision,archived_revision FROM conversation_presentations ORDER BY public_id",
				)
				.all(),
			baseline,
		);
		await f.reorder(53, 1, 56, "backward");
		assert.equal(f.order()[0], "conversation-53");
		await f.reorder(53, null, 57, "complete-end");
		assert.equal(f.order().at(-1), "conversation-53");
		assert.deepEqual(await f.reorder(0, 51, 55), forward);
		assert.equal(f.order().at(-1), "conversation-53");
		assert.deepEqual(await f.reorder(53, null, 58, "noop"), { orderGeneration: 58 });
		assert.equal(f.presentations.command("noop")?.method, "reorderPinnedConversation");
		await assert.rejects(f.reorder(0, null, 55), { code: "IDEMPOTENCY_CONFLICT" });
		await assert.rejects(f.reorder(0, null, 55, "stale"), { code: "IDEMPOTENCY_CONFLICT" });
		assert.equal(f.presentations.command("stale"), null);
		await assert.rejects(f.reorder(0, null, 58, "pin-0"), { code: "IDEMPOTENCY_CONFLICT" });
		await assert.rejects(
			f.presentations.set({
				...scope(f.conversations[0]),
				requestId: "move",
				pinned: false,
				expectedPresentationRevision: 1,
			}),
			{ code: "IDEMPOTENCY_CONFLICT" },
		);
		validatePresentationStore(f.db, true);
	} finally {
		f.db.close();
	}
});

test("receipt insertion failure rolls back the complete rotation and order generation", async () => {
	const f = fixture(5);
	try {
		await f.pinAll();
		const before = f.order();
		f.db.exec(
			"CREATE TRIGGER deny_reorder BEFORE INSERT ON presentation_commands BEGIN SELECT RAISE(ABORT,'journal failure'); END",
		);
		await assert.rejects(f.reorder(4, 0, 5), /journal failure/);
		assert.deepEqual(f.order(), before);
		assert.equal(f.db.prepare("SELECT order_generation FROM presentation_state").get()?.order_generation, 5);
		assert.equal(f.presentations.command("move"), null);
		f.db.exec("DROP TRIGGER deny_reorder");
		assert.deepEqual(await f.reorder(4, 0, 5), { orderGeneration: 6 });
	} finally {
		f.db.close();
	}
});

test("first-page pure reorder race is stale even though membership revisions are unchanged", async () => {
	const f = fixture();
	try {
		await f.pinAll();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.holdRead(async () => {
			f.holdRead(undefined);
			entered.resolve();
			await release.promise;
		});
		const listing = f.presentations.list({});
		const rejected = assert.rejects(listing, { code: "CURSOR_STALE" });
		await entered.promise;
		await f.reorder(53, 0, 54);
		release.resolve();
		await rejected;
		assert.equal((await f.presentations.list({})).items[0].conversation.conversationId, "conversation-53");
	} finally {
		f.db.close();
	}
});

test("first-page archive cleanup returns a current canonical successor and generation", async () => {
	const f = fixture();
	try {
		await f.pinAll();
		for (const index of [0, 50, 51]) {
			f.conversations[index].archivedAt = 1;
			f.conversations[index].revision = 2;
		}
		const page = await f.presentations.list({});
		assert.equal(page.items.length, 50);
		assert.equal(page.orderGeneration, 57);
		assert.deepEqual(page.nextPinnedScope, scope(f.conversations[53]));
		assert.ok(page.nextCursor);
		const last = await f.presentations.list({ cursor: page.nextCursor });
		assert.deepEqual(
			last.items.map((item) => item.conversation),
			[f.conversations[53]],
		);
		assert.equal(last.nextPinnedScope, null);
		validatePresentationStore(f.db, true);
	} finally {
		f.db.close();
	}
});

for (const target of ["source", "anchor"] as const) {
	test(`reorder fences ${target} unpin and Archive/Restore between read and atomic commit`, async () => {
		for (const action of ["unpin", "archive"] as const) {
			const f = fixture(3);
			try {
				await f.pinAll();
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				f.holdMutation(async () => {
					f.holdMutation(undefined);
					entered.resolve();
					await release.promise;
				});
				const moved = f.reorder(2, 0, 3);
				const rejection = assert.rejects(moved, {
					code: action === "unpin" ? "IDEMPOTENCY_CONFLICT" : "CONVERSATION_ARCHIVED",
				});
				await entered.promise;
				const conversation = f.conversations[target === "source" ? 2 : 0];
				if (action === "unpin")
					await f.presentations.set({
						...scope(conversation),
						requestId: "unpin",
						expectedPresentationRevision: 1,
						pinned: false,
					});
				else {
					f.presentations.recordArchive({ ...conversation, archivedAt: 1, revision: 2 });
					conversation.revision = 3;
				}
				release.resolve();
				await rejection;
				assert.equal(f.presentations.command("move"), null);
				validatePresentationStore(f.db, true);
			} finally {
				f.db.close();
			}
		}
	});
}

test("real runtime lost reorder reply, concurrent duplicates, restart and schema9 backup retain first receipt", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "hipi-reorder-replay-")));
	const root = join(directory, "store");
	let loseReply = false;
	let runtime = await openTestRuntime(root, {
		presentationFailpoint: (point) => {
			if (loseReply && point === "after_commit") throw new Error("lost reorder reply");
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversations: Conversation[] = [];
		for (let index = 0; index < 3; index++) {
			const conversation = await runtime.call("createConversation", {
				workspaceId: "work",
				requestId: `create-${index}`,
				title: `${index}`,
			});
			conversations.push(conversation);
			await runtime.call("setConversationPinned", {
				...scope(conversation),
				requestId: `pin-${index}`,
				expectedPresentationRevision: 0,
				pinned: true,
			});
		}
		const input: Params<"reorderPinnedConversation"> = {
			requestId: "reorder",
			moved: scope(conversations[2]),
			before: scope(conversations[0]),
			expectedOrderGeneration: 3,
		};
		loseReply = true;
		await assert.rejects(runtime.call("reorderPinnedConversation", input), /lost reorder reply/);
		const receipt = await runtime.call("getPresentationCommandResult", { requestId: "reorder" });
		assert.deepEqual(receipt, { method: "reorderPinnedConversation", params: input, result: { orderGeneration: 4 } });
		assert.deepEqual(
			await Promise.all(Array.from({ length: 8 }, () => runtime.call("reorderPinnedConversation", input))),
			Array.from({ length: 8 }, () => ({ orderGeneration: 4 })),
		);
		loseReply = false;
		await runtime.call("reorderPinnedConversation", {
			...input,
			requestId: "later",
			before: null,
			expectedOrderGeneration: 4,
		});
		await runtime.close();
		runtime = await openTestRuntime(root);
		assert.deepEqual(await runtime.call("getPresentationCommandResult", { requestId: "reorder" }), receipt);
		assert.deepEqual(await runtime.call("reorderPinnedConversation", input), { orderGeneration: 4 });
		assert.deepEqual(
			(await runtime.call("listPinnedConversations", {})).items.map((item) => item.conversation),
			conversations,
		);
		await runtime.close();
		assert.equal(inspectCatalog(join(root, "catalog.sqlite")).catalogSchema, 9);
		const backup = await backupStore({ source: root, destination: join(directory, "backup") });
		assert.equal(backup.manifest.catalogSchema, 9);
		assert.equal((await verifyBackup({ directory: backup.directory })).manifest.catalogSchema, 9);
		const saved = new DatabaseSync(join(backup.directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.deepEqual(
				saved
					.prepare("SELECT public_id FROM conversation_presentations ORDER BY pin_ordinal")
					.all()
					.map((row) => row.public_id),
				conversations.map((conversation) => conversation.conversationId),
			);
			const result = saved
				.prepare("SELECT result FROM presentation_commands WHERE request_id='reorder'")
				.get()?.result;
			assert.equal(typeof result, "string");
			assert.deepEqual(parseResult("getPresentationCommandResult", JSON.parse(String(result))), receipt);
			assert.equal(saved.prepare("SELECT order_generation FROM presentation_state").get()?.order_generation, 5);
		} finally {
			saved.close();
		}
		const restored = await restoreStore({ source: backup.directory, destination: join(directory, "archive") });
		await assert.rejects(openTestRuntime(restored.directory), { code: "STORE_MISMATCH" });
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
