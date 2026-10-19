import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentToolBroker, agentRegistry } from "../src/agent-tools.ts";
import { ConversationMetaDoc, WorkspaceHeaderDoc } from "../src/conversation-directory.ts";
import type { WorkRuntime } from "../src/core.ts";
import { createFileAuthority } from "../src/files/service.ts";
import { openRuntime } from "../src/node.ts";
import { PiWorkspace } from "../src/pi-workspace.ts";
import { deterministicModels, openTestRuntime } from "../src/testing.ts";

async function settled(runtime: WorkRuntime, requestId: string) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const value = await runtime.call("getReceipt", { workspaceId: "work", requestId });
		if (value?.execution === "done" || value?.execution === "unanswered") return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Submission did not settle");
}

test("lost create response is found by read-only request lookup and never duplicates identity", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-command-"));
	let runtime = await openTestRuntime(path, {
		failpoint: async (point) => {
			if (point === "after_directory_commit") throw new Error("lost response");
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const input = { workspaceId: "work", requestId: "create", title: "Original" };
		await assert.rejects(runtime.call("createConversation", input), /lost response/);
		const command = await runtime.call("getConversationCommandResult", { workspaceId: "work", requestId: "create" });
		assert.equal(command?.method, "createConversation");
		assert.ok(command);
		await runtime.close();
		runtime = await openTestRuntime(path);
		assert.deepEqual(await runtime.call("createConversation", input), command.result);
		await assert.rejects(runtime.call("createConversation", { ...input, title: "Different" }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		assert.deepEqual((await runtime.call("listConversations", { workspaceId: "work" })).items, [command.result]);
		const renamed = await runtime.call("renameConversation", {
			workspaceId: "work",
			conversationId: command.result.conversationId,
			requestId: "rename",
			expectedRevision: 1,
			title: "New",
		});
		assert.equal(renamed.revision, 2);
		assert.equal(
			(await runtime.call("getConversationCommandResult", { workspaceId: "work", requestId: "create" }))?.result
				.title,
			"Original",
		);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("exact metadata and directory command reads never resume pending work even with resume enabled", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-readonly-"));
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const root = await authority.grantRoot({
		principalId: "owner",
		workspaceId: "work",
		absolutePath: path,
		writable: false,
	});
	let runtime = await openTestRuntime(path, {
		agentFiles: () => authority.forAgent("owner"),
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("accepted");
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const created = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Pending",
		});
		const scope = { workspaceId: "work", conversationId: created.conversationId };
		const grant = await runtime.call("authorizeAgentContext", {
			...scope,
			requestId: "authorize",
			rootId: root.rootId,
			pathPrefixes: [""],
			model: { provider: "faux", modelId: "faux-1" },
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
		const revoked = await runtime.call("revokeAgentContext", {
			...scope,
			requestId: "revoke",
			grantId: grant.grantId,
			expectedRevision: grant.revision,
		});
		await assert.rejects(runtime.call("submit", { ...scope, requestId: "pending", text: "Wait" }), /accepted/);
		await runtime.close();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		runtime = await openRuntime(path, { models, model: { provider: "faux", modelId: "faux-1" }, resume: true });
		assert.deepEqual(await runtime.call("getConversation", scope), created);
		assert.deepEqual(
			await runtime.call("getConversationCommandResult", { workspaceId: "work", requestId: "create" }),
			{ method: "createConversation", result: created },
		);
		assert.equal(
			await runtime.call("getConversationCommandResult", { workspaceId: "work", requestId: "absent" }),
			null,
		);
		assert.deepEqual(await runtime.call("getAgentCommandResult", { ...scope, requestId: "authorize" }), {
			method: "authorizeAgentContext",
			result: revoked,
		});
		assert.deepEqual(await runtime.call("getAgentCommandResult", { ...scope, requestId: "revoke" }), {
			method: "revokeAgentContext",
			result: revoked,
		});
		assert.equal(await runtime.call("getAgentCommandResult", { ...scope, requestId: "absent" }), null);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(faux.state.callCount, 0);
	} finally {
		await runtime.close();
		await authority.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("archive and restore retain PI identity, history, receipt and first command result", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-archive-"));
	let runtime = await openTestRuntime(path, { tokensPerSecond: 100000 });
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const created = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Saved",
		});
		const scope = { workspaceId: "work", conversationId: created.conversationId };
		await runtime.call("submit", { ...scope, requestId: "message", text: "Preserve this answer" });
		const receipt = await settled(runtime, "message");
		const history = await runtime.call("getHistory", scope);
		const archived = await runtime.call("archiveConversation", {
			...scope,
			requestId: "archive",
			expectedRevision: 1,
		});
		assert.ok(archived.archivedAt);
		assert.deepEqual((await runtime.call("listConversations", { workspaceId: "work" })).items, []);
		assert.deepEqual((await runtime.call("listConversations", { workspaceId: "work", filter: "archived" })).items, [
			archived,
		]);
		await assert.rejects(runtime.call("submit", { ...scope, requestId: "blocked", text: "No" }), {
			code: "CONVERSATION_ARCHIVED",
		});
		assert.deepEqual(await runtime.call("getHistory", scope), history);
		await runtime.close();
		runtime = await openTestRuntime(path);
		assert.deepEqual(await runtime.call("getReceipt", { workspaceId: "work", requestId: "message" }), receipt);
		const restored = await runtime.call("restoreConversation", {
			...scope,
			requestId: "restore",
			expectedRevision: 2,
		});
		assert.equal(restored.conversationId, created.conversationId);
		assert.equal(restored.archivedAt, null);
		assert.equal(restored.revision, 3);
		assert.deepEqual(await runtime.call("getHistory", scope), history);
		assert.deepEqual(
			await runtime.call("archiveConversation", { ...scope, requestId: "archive", expectedRevision: 1 }),
			archived,
		);
		assert.deepEqual(await runtime.call("getConversation", scope), restored);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("accepted delivery and paused cancellation cannot be archived as idle", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-busy-"));
	let runtime = await openTestRuntime(path, {
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("accepted");
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const created = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Busy",
		});
		const scope = { workspaceId: "work", conversationId: created.conversationId };
		await assert.rejects(runtime.call("submit", { ...scope, requestId: "pending", text: "Wait" }), /accepted/);
		await assert.rejects(
			runtime.call("archiveConversation", { ...scope, requestId: "archive", expectedRevision: 1 }),
			{ code: "CONVERSATION_BUSY" },
		);
		await runtime.close();
		runtime = await openTestRuntime(path);
		await assert.rejects(
			runtime.call("archiveConversation", { ...scope, requestId: "archive", expectedRevision: 1 }),
			{ code: "CONVERSATION_BUSY" },
		);
		await runtime.call("cancelExecution", scope);
		assert.ok(
			(await runtime.call("archiveConversation", { ...scope, requestId: "archive", expectedRevision: 1 }))
				.archivedAt,
		);
		assert.equal(
			(await runtime.call("getReceipt", { workspaceId: "work", requestId: "pending" }))?.state,
			"cancelled",
		);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("conversation pagination exceeds the old lifetime limit and binds its revision and scope", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-pages-"));
	const runtime = await openTestRuntime(path);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		for (let i = 0; i < 55; i++)
			await runtime.call("createConversation", {
				workspaceId: "work",
				requestId: `create-${i}`,
				title: `Conversation ${i}`,
			});
		const first = await runtime.call("listConversations", { workspaceId: "work" });
		assert.equal(first.items.length, 50);
		assert.ok(first.nextCursor);
		const second = await runtime.call("listConversations", { workspaceId: "work", cursor: first.nextCursor });
		assert.equal(second.items.length, 5);
		assert.equal(second.nextCursor, null);
		assert.equal(new Set([...first.items, ...second.items].map((item) => item.conversationId)).size, 55);
		await assert.rejects(
			runtime.call("listConversations", { workspaceId: "work", filter: "archived", cursor: first.nextCursor }),
			{ code: "INVALID_REQUEST" },
		);
		await runtime.call("renameConversation", {
			workspaceId: "work",
			conversationId: first.items[0].conversationId,
			requestId: "rename",
			expectedRevision: 1,
			title: "Changed",
		});
		await assert.rejects(runtime.call("listConversations", { workspaceId: "work", cursor: first.nextCursor }), {
			code: "CURSOR_STALE",
		});
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("directory projection failure never rolls back PI commands and missing rows rebuild from the PI log", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-index-"));
	const runtime = await openTestRuntime(path);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const created = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Saved",
		});
		await runtime.call("listConversations", { workspaceId: "work" });
		const db = new DatabaseSync(join(path, "catalog.sqlite"));
		try {
			db.exec(
				"CREATE TRIGGER fail_projection BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT,'injected projection failure'); END",
			);
			const renamed = await runtime.call("renameConversation", {
				workspaceId: "work",
				conversationId: created.conversationId,
				requestId: "rename",
				expectedRevision: 1,
				title: "Committed",
			});
			await assert.rejects(
				runtime.call("listConversations", { workspaceId: "work" }),
				/injected projection failure/,
			);
			assert.deepEqual(
				(await runtime.call("getConversationCommandResult", { workspaceId: "work", requestId: "rename" }))?.result,
				renamed,
			);
			await runtime.call("cancelExecution", { workspaceId: "work", conversationId: created.conversationId });
			db.exec("DROP TRIGGER fail_projection");
			assert.deepEqual((await runtime.call("listConversations", { workspaceId: "work" })).items, [renamed]);
			db.exec("DELETE FROM conversations");
			assert.deepEqual((await runtime.call("listConversations", { workspaceId: "work" })).items, [renamed]);
		} finally {
			db.close();
		}
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("more than 64 completed submissions retain their original receipts without growing a lifetime admission array", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-delivery-capacity-"));
	const runtime = await openTestRuntime(path, { tokensPerSecond: 100000 });
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const created = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Long lived",
		});
		const scope = { workspaceId: "work", conversationId: created.conversationId };
		for (let i = 0; i < 65; i++) {
			await runtime.call("submit", { ...scope, requestId: `message-${i}`, text: `Message ${i}` });
			assert.equal((await settled(runtime, `message-${i}`)).execution, "done");
		}
		assert.equal(
			(await runtime.call("getReceipt", { workspaceId: "work", requestId: "message-0" }))?.execution,
			"done",
		);
		assert.ok(
			(await runtime.call("archiveConversation", { ...scope, requestId: "archive", expectedRevision: 1 }))
				.archivedAt,
		);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("legacy catalog migration preserves durable identity and retires its former array authority", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-migrate-"));
	let runtime = await openTestRuntime(path);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const created = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Legacy",
		});
		await runtime.close();
		const storage = await openNodeSqliteStorage(join(path, "work", "workspace.sqlite"));
		const broker = new AgentToolBroker("work", undefined, async () => []);
		const harness = await Harness.open(
			storage,
			{ models: deterministicModels(), registry: agentRegistry(broker) },
			BACKGROUND_CONTEXT,
		);
		broker.attach(harness);
		const legacy = defineDoc<{
			workspaceId: string;
			name: string;
			conversations: { publicId: string; durableId: number; title: string; count: number }[];
			requests: string[];
		}>({
			kind: "hipi.workspace",
			scope: "session",
			version: 1,
			initial: () => ({ workspaceId: "", name: "", conversations: [], requests: [] }),
		});
		const metadata = (await harness.snapshot(ConversationMetaDoc, created.conversationId, BACKGROUND_CONTEXT))?.value;
		assert.ok(metadata);
		await harness.commit(async (tx) => {
			Object.assign(await tx.doc(legacy), {
				workspaceId: "work",
				name: "Work",
				conversations: [
					{ publicId: created.conversationId, durableId: metadata.durableId, title: "Legacy", count: 0 },
				],
				requests: [],
			});
			await tx.retireDoc(WorkspaceHeaderDoc);
			await tx.retireDoc(ConversationMetaDoc, created.conversationId);
		}, BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		runtime = await openTestRuntime(path, {
			failpoint: async (point) => {
				if (point === "after_directory_migration_item") throw new Error("migration interrupted");
			},
		});
		await assert.rejects(
			runtime.call("getAgentCommandResult", {
				workspaceId: "work",
				conversationId: created.conversationId,
				requestId: "legacy-command",
			}),
			{ code: "INDEX_RECOVERY_REQUIRED" },
		);
		await assert.rejects(runtime.call("openWorkspace", { workspaceId: "work" }), /migration interrupted/);
		await runtime.close();
		runtime = await openTestRuntime(path);
		await runtime.call("openWorkspace", { workspaceId: "work" });
		const migrated = await runtime.call("getConversation", {
			workspaceId: "work",
			conversationId: created.conversationId,
		});
		assert.equal(migrated.createdAt, null);
		assert.equal(migrated.title, "Legacy");
		await runtime.close();
		const reader = await openNodeSqliteStorage(join(path, "work", "workspace.sqlite"));
		try {
			assert.equal(
				await reader.findDocument(
					{ kind: "hipi.workspace", scope: { kind: "session" } },
					"current",
					BACKGROUND_CONTEXT,
				),
				undefined,
			);
			const record = await reader.findDocument(
				{ kind: "hipi.conversation-metadata", scope: { kind: "session" }, key: created.conversationId },
				"current",
				BACKGROUND_CONTEXT,
			);
			assert.ok(record);
			const saved = await reader.document(record.id, "current", BACKGROUND_CONTEXT);
			assert.equal(
				saved?.value.value && typeof saved.value.value === "object" && !Array.isArray(saved.value.value)
					? saved.value.value.durableId
					: undefined,
				metadata.durableId,
			);
		} finally {
			await reader.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("missing root identity is rejected rather than replacing the store identity around existing PI data", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-identity-"));
	const runtime = await openTestRuntime(path);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		await runtime.close();
		const db = new DatabaseSync(join(path, "catalog.sqlite"));
		db.exec("DELETE FROM identity");
		db.close();
		await assert.rejects(openTestRuntime(path), { code: "STORE_MISMATCH" });
		const check = new DatabaseSync(join(path, "catalog.sqlite"));
		try {
			assert.equal(check.prepare("SELECT count(*) AS total FROM identity").get()?.total, 0);
		} finally {
			check.close();
		}
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("SQLite eviction check pins active grants, observers and paused accepted work but releases idle workspaces", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-directory-eviction-"));
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const root = await authority.grantRoot({
		principalId: "owner",
		workspaceId: "work",
		absolutePath: path,
		writable: false,
	});
	const models = deterministicModels(100000);
	const options = {
		workspaceId: "work",
		name: "Work",
		models,
		model: { provider: "faux", modelId: "faux-1" },
		agentFiles: () => authority.forAgent("owner"),
	};
	let workspace = await PiWorkspace.open(await openNodeSqliteStorage(join(path, "workspace.sqlite")), options);
	try {
		const conversation = await workspace.createConversation({
			workspaceId: "work",
			requestId: "create",
			title: "Evict",
		});
		const scope = { workspaceId: "work", conversationId: conversation.conversationId };
		assert.equal(await workspace.canEvict(), true);
		const observer = await workspace.observe(scope, () => {});
		assert.equal(await workspace.canEvict(), false);
		await observer.dispose();
		const grant = await workspace.authorizeAgentContext({
			...scope,
			requestId: "authorize",
			rootId: root.rootId,
			pathPrefixes: [""],
			model: options.model,
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
		assert.equal(await workspace.canEvict(), false);
		await workspace.revokeAgentContext({
			...scope,
			requestId: "revoke",
			grantId: grant.grantId,
			expectedRevision: grant.revision,
		});
		assert.equal(await workspace.canEvict(), true);
		await workspace.close();
		workspace = await PiWorkspace.open(await openNodeSqliteStorage(join(path, "workspace.sqlite")), {
			...options,
			failpoint: async (point) => {
				if (point === "after_accept") throw new Error("accepted");
			},
		});
		await assert.rejects(workspace.submit({ ...scope, requestId: "pending", text: "Wait" }), /accepted/);
		assert.equal(await workspace.canEvict(), false);
		await workspace.close();
		workspace = await PiWorkspace.open(await openNodeSqliteStorage(join(path, "workspace.sqlite")), options);
		assert.equal(await workspace.canEvict(), false);
		await workspace.cancelExecution(scope);
		assert.equal(await workspace.canEvict(), true);
	} finally {
		await workspace.close();
		await authority.close();
		await rm(path, { recursive: true, force: true });
	}
});
