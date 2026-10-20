import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { PinKey, Scope } from "../../src/contracts.ts";
import { openTestRuntime } from "../../src/testing.ts";

const scope = (c: Scope): Scope => ({ workspaceId: c.workspaceId, conversationId: c.conversationId });
const key = (
	item: { kind: "project"; project: { projectId: string } } | { kind: "conversation"; conversation: Scope },
): PinKey =>
	item.kind === "project"
		? { kind: "project", projectId: item.project.projectId }
		: { kind: "conversation", ...scope(item.conversation) };

test("production mixed ordering interleaves projects and conversations with atomic legacy compatibility", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-mixed-pins-"));
	let runtime = await openTestRuntime(directory);
	try {
		const a = await runtime.call("createProject", { requestId: "a", name: "A" }),
			b = await runtime.call("createProject", { requestId: "b", name: "B" });
		const c = (
			await runtime.call("createProjectConversation", { requestId: "c", projectId: a.projectId, title: "C" })
		).conversation;
		const d = (
			await runtime.call("createProjectConversation", { requestId: "d", projectId: b.projectId, title: "D" })
		).conversation;
		const ca: PinKey = { kind: "conversation", ...scope(c) },
			da: PinKey = { kind: "conversation", ...scope(d) },
			pa: PinKey = { kind: "project", projectId: a.projectId },
			pb: PinKey = { kind: "project", projectId: b.projectId };
		await runtime.call("setConversationPinned", {
			requestId: "pc",
			...scope(c),
			expectedPresentationRevision: 0,
			pinned: true,
		});
		await runtime.call("setProjectPinned", {
			requestId: "pa",
			projectId: a.projectId,
			expectedPresentationRevision: 0,
			pinned: true,
		});
		await runtime.call("setConversationPinned", {
			requestId: "pd",
			...scope(d),
			expectedPresentationRevision: 0,
			pinned: true,
		});
		await runtime.call("setProjectPinned", {
			requestId: "pb",
			projectId: b.projectId,
			expectedPresentationRevision: 0,
			pinned: true,
		});
		let page = await runtime.call("listSidebarPins", {});
		assert.deepEqual(page.items.map(key), [ca, pa, da, pb]);
		const input = { requestId: "move", moved: pb, before: ca, expectedOrderRevision: page.orderRevision };
		const moved = await runtime.call("reorderSidebarPin", input);
		assert.equal(moved.orderRevision, page.orderRevision + 1);
		page = await runtime.call("listSidebarPins", {});
		assert.deepEqual(page.items.map(key), [pb, ca, pa, da]);
		assert.deepEqual(
			(await runtime.call("listProjects", {})).items.map((x) => x.project.projectId),
			[b.projectId, a.projectId],
		);
		assert.deepEqual(
			(await runtime.call("listPinnedConversations", {})).items.map((x) => x.conversation.conversationId),
			[c.conversationId, d.conversationId],
		);
		const oldOrder = (await runtime.call("listPinnedConversations", {})).orderGeneration;
		await runtime.call("reorderSidebarPin", {
			requestId: "move2",
			moved: da,
			before: pb,
			expectedOrderRevision: page.orderRevision,
		});
		await assert.rejects(
			runtime.call("reorderPinnedConversation", {
				requestId: "stale",
				moved: scope(c),
				before: scope(d),
				expectedOrderGeneration: oldOrder,
			}),
			{ code: "IDEMPOTENCY_CONFLICT" },
		);
		const latest = (await runtime.call("listPinnedConversations", {})).orderGeneration;
		await runtime.call("reorderPinnedConversation", {
			requestId: "legacy",
			moved: scope(c),
			before: scope(d),
			expectedOrderGeneration: latest,
		});
		assert.deepEqual((await runtime.call("listSidebarPins", {})).items.map(key), [ca, da, pb, pa]);
		assert.deepEqual(await runtime.call("reorderSidebarPin", input), moved);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual((await runtime.call("listSidebarPins", {})).items.map(key), [ca, da, pb, pa]);
		assert.deepEqual(await runtime.call("reorderSidebarPin", input), moved);
		await runtime.call("archiveConversation", { requestId: "archive", ...scope(c), expectedRevision: c.revision });
		assert.deepEqual((await runtime.call("listSidebarPins", {})).items.map(key), [da, pb, pa]);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("mixed lost reply retains immutable receipt and different payload cannot reuse its identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-mixed-reply-"));
	let fail = false;
	let runtime = await openTestRuntime(directory, {
		sidebarPinFailpoint: (point) => {
			if (fail && point === "after_commit") throw new Error("lost reply");
		},
	});
	try {
		const a = await runtime.call("createProject", { requestId: "a", name: "A" }),
			b = await runtime.call("createProject", { requestId: "b", name: "B" });
		for (const [i, p] of [a, b].entries())
			await runtime.call("setProjectPinned", {
				requestId: `pin${i}`,
				projectId: p.projectId,
				expectedPresentationRevision: 0,
				pinned: true,
			});
		const page = await runtime.call("listSidebarPins", {}),
			input = {
				requestId: "move",
				moved: { kind: "project" as const, projectId: b.projectId },
				before: { kind: "project" as const, projectId: a.projectId },
				expectedOrderRevision: page.orderRevision,
			};
		fail = true;
		await assert.rejects(runtime.call("reorderSidebarPin", input), /lost reply/);
		const receipt = await runtime.call("getSidebarPinCommandResult", { requestId: "move" });
		assert.equal(receipt?.result.orderRevision, page.orderRevision + 1);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("reorderSidebarPin", input), receipt?.result);
		await assert.rejects(runtime.call("reorderSidebarPin", { ...input, before: null }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		assert.deepEqual((await runtime.call("listSidebarPins", {})).items.map(key), [input.moved, input.before]);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("mixed reorder admission loses to concurrent legacy unpin without resurrecting the anchor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-mixed-cas-")),
		entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const runtime = await openTestRuntime(directory, {
		sidebarPinFailpoint: async (point) => {
			if (point === "after_read") {
				entered.resolve();
				await release.promise;
			}
		},
	});
	try {
		const a = await runtime.call("createProject", { requestId: "a", name: "A" }),
			b = await runtime.call("createProject", { requestId: "b", name: "B" });
		for (const [i, p] of [a, b].entries())
			await runtime.call("setProjectPinned", {
				requestId: `pin${i}`,
				projectId: p.projectId,
				expectedPresentationRevision: 0,
				pinned: true,
			});
		const page = await runtime.call("listSidebarPins", {});
		const operation = runtime.call("reorderSidebarPin", {
			requestId: "move",
			moved: { kind: "project", projectId: b.projectId },
			before: { kind: "project", projectId: a.projectId },
			expectedOrderRevision: page.orderRevision,
		});
		const rejected = assert.rejects(operation, { code: "IDEMPOTENCY_CONFLICT" });
		await entered.promise;
		await runtime.call("setProjectPinned", {
			requestId: "unpin",
			projectId: a.projectId,
			expectedPresentationRevision: 1,
			pinned: false,
		});
		release.resolve();
		await rejected;
		assert.equal(await runtime.call("getSidebarPinCommandResult", { requestId: "move" }), null);
		assert.deepEqual((await runtime.call("listSidebarPins", {})).items.map(key), [
			{ kind: "project", projectId: b.projectId },
		]);
	} finally {
		release.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("default adoption atomically removes a legacy project pin while retaining exact historical receipt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-mixed-adopt-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "old", name: "Chats" });
		const input = { requestId: "pin", projectId: "old", expectedPresentationRevision: 0, pinned: true };
		const historical = await runtime.call("setProjectPinned", input);
		const state = await runtime.call("getProjectCatalogState", {}),
			{ storeId } = await runtime.call("handshake", {});
		await runtime.call("adoptLegacyDefaultWorkspace", {
			requestId: "adopt",
			workspaceId: "old",
			expectedCatalogGeneration: state.generation,
			expectedDefaultWorkspaceId: null,
			provenance: { storeId, workspaceId: "old", markerVersion: 1, role: "default-chat-workspace" },
		});
		assert.equal((await runtime.call("listSidebarPins", {})).items.length, 0);
		assert.deepEqual(await runtime.call("setProjectPinned", input), historical);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.equal((await runtime.call("listSidebarPins", {})).items.length, 0);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("schema11 hidden default pin migrates without a mixed row and permits a fresh same-default adoption", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-mixed-legacy-default-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "old", name: "Chats" });
		const pinInput = { requestId: "pin", projectId: "old", pinned: true, expectedPresentationRevision: 0 };
		const pin = await runtime.call("setProjectPinned", pinInput);
		const { storeId } = await runtime.call("handshake", {});
		const provenance = {
			storeId,
			workspaceId: "old",
			markerVersion: 1 as const,
			role: "default-chat-workspace" as const,
		};
		await runtime.close();
		const db = new DatabaseSync(join(directory, "catalog.sqlite"));
		try {
			db.exec(
				"DROP TABLE sidebar_pin_order;DROP TABLE sidebar_pin_state;DROP TABLE sidebar_pin_commands;UPDATE identity SET version=11;UPDATE projects SET status='default' WHERE project_id='old'",
			);
			db.prepare(
				"UPDATE project_catalog_state SET default_workspace_id='old',default_provenance=?,generation=1",
			).run(JSON.stringify(provenance));
		} finally {
			db.close();
		}
		runtime = await openTestRuntime(directory);
		assert.equal((await runtime.call("listSidebarPins", {})).items.length, 0);
		const state = await runtime.call("getProjectCatalogState", {}),
			adopt = {
				requestId: "fresh-adopt",
				workspaceId: "old",
				expectedCatalogGeneration: state.generation,
				expectedDefaultWorkspaceId: "old",
				provenance,
			};
		const adopted = await runtime.call("adoptLegacyDefaultWorkspace", adopt);
		assert.equal(adopted.state, "ready");
		assert.deepEqual(await runtime.call("setProjectPinned", pinInput), pin);
		assert.equal((await runtime.call("listSidebarPins", {})).items.length, 0);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("adoptLegacyDefaultWorkspace", adopt), adopted);
		assert.equal((await runtime.call("listSidebarPins", {})).items.length, 0);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
