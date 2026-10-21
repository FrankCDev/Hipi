import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	ConversationPresentations,
	PRESENTATION_ORDER_SCHEMA,
	PRESENTATION_SCHEMA,
} from "../src/conversation-presentation.ts";
import { openTestRuntime } from "../src/testing.ts";

test("mixed pins and projects restore previous windows with canonical forward successors", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-bidirectional-catalog-"));
	const runtime = await openTestRuntime(directory);
	try {
		for (let index = 0; index < 53; index++) {
			const project = await runtime.call("createProject", { requestId: `p-${index}`, name: `Project ${index}` });
			await runtime.call("setProjectPinned", {
				requestId: `pin-p-${index}`,
				projectId: project.projectId,
				expectedPresentationRevision: 0,
				pinned: true,
			});
			const value = await runtime.call("createProjectConversation", {
				requestId: `c-${index}`,
				projectId: project.projectId,
				title: `Chat ${index}`,
			});
			await runtime.call("setConversationPinned", {
				requestId: `pin-c-${index}`,
				workspaceId: value.conversation.workspaceId,
				conversationId: value.conversation.conversationId,
				expectedPresentationRevision: 0,
				pinned: true,
			});
		}
		const first = await runtime.call("listSidebarPins", {});
		assert.equal(first.items.length, 50);
		assert.equal(first.previousCursor, null);
		assert.ok(first.nextCursor);
		const second = await runtime.call("listSidebarPins", { cursor: first.nextCursor });
		assert.ok(second.previousCursor);
		const back = await runtime.call("listSidebarPins", { cursor: second.previousCursor });
		assert.deepEqual(back.items, first.items);
		assert.deepEqual(back.nextPinKey, first.nextPinKey);
		assert.equal(back.previousCursor, null);
		assert.ok(back.nextCursor);
		assert.deepEqual((await runtime.call("listSidebarPins", { cursor: back.nextCursor })).items, second.items);
		const projects = await runtime.call("listProjects", {});
		assert.ok(projects.nextCursor);
		const more = await runtime.call("listProjects", { cursor: projects.nextCursor });
		assert.ok(more.previousCursor);
		const restored = await runtime.call("listProjects", { cursor: more.previousCursor });
		assert.deepEqual(restored.items, projects.items);
		assert.equal(restored.previousCursor, null);
		const moved = second.items[0];
		assert.ok(moved);
		await runtime.call("reorderSidebarPin", {
			requestId: "reorder",
			expectedOrderRevision: second.orderRevision,
			moved:
				moved.kind === "project"
					? { kind: "project", projectId: moved.project.projectId }
					: {
							kind: "conversation",
							workspaceId: moved.conversation.workspaceId,
							conversationId: moved.conversation.conversationId,
						},
			before: null,
		});
		await assert.rejects(runtime.call("listSidebarPins", { cursor: second.previousCursor }), {
			code: "CURSOR_STALE",
		});
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("interrupted archive cleanup is bounded and retry never reports unread pins as a completed empty list", async () => {
	const db = new DatabaseSync(":memory:");
	db.exec(PRESENTATION_SCHEMA);
	db.exec("INSERT INTO presentation_state VALUES (1,300,300)");
	db.exec(PRESENTATION_ORDER_SCHEMA);
	const insert = db.prepare("INSERT INTO conversation_presentations VALUES ('work',?,1,?,1,0)");
	for (let index = 1; index <= 300; index++) insert.run(`c${index}`, index);
	let reads = 0;
	const owner = new ConversationPresentations(db, "store", async (scope) => {
		reads++;
		return { ...scope, title: "Archived", revision: 2, createdAt: null, archivedAt: 1 };
	});
	try {
		await assert.rejects(owner.list({}), { code: "CAPACITY_EXCEEDED" });
		assert.equal(reads, 256);
		assert.equal(
			db.prepare("SELECT count(*) AS n FROM conversation_presentations WHERE pin_ordinal IS NOT NULL").get()?.n,
			44,
		);
		const page = await owner.list({});
		assert.deepEqual(page.items, []);
		assert.equal(page.nextCursor, null);
		assert.equal(page.previousCursor, null);
		assert.equal(reads, 300);
	} finally {
		db.close();
	}
});
