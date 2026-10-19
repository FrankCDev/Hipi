import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PROTOCOL_VERSION } from "../src/contracts.ts";
import { openRuntime as openNodeRuntime } from "../src/node.ts";
import { openTestRuntime } from "../src/testing.ts";

for (const point of ["after_reserve", "after_directory", "after_storage", "before_ready"] as const) {
	test(`catalog recovers interrupted creation at ${point} without deleting original data`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-failure-"));
		let runtime = await openTestRuntime(directory, {
			catalogFailpoint: async (current) => {
				if (current === point) throw new Error("Injected catalog interruption");
			},
		});
		try {
			const identity = await runtime.call("handshake", {});
			await assert.rejects(runtime.call("createWorkspace", { workspaceId: "work", name: "Original" }), /Injected/);
			await runtime.close();
			runtime = await openTestRuntime(directory);
			assert.deepEqual(await runtime.call("handshake", {}), identity);
			await assert.rejects(runtime.call("createWorkspace", { workspaceId: "work", name: "Changed" }), {
				code: "IDEMPOTENCY_CONFLICT",
			});
			assert.deepEqual(await runtime.call("createWorkspace", { workspaceId: "work", name: "Original" }), {
				workspaceId: "work",
				name: "Original",
			});
			assert.deepEqual(await runtime.call("listWorkspaces", {}), {
				items: [{ workspaceId: "work", name: "Original" }],
				nextCursor: null,
			});
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("persistent identity and bounded catalogs survive restart; listings never resume PI scheduling", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-"));
	let runtime = await openTestRuntime(directory, {
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("Accepted but paused");
		},
	});
	try {
		const identity = await runtime.call("handshake", {});
		assert.deepEqual(await runtime.call("listWorkspaces", {}), { items: [], nextCursor: null });
		assert.equal(
			(await readdir(directory)).some((name) => name === "work"),
			false,
		);
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Workspace" });
		const conversation = await runtime.call("createConversation", {
			requestId: "create-1",
			workspaceId: "work",
			title: "Saved conversation",
		});
		await assert.rejects(
			runtime.call("submit", {
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
				requestId: "pending",
				text: "Do not run from a listing",
			}),
			/Accepted/,
		);
		await runtime.close();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		runtime = await openNodeRuntime(directory, {
			models,
			model: { provider: "faux", modelId: "faux-1" },
			resume: true,
		});
		assert.deepEqual(await runtime.call("handshake", {}), identity);
		assert.deepEqual(await runtime.call("listWorkspaces", {}), {
			items: [{ workspaceId: "work", name: "Workspace" }],
			nextCursor: null,
		});
		assert.deepEqual(await runtime.call("listConversations", { workspaceId: "work" }), {
			items: [conversation],
			nextCursor: null,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(faux.state.callCount, 0);
		await assert.rejects(runtime.call("listConversations", { workspaceId: "../work" }), { code: "INVALID_REQUEST" });
		await assert.rejects(runtime.call("listConversations", { workspaceId: "missing" }), { code: "NOT_FOUND" });
		await assert.rejects(
			runtime.execute({
				version: PROTOCOL_VERSION,
				method: "listWorkspaces",
				params: {},
				expectedStoreId: "another-store",
			}),
			{ code: "STORE_MISMATCH" },
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("phase-one workspace discovery repairs registration without replacing its PI conversation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-discovery-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "legacy", name: "Legacy" });
		const conversation = await runtime.call("createConversation", {
			requestId: "create-2",
			workspaceId: "legacy",
			title: "Preserved",
		});
		const identity = await runtime.call("handshake", {});
		await runtime.close();
		const db = new DatabaseSync(join(directory, "catalog.sqlite"));
		db.exec("DELETE FROM workspaces");
		db.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("handshake", {}), identity);
		assert.deepEqual(await runtime.call("listConversations", { workspaceId: "legacy" }), {
			items: [conversation],
			nextCursor: null,
		});
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("copied roots, workspace symlinks and database symlinks cannot impersonate a store", async () => {
	const parent = await mkdtemp(join(tmpdir(), "hipi-catalog-path-"));
	const directory = join(parent, "original");
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Original" });
		await runtime.close();
		await cp(directory, join(parent, "copy"), { recursive: true });
		await assert.rejects(openTestRuntime(join(parent, "copy")), { code: "STORE_MISMATCH" });
		runtime = await openTestRuntime(directory);
		await symlink(join(parent, "copy", "work"), join(directory, "escape"), "dir");
		await assert.rejects(runtime.call("createWorkspace", { workspaceId: "escape", name: "Escape" }), {
			code: "NOT_FOUND",
		});
		await mkdir(join(directory, "linked"));
		await symlink(join(parent, "copy", "work", "workspace.sqlite"), join(directory, "linked", "workspace.sqlite"));
		await assert.rejects(runtime.call("openWorkspace", { workspaceId: "linked" }), { code: "INVALID_REQUEST" });
	} finally {
		await runtime.close();
		await rm(parent, { recursive: true, force: true });
	}
});

test("a registered workspace with a missing database is never silently recreated", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-missing-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Original" });
		await runtime.close();
		await rm(join(directory, "work", "workspace.sqlite"));
		runtime = await openTestRuntime(directory);
		await assert.rejects(runtime.call("createWorkspace", { workspaceId: "work", name: "Original" }), {
			code: "NOT_FOUND",
		});
		assert.equal((await readdir(join(directory, "work"))).includes("workspace.sqlite"), false);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("close drains admitted initialization and metadata queries before releasing the root owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-close-"));
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let runtime = await openTestRuntime(directory, {
		catalogFailpoint: async (point) => {
			if (point === "before_ready") {
				entered.resolve();
				await gate.promise;
			}
		},
	});
	try {
		const creating = runtime.call("createWorkspace", { workspaceId: "work", name: "Admitted" });
		await entered.promise;
		const closing = runtime.close();
		await assert.rejects(openTestRuntime(directory), { code: "WORKSPACE_BUSY" });
		await assert.rejects(runtime.call("handshake", {}), { code: "CLOSED" });
		gate.resolve();
		await creating;
		await closing;
		runtime = await openTestRuntime(directory);
		const conversation = await runtime.call("createConversation", {
			requestId: "create-3",
			workspaceId: "work",
			title: "Preserved",
		});
		const reading = runtime.call("listConversations", { workspaceId: "work" });
		await runtime.close();
		assert.deepEqual(await reading, { items: [conversation], nextCursor: null });
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("listWorkspaces", {}), {
			items: [{ workspaceId: "work", name: "Admitted" }],
			nextCursor: null,
		});
	} finally {
		gate.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent idle workspace creation preserves the full catalog beyond the live cache limit across restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-limit-"));
	let runtime = await openTestRuntime(directory);
	try {
		const expected = Array.from({ length: 20 }, (_, i) => ({ workspaceId: `work_${i}`, name: `Workspace ${i}` }));
		// Idle eviction permits admission beyond the live cache bound; workspace-cache tests enforce that bound.
		const created = await Promise.all(expected.map((workspace) => runtime.call("createWorkspace", workspace)));
		assert.deepEqual(created, expected);
		const before = await runtime.call("listWorkspaces", {});
		assert.equal(before.nextCursor, null);
		assert.deepEqual(
			before.items.toSorted((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
			expected.toSorted((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
		);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		const listed = await runtime.call("listWorkspaces", {});
		assert.deepEqual(listed, before);
		for (const workspace of expected)
			assert.deepEqual(await runtime.call("getWorkspace", { workspaceId: workspace.workspaceId }), workspace);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("unknown catalog schema is rejected without resetting the identity or deleting workspace data", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-version-"));
	const runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Preserved" });
		const identity = await runtime.call("handshake", {});
		await runtime.close();
		const database = new DatabaseSync(join(directory, "catalog.sqlite"));
		try {
			database.exec("UPDATE identity SET version=999");
		} finally {
			database.close();
		}
		await assert.rejects(openTestRuntime(directory), { code: "STORE_MISMATCH" });
		const inspected = new DatabaseSync(join(directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(inspected.prepare("SELECT store_id FROM identity").get()?.store_id, identity.storeId);
			assert.equal(inspected.prepare("SELECT name FROM workspaces").get()?.name, "Preserved");
		} finally {
			inspected.close();
		}
		assert.ok((await readdir(join(directory, "work"))).includes("workspace.sqlite"));
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
