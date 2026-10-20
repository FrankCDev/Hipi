import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { DocumentId, JsonObject, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openRuntime } from "../../src/node.ts";
import { openTestRuntime } from "../../src/testing.ts";

async function put(storage: Storage, kind: string, value: JsonObject, key?: string) {
	const record = await storage.findDocument(
		{ kind, scope: { kind: "session" }, ...(key === undefined ? {} : { key }) },
		"current",
		context,
	);
	await storage.commit(
		[
			record
				? { type: "document.change", id: record.id, content: { kind: "base", version: 1, value } }
				: {
						type: "document.create",
						record: {
							id: await storage.mintId<DocumentId>(),
							kind,
							scope: { kind: "session" },
							...(key === undefined ? {} : { key }),
						},
						content: { kind: "base", version: 1, value },
					},
		],
		context,
	);
}

for (const observer of ["manual", "background"] as const)
	test(`unversioned legacy membership shrink remains browsable with ${observer} refresh and no Harness migration`, async (t) => {
		// Keep filesystem latency from deciding which refresh observes the replacement.
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const directory = await mkdtemp(join(tmpdir(), "hipi-navigation-legacy-"));
		let runtime = await openTestRuntime(directory);
		try {
			await runtime.call("createWorkspace", { workspaceId: "w", name: "W" });
			const a = await runtime.call("createConversation", { workspaceId: "w", requestId: "a", title: "A" });
			const b = await runtime.call("createConversation", { workspaceId: "w", requestId: "b", title: "B" });
			await runtime.call("listConversations", { workspaceId: "w" });
			await runtime.close();
			const path = join(directory, "w", "workspace.sqlite");
			const legacyRows: JsonObject[] = [];
			const storage = await openNodeSqliteStorage(path);
			try {
				for (const item of [a, b].sort((x, y) => x.conversationId.localeCompare(y.conversationId))) {
					const record = await storage.findDocument(
						{ kind: "hipi.conversation-metadata", key: item.conversationId, scope: { kind: "session" } },
						"current",
						context,
					);
					assert.ok(record);
					const doc = await storage.document(record.id, "current", context),
						value = doc?.value.value;
					assert.ok(value && typeof value === "object" && !Array.isArray(value));
					legacyRows.push({ publicId: item.conversationId, durableId: value.durableId, title: item.title });
				}
				await put(storage, "hipi.workspace-directory", {
					workspaceId: "w",
					name: "W",
					initialized: false,
					generation: "old",
				});
				await put(storage, "hipi.workspace", {
					workspaceId: "w",
					name: "W",
					conversations: legacyRows,
				});
			} finally {
				await storage.close(context);
			}
			runtime = await openTestRuntime(directory);
			const before = await runtime.call("refreshSidebarProjection", {});
			assert.ok(before.nextCursor);
			const replace = await openNodeSqliteStorage(path);
			try {
				await put(replace, "hipi.workspace", { workspaceId: "w", name: "W", conversations: [legacyRows[0]] });
			} finally {
				await replace.close(context);
			}
			if (observer === "background") {
				// Enqueue the real background refresh first. The following manual call
				// waits behind it, proving the scheduler already consumed CURSOR_STALE.
				t.mock.timers.tick(25);
				await runtime.call("refreshSidebarProjection", {});
			} else {
				await assert.rejects(runtime.call("refreshSidebarProjection", {}), { code: "CURSOR_STALE" });
			}
			await assert.rejects(runtime.call("refreshSidebarProjection", { cursor: before.nextCursor }), {
				code: "CURSOR_STALE",
			});
			for (let i = 0; i < 30; i++) {
				if ((await runtime.call("refreshSidebarProjection", {})).state === "ready") break;
				if (i === 29) assert.fail("Legacy reconciliation did not complete");
			}
			const page = await runtime.call("listSidebarConversations", { view: { kind: "recent" } });
			assert.equal(page.items.length, 1);
			assert.equal(page.items[0].conversation.conversationId, legacyRows[0].publicId);
			assert.equal(page.items[0].recencyAt, null);
			assert.equal(page.items[0].activityBasis, "unknown");
			await runtime.close();
			const verify = await openNodeSqliteStorage(path);
			try {
				const record = await verify.findDocument(
					{ kind: "hipi.workspace-directory", scope: { kind: "session" } },
					"current",
					context,
				);
				assert.ok(record);
				assert.deepEqual((await verify.document(record.id, "current", context))?.value, {
					workspaceId: "w",
					name: "W",
					initialized: false,
					generation: "old",
				});
				const membership = await verify.findDocument(
					{ kind: "hipi.workspace", scope: { kind: "session" } },
					"current",
					context,
				);
				assert.ok(membership);
				assert.deepEqual((await verify.document(membership.id, "current", context))?.value, {
					workspaceId: "w",
					name: "W",
					conversations: [legacyRows[0]],
				});
			} finally {
				await verify.close(context);
			}
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

for (const survivors of [0, 1])
	for (const observer of ["manual", "background"] as const)
		test(`versioned replacement removing next cached row restarts to ${survivors} survivors with ${observer} refresh`, async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const directory = await mkdtemp(join(tmpdir(), "hipi-navigation-replaced-"));
			let runtime = await openTestRuntime(directory);
			try {
				await runtime.call("createWorkspace", { workspaceId: "w", name: "W" });
				const rows = [
					await runtime.call("createConversation", { workspaceId: "w", requestId: "a", title: "A" }),
					await runtime.call("createConversation", { workspaceId: "w", requestId: "b", title: "B" }),
				].sort((a, b) => a.conversationId.localeCompare(b.conversationId));
				await runtime.close();
				runtime = await openTestRuntime(directory);
				const before = await runtime.call("refreshSidebarProjection", {});
				assert.ok(before.nextCursor);
				const storage = await openNodeSqliteStorage(join(directory, "w", "workspace.sqlite"));
				try {
					await put(storage, "hipi.workspace-directory", {
						workspaceId: "w",
						name: "W",
						initialized: true,
						generation: "replacement",
						nextOrdinal: survivors,
						changeSeq: survivors,
						activeCount: survivors,
					});
					await put(storage, "hipi.conversation-metadata", {}, rows[1].conversationId);
					if (survivors) {
						await put(storage, "hipi.directory-change", { publicId: rows[0].conversationId, revision: 1 }, "1");
						const record = await storage.findDocument(
							{ kind: "hipi.conversation-metadata", key: rows[0].conversationId, scope: { kind: "session" } },
							"current",
							context,
						);
						assert.ok(record);
						const value = (await storage.document(record.id, "current", context))?.value.value;
						assert.ok(value && typeof value === "object" && !Array.isArray(value));
						await put(
							storage,
							"hipi.conversation-metadata",
							{ value: { ...value, ordinal: 0 } },
							rows[0].conversationId,
						);
					}
				} finally {
					await storage.close(context);
				}
				if (observer === "background") {
					// Enqueue the real background refresh first. The following manual call
					// waits behind it, proving the scheduler already consumed CURSOR_STALE.
					t.mock.timers.tick(25);
					await runtime.call("refreshSidebarProjection", {});
				} else {
					await assert.rejects(runtime.call("refreshSidebarProjection", {}), { code: "CURSOR_STALE" });
				}
				await assert.rejects(runtime.call("refreshSidebarProjection", { cursor: before.nextCursor }), {
					code: "CURSOR_STALE",
				});
				for (let i = 0; i < 30; i++) {
					if ((await runtime.call("refreshSidebarProjection", {})).state === "ready") break;
					if (i === 29) assert.fail("Replacement did not complete");
				}
				const page = await runtime.call("listSidebarConversations", { view: { kind: "recent" } });
				assert.equal(page.coverage.state, "ready");
				assert.equal(page.items.length, survivors);
				if (survivors) assert.equal(page.items[0].conversation.conversationId, rows[0].conversationId);
				await runtime.close();
				const verify = await openNodeSqliteStorage(join(directory, "w", "workspace.sqlite"));
				try {
					const record = await verify.findDocument(
						{ kind: "hipi.workspace-directory", scope: { kind: "session" } },
						"current",
						context,
					);
					assert.ok(record);
					assert.deepEqual((await verify.document(record.id, "current", context))?.value, {
						workspaceId: "w",
						name: "W",
						initialized: true,
						generation: "replacement",
						nextOrdinal: survivors,
						changeSeq: survivors,
						activeCount: survivors,
					});
				} finally {
					await verify.close(context);
				}
			} finally {
				await runtime.close();
				await rm(directory, { recursive: true, force: true });
			}
		});
test("cold global navigation traverses beyond live workspace limit without Harness/model activation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-navigation-cold-"));
	let runtime = await openTestRuntime(directory, {
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("Accepted but paused");
		},
	});
	try {
		const original = [];
		for (let i = 0; i < 20; i++) {
			const workspaceId = `w${String(i).padStart(2, "0")}`;
			await runtime.call("createWorkspace", { workspaceId, name: workspaceId });
			original.push(
				await runtime.call("createConversation", {
					workspaceId,
					requestId: `create${i}`,
					title: `Conversation ${i}`,
				}),
			);
		}
		const pending = original[19];
		await assert.rejects(
			runtime.call("submit", {
				workspaceId: pending.workspaceId,
				conversationId: pending.conversationId,
				requestId: "accepted",
				text: "Do not resume from sidebar",
			}),
			/Accepted but paused/,
		);
		await runtime.close();
		const faux = fauxProvider(),
			models = createModels();
		models.setProvider(faux.provider);
		runtime = await openRuntime(directory, { models, model: { provider: "faux", modelId: "faux-1" }, resume: true });
		const initial = await runtime.call("listSidebarConversations", { view: { kind: "recent" } });
		assert.notEqual(initial.coverage.state, "ready");
		for (let i = 0; i < 200; i++) {
			const status = await runtime.call("refreshSidebarProjection", {});
			if (status.state === "ready") break;
			if (i === 199) assert.fail("Cold projection did not complete");
		}
		const page = await runtime.call("listSidebarConversations", { view: { kind: "recent" } });
		assert.equal(page.coverage.state, "ready");
		assert.equal(page.items.length, 20);
		assert.equal(page.items[0].conversation.conversationId, pending.conversationId);
		assert.equal(page.items[0].activityBasis, "accepted");
		assert.equal(faux.state.callCount, 0);
		const pin = original[0];
		await runtime.call("setConversationPinned", {
			workspaceId: pin.workspaceId,
			conversationId: pin.conversationId,
			requestId: "pin",
			pinned: true,
			expectedPresentationRevision: 0,
		});
		assert.equal((await runtime.call("listSidebarConversations", { view: { kind: "recent" } })).items.length, 19);
		assert.equal(
			(await runtime.call("listSidebarConversations", { view: { kind: "workspace", workspaceId: pin.workspaceId } }))
				.items.length,
			0,
		);
		assert.equal(faux.state.callCount, 0);
		const beforeArchive = await runtime.call("listSidebarConversations", { view: { kind: "recent" } });
		await runtime.call("archiveConversation", {
			workspaceId: pin.workspaceId,
			conversationId: pin.conversationId,
			requestId: "archive",
			expectedRevision: pin.revision,
		});
		const archived = await runtime.call("listSidebarConversations", { view: { kind: "recent" }, filter: "archived" });
		assert.equal(archived.coverage.state, "refreshing");
		assert.notEqual(archived.coverage.generation, beforeArchive.coverage.generation);
		assert.equal(archived.items[0]?.conversation.conversationId, pin.conversationId);
		assert.equal(archived.items[0]?.recencyAt, pin.createdAt);
		await runtime.call("restoreConversation", {
			workspaceId: pin.workspaceId,
			conversationId: pin.conversationId,
			requestId: "restore",
			expectedRevision: pin.revision + 1,
		});
		const restored = await runtime.call("listSidebarConversations", { view: { kind: "recent" } });
		assert.equal(restored.items.length, 20);
		assert.equal(restored.coverage.state, "refreshing");
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
