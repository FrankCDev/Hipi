import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, StorageRequestError } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { appendAudit, auditId, ContextDoc } from "../src/agent-tools/authorization-store.ts";
import {
	ConversationDeliveryDoc,
	DirectoryChangeDoc,
	WorkspaceHeaderDoc,
	WorkspaceLiveDoc,
} from "../src/conversation-directory.ts";
import { openRuntime } from "../src/node.ts";

test("SQLite current-only documents bound replay across checkpoints without losing business audit records", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-document-checkpoints-"));
	const file = join(path, "documents.sqlite");
	const storage = await openNodeSqliteStorage(file);
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
	try {
		for (let i = 0; i <= 130; i++) {
			await harness.commit(async (tx) => {
				(await tx.doc(WorkspaceHeaderDoc)).changeSeq = i;
				(await tx.doc(WorkspaceLiveDoc)).items = [
					{ publicId: `conversation-${i}`, broker: true, receipts: false, cancellation: false },
				];
				(await tx.doc(ConversationDeliveryDoc, "conversation", null)).keys = [`request-${i}`];
				const state = await tx.doc(ContextDoc, "1", null);
				state.publicId = "conversation";
				await appendAudit(tx, 1, state, "grant", `grant-${i}`);
				const change = await tx.doc(DirectoryChangeDoc, String(i), null);
				change.publicId = "conversation";
				change.revision = i;
			}, context);
			// This calls SQLite materializeDocument, not the Harness's warm document cache.
			for (const [kind, key] of [
				["hipi.workspace-directory", undefined],
				["hipi.workspace-live", undefined],
				["hipi.conversation-delivery", "conversation"],
				["hipi.agent-context.v2", "1"],
				["hipi.agent-audit-page", `1-grant-${Math.floor(i / 64)}`],
			] as const) {
				const record = await storage.findDocument({ kind, key, scope: { kind: "session" } }, "current", context);
				assert.ok(record);
				const value = await storage.document(record.id, "current", context);
				assert.ok(value);
				assert.ok(value.deltasSinceBase <= 31, `${kind} replayed ${value.deltasSinceBase} deltas at change ${i}`);
				if (kind === "hipi.workspace-directory") assert.equal(value.value.changeSeq, i);
				if (kind === "hipi.agent-context.v2") assert.equal(value.value.grantCount, i + 1);
				if (kind === "hipi.conversation-delivery") assert.deepEqual(value.value.keys, [`request-${i}`]);
				if (kind === "hipi.workspace-live") {
					assert.deepEqual(value.value.items, [
						{ publicId: `conversation-${i}`, broker: true, receipts: false, cancellation: false },
					]);
				}
			}
		}
		await harness.commit(async (tx) => {
			for (let i = 0; i <= 130; i++) assert.equal(await auditId(tx, 1, "grant", i), `grant-${i}`);
		}, context);
		await harness.close(context);
		const reopened = await openNodeSqliteStorage(file);
		try {
			for (let page = 0; page < 3; page++) {
				const record = await reopened.findDocument(
					{ kind: "hipi.agent-audit-page", key: `1-grant-${page}`, scope: { kind: "session" } },
					"current",
					context,
				);
				assert.ok(record);
				assert.deepEqual(
					(await reopened.document(record.id, "current", context))?.value.ids,
					Array.from({ length: Math.min(64, 131 - page * 64) }, (_, i) => `grant-${page * 64 + i}`),
				);
			}
			for (let i = 0; i <= 130; i++) {
				const record = await reopened.findDocument(
					{ kind: "hipi.directory-change", key: String(i), scope: { kind: "session" } },
					"current",
					context,
				);
				assert.ok(record);
				assert.equal((await reopened.document(record.id, "current", context))?.value.revision, i);
			}
			const header = await reopened.findDocument(
				{ kind: "hipi.workspace-directory", scope: { kind: "session" } },
				"current",
				context,
			);
			assert.ok(header);
			assert.equal((await reopened.document(header.id, "current", context))?.value.changeSeq, 130);
			// Session documents never supported historical content; checkpoints do not change that contract.
			await assert.rejects(reopened.document(header.id, header.createdAt, context), StorageRequestError);
			const db = new DatabaseSync(file, { readOnly: true });
			try {
				const rows = db
					.prepare("SELECT document_id, COUNT(*) AS count FROM document_revisions GROUP BY document_id")
					.all();
				assert.ok(rows.length > 130);
				for (const row of rows) assert.ok(Number(row.count) <= 32);
			} finally {
				db.close();
			}
		} finally {
			await reopened.close(context);
		}
		assert.equal(faux.state.callCount, 0);
	} finally {
		await harness.close(context);
		await rm(path, { recursive: true, force: true });
	}
});

test("the next changed write checkpoints an existing unbounded directory tail", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-document-legacy-tail-"));
	const file = join(path, "documents.sqlite");
	const legacy = defineDoc({ ...WorkspaceHeaderDoc.definition, checkpointWhen: undefined });
	let storage = await openNodeSqliteStorage(file);
	let harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		for (let i = 0; i <= 100; i++) {
			await harness.commit(async (tx) => {
				(await tx.doc(legacy)).changeSeq = i;
			}, context);
		}
		const record = await storage.findDocument(
			{ kind: "hipi.workspace-directory", scope: { kind: "session" } },
			"current",
			context,
		);
		assert.ok(record);
		assert.equal((await storage.document(record.id, "current", context))?.deltasSinceBase, 100);
		await harness.close(context);
		storage = await openNodeSqliteStorage(file);
		harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
		await harness.commit(async (tx) => {
			(await tx.doc(WorkspaceHeaderDoc)).changeSeq = 101;
		}, context);
		const stored = await storage.document(record.id, "current", context);
		assert.equal(stored?.deltasSinceBase, 0);
		assert.equal(stored?.value.changeSeq, 101);
	} finally {
		await harness.close(context);
		await rm(path, { recursive: true, force: true });
	}
});

test("checkpointed metadata reopens for exact reads without resuming an accepted submission", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-document-readonly-"));
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	let runtime = await openRuntime(path, {
		models,
		model: { provider: "faux", modelId: "faux-1" },
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("accepted");
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		let conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Original",
		});
		const scope = { workspaceId: "work", conversationId: conversation.conversationId };
		for (let i = 1; i <= 100; i++) {
			conversation = await runtime.call("renameConversation", {
				...scope,
				requestId: `rename-${i}`,
				expectedRevision: conversation.revision,
				title: `Title ${i}`,
			});
		}
		await assert.rejects(runtime.call("submit", { ...scope, requestId: "pending", text: "Wait" }), /accepted/);
		await runtime.close();
		const storage = await openNodeSqliteStorage(join(path, "work", "workspace.sqlite"));
		try {
			const record = await storage.findDocument(
				{ kind: "hipi.conversation-metadata", key: conversation.conversationId, scope: { kind: "session" } },
				"current",
				context,
			);
			assert.ok(record);
			const stored = await storage.document(record.id, "current", context);
			assert.ok(stored);
			assert.equal(stored.deltasSinceBase, 4);
		} finally {
			await storage.close(context);
		}
		runtime = await openRuntime(path, { models, model: { provider: "faux", modelId: "faux-1" }, resume: true });
		assert.deepEqual(await runtime.call("getConversation", scope), conversation);
		assert.equal(
			(await runtime.call("getConversationCommandResult", { workspaceId: "work", requestId: "rename-1" }))?.result
				.title,
			"Title 1",
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(faux.state.callCount, 0);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});
