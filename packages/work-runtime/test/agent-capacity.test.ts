import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness, ProviderDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	ApprovalDoc,
	auditCursor,
	auditPosition,
	CommandDoc,
	ContextDoc,
	commandKey,
	GrantDoc,
	LegacyContextDoc,
	OperationDoc,
	resolveAgentCommandResult,
} from "../src/agent-tools/authorization-store.ts";
import { createWorkspaceModels } from "../src/agent-tools/model-gate.ts";
import { AgentToolBroker, agentRegistry } from "../src/agent-tools.ts";
import type { AgentContext, ToolApproval } from "../src/contracts.ts";
import { createFileAuthority } from "../src/files/service.ts";

test("pending audit revision changes are stale while malformed or cross-scope cursors remain invalid", () => {
	const oldKind = `pending-${"a".repeat(64)}`;
	const newKind = `pending-${"b".repeat(64)}`;
	const cursor = auditCursor("store", "work", "conversation", oldKind, 2, 1);
	assert.ok(cursor);
	assert.deepEqual(auditPosition("store", "work", "conversation", oldKind, 2, cursor), { upper: 2, position: 1 });
	assert.throws(() => auditPosition("store", "work", "conversation", newKind, 0, cursor), { code: "CURSOR_STALE" });
	for (const invalid of [
		auditCursor("other-store", "work", "conversation", oldKind, 2, 1),
		auditCursor("store", "other-work", "conversation", oldKind, 2, 1),
		auditCursor("store", "work", "other-conversation", oldKind, 2, 1),
		auditCursor("store", "work", "conversation", "grant", 2, 1),
		auditCursor("store", "work", "conversation", "pending-invalid", 2, 1),
		auditCursor("store", "work", "conversation", oldKind, 65, 1),
		auditCursor("store", "work", "conversation", oldKind, 2, 3),
		"invalid-json",
	]) {
		assert.ok(invalid);
		assert.throws(() => auditPosition("store", "work", "conversation", newKind, 0, invalid), {
			code: "INVALID_REQUEST",
		});
	}
	assert.throws(() => auditPosition("store", "work", "conversation", "grant", 2, cursor), { code: "INVALID_REQUEST" });
});

async function fixture(generation = "store-generation") {
	const directory = await mkdtemp(join(tmpdir(), "hipi-agent-capacity-"));
	await writeFile(join(directory, "note.txt"), "original");
	const files = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const root = await files.grantRoot({
		principalId: "owner",
		workspaceId: "work",
		absolutePath: directory,
		writable: true,
	});
	const faux = fauxProvider({
		provider: "faux",
		api: "hipi-test",
		models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 1000 }],
		tokensPerSecond: 1000000,
	});
	const source = createModels();
	source.setProvider(faux.provider);
	const broker = new AgentToolBroker(
		"work",
		() => files.forAgent("owner"),
		async (_tx, ids) => ids,
		{
			auditGeneration: async () => generation,
			assertConversationActive: async () => {},
			updateBrokerLive: async () => {},
		},
	);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "state.sqlite")),
		{
			models: createWorkspaceModels(source, broker),
			registry: agentRegistry(broker),
			conversationCreated: (tx, record) => broker.conversationCreated(tx, record),
		},
		background,
	);
	broker.attach(harness);
	const model = { provider: "faux", modelId: "faux-1" };
	const conversation = await harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model }, init: (tx, id) => broker.register(tx, id, "conversation") },
		background,
	);
	const scope = { workspaceId: "work", conversationId: "conversation" };
	const input = {
		...scope,
		rootId: root.rootId,
		pathPrefixes: [""],
		model,
		expiresAt: Date.now() + 60000,
		disclosureVersion: 1 as const,
	};
	return {
		directory,
		files,
		root,
		faux,
		source,
		broker,
		harness,
		conversation,
		scope,
		model,
		input,
		close: async () => {
			broker.close();
			await harness.close(background);
			await files.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("grant and command history exceeds lifetime limits, bounded pages exclude later inserts, read-only lookup never creates commands", async () => {
	const f = await fixture();
	const otherStore = await fixture("other-store-generation");
	try {
		let first: AgentContext | undefined;
		for (let i = 0; i < 140; i++) {
			const grant = await f.broker.authorize(f.conversation.id, { ...f.input, requestId: `grant-${i}` });
			first ??= grant;
			await f.broker.revoke(f.conversation.id, {
				...f.scope,
				requestId: `revoke-${i}`,
				grantId: grant.grantId,
				expectedRevision: grant.revision,
			});
		}
		assert.ok(first);
		assert.deepEqual(await f.broker.activeContexts(f.conversation.id), []);
		assert.equal(
			(await f.harness.snapshot(CommandDoc, commandKey(f.conversation.id, "grant-0"), background))?.value
				?.firstResult?.status,
			"active",
		);
		const result = await f.broker.commandResult(f.conversation.id, "grant-0");
		assert.equal(result?.method, "authorizeAgentContext");
		assert.equal(result?.result.status, "revoked");
		assert.equal(await f.broker.commandResult(f.conversation.id, "never-submitted"), null);
		assert.equal(
			await f.harness.snapshot(CommandDoc, commandKey(f.conversation.id, "never-submitted"), background),
			undefined,
		);
		const page = await f.broker.contexts(f.conversation.id);
		assert.equal(page.items.length, 64);
		assert.ok(page.nextCursor);
		await f.broker.authorize(f.conversation.id, { ...f.input, requestId: "later-grant" });
		const next = await f.broker.contexts(f.conversation.id, page.nextCursor);
		assert.equal(next.items.length, 64);
		assert.ok(next.nextCursor);
		const last = await f.broker.contexts(f.conversation.id, next.nextCursor);
		assert.equal(last.items.length, 12);
		assert.equal(last.nextCursor, null);
		assert.equal(new Set([...page.items, ...next.items, ...last.items].map((item) => item.grantId)).size, 140);
		assert.equal(last.items.at(-1)?.grantId, first.grantId);
		await assert.rejects(otherStore.broker.contexts(otherStore.conversation.id, page.nextCursor), {
			code: "INVALID_REQUEST",
		});
		await assert.rejects(f.broker.approvals(f.conversation.id, page.nextCursor), { code: "INVALID_REQUEST" });
		await assert.rejects(
			f.broker.authorize(f.conversation.id, { ...f.input, requestId: "grant-0", pathPrefixes: ["changed"] }),
			{ code: "IDEMPOTENCY_CONFLICT" },
		);
		for (let i = 0; i < 31; i++)
			await f.broker.authorize(f.conversation.id, { ...f.input, requestId: `active-${i}` });
		await assert.rejects(f.broker.authorize(f.conversation.id, { ...f.input, requestId: "over-active" }), {
			code: "CAPACITY_EXCEEDED",
		});
		assert.equal((await f.broker.activeContexts(f.conversation.id)).length, 32);
	} finally {
		await f.close();
		await otherStore.close();
	}
});

test("65 rejected real tool proposals release live slots and retain paged approval audit", async () => {
	const f = await fixture();
	try {
		await f.broker.authorize(f.conversation.id, { ...f.input, requestId: "grant" });
		const digest = createHash("sha256").update("original").digest("hex");
		for (let i = 0; i < 65; i++) {
			f.faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("hipi_files_save", {
							rootId: f.root.rootId,
							path: "note.txt",
							text: `proposal-${i}`,
							ifMatch: digest,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Rejected."),
			]);
			const turn = await f.conversation.submit({ type: "input", content: `Propose ${i}` }, background);
			let approval: ToolApproval | undefined;
			const deadline = Date.now() + 5000;
			while (!approval && Date.now() < deadline) {
				approval = (await f.broker.pendingApprovals(f.conversation.id)).items[0];
				if (!approval) await new Promise((resolve) => setTimeout(resolve, 5));
			}
			assert.ok(approval);
			const input = {
				...f.scope,
				requestId: `decision-${i}`,
				approvalId: approval.approvalId,
				expectedRevision: approval.revision,
				argumentsDigest: approval.argumentsDigest,
				contentDigest: approval.contentDigest,
				decision: "reject" as const,
			};
			await f.broker.decide(f.conversation.id, input);
			assert.equal((await turn.wait(background)).status, "done");
			assert.equal((await f.broker.commandResult(f.conversation.id, input.requestId))?.result.status, "rejected");
		}
		assert.deepEqual((await f.broker.pendingApprovals(f.conversation.id)).items, []);
		assert.equal((await f.harness.snapshot(ContextDoc, String(f.conversation.id), background))?.approvalCount, 65);
		const ids = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await f.broker.approvals(f.conversation.id, cursor);
			assert.equal(page.items.length, 1);
			assert.equal(page.items[0].status, "rejected");
			ids.add(page.items[0].approvalId);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		assert.equal(ids.size, 65);
	} finally {
		await f.close();
	}
});

test("command result resolver rejects corrupt references and scope mismatches without executing commands", async () => {
	const f = await fixture();
	try {
		const grant = await f.broker.authorize(f.conversation.id, { ...f.input, requestId: "grant" });
		const state = await f.harness.snapshot(ContextDoc, String(f.conversation.id), background);
		const command = await f.harness.snapshot(CommandDoc, commandKey(f.conversation.id, "grant"), background);
		const target = await f.harness.snapshot(GrantDoc, grant.grantId, background);
		assert.ok(command?.value);
		const resolve = (replacement: unknown = command, targetValue: unknown = target, context: unknown = state) =>
			resolveAgentCommandResult(
				async (kind) =>
					kind === "hipi.agent-context.v2" ? context : kind === "hipi.agent-command" ? replacement : targetValue,
				"work",
				"conversation",
				f.conversation.id,
				"grant",
			);
		assert.equal((await resolve())?.result.status, "active");
		await assert.rejects(resolve(command, target, null), { code: "INDEX_RECOVERY_REQUIRED" });
		for (const change of [{ digest: "bad" }, { kind: "forged" }, { requestId: "other" }, { resultId: "other" }])
			await assert.rejects(resolve({ ...command, value: { ...command.value, ...change } }));
		await assert.rejects(resolve({ ...command, publicId: "other" }), { code: "UNAUTHORIZED" });
		await assert.rejects(resolve(command, { ...target, conversationId: f.conversation.id + 1 }), {
			code: "UNAUTHORIZED",
		});
		await assert.rejects(resolve(command, { ...target, value: { ...grant, workspaceId: "other" } }), {
			code: "UNAUTHORIZED",
		});
		assert.equal(
			await resolveAgentCommandResult(
				async (kind) => (kind === "hipi.agent-context.v2" ? state : undefined),
				"work",
				"conversation",
				f.conversation.id,
				"absent",
			),
			null,
		);
	} finally {
		await f.close();
	}
});

test("provider session binding has no lifetime 64 cap and exact sessions remain isolated", async () => {
	const f = await fixture();
	try {
		const model = f.source.getModel("faux", "faux-1");
		assert.ok(model);
		for (let i = 0; i < 70; i++) {
			const conversation = await f.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: f.model },
					init: (tx, id) => f.broker.register(tx, id, `conversation-${i}`),
				},
				background,
			);
			const provider = await f.harness.snapshot(ProviderDoc, conversation.id, background);
			assert.ok(provider);
			await f.broker.check(provider.sessionId, model);
		}
		await assert.rejects(f.broker.check("forged", model), { code: "UNAUTHORIZED" });
	} finally {
		await f.close();
	}
});

test("legacy migration is atomic, retains 64 unknown effects and old result references without inventing first snapshots", async () => {
	const f = await fixture();
	try {
		const digest = createHash("sha256").update("original").digest("hex");
		const grant: AgentContext = {
			...f.input,
			requestId: "legacy-grant",
			grantId: "old-grant",
			purpose: "live-files",
			revision: 1,
			status: "active",
		};
		await f.harness.commit(async (tx) => {
			const legacy = await tx.doc(LegacyContextDoc, String(f.conversation.id), null);
			legacy.publicId = f.scope.conversationId;
			legacy.grants = [grant];
			legacy.dependencies = [{ rootId: f.root.rootId, path: "" }];
			legacy.commands = [
				{
					requestId: grant.requestId,
					digest: createHash("sha256")
						.update(JSON.stringify({ ...f.input, requestId: grant.requestId }))
						.digest("hex"),
					resultId: grant.grantId,
					kind: "authorize",
				},
			];
			for (let i = 0; i < 64; i++) {
				const approval: ToolApproval = {
					...f.scope,
					approvalId: `approval-${i}`,
					taskId: "1",
					callId: `call-${i}`,
					submissionIds: ["1"],
					receiptIds: ["receipt"],
					toolName: "hipi_files_save",
					model: f.model,
					rootId: f.root.rootId,
					path: "note.txt",
					ifMatch: digest,
					text: "replacement",
					beforeText: "original",
					beforeTextTruncated: false,
					argumentsDigest: digest,
					contentDigest: digest,
					grantId: grant.grantId,
					grantRevision: 1,
					expiresAt: f.input.expiresAt,
					createdAt: Date.now(),
					revision: 2,
					status: "consumed",
					operationId: `operation-${i}`,
				};
				legacy.approvals.push(approval.approvalId);
				(await tx.doc(ApprovalDoc, approval.approvalId, null)).value = approval;
				(await tx.doc(OperationDoc, `operation-${i}`, null)).value = {
					...f.scope,
					operationId: `operation-${i}`,
					approvalId: approval.approvalId,
					taskId: "1",
					callId: approval.callId,
					rootId: f.root.rootId,
					path: "note.txt",
					argumentsDigest: digest,
					contentDigest: digest,
					status: "executing",
					revision: 1,
				};
			}
		}, background);
		await assert.rejects(
			f.harness.commit(async (tx) => {
				await f.broker.migrateConversation(tx, f.conversation.id, f.scope.conversationId);
				throw new Error("migration interrupted");
			}, background),
		);
		assert.equal(await f.harness.snapshot(GrantDoc, grant.grantId, background), undefined);
		await f.harness.commit(
			(tx) => f.broker.migrateConversation(tx, f.conversation.id, f.scope.conversationId),
			background,
		);
		await f.harness.commit(
			(tx) => f.broker.migrateConversation(tx, f.conversation.id, f.scope.conversationId),
			background,
		);
		await f.broker.recover(f.conversation.id);
		const state = await f.harness.snapshot(ContextDoc, String(f.conversation.id), background);
		assert.ok(state);
		assert.equal(state.operationIds.length, 64);
		assert.equal(state.grantCount, 1);
		assert.equal(state.approvalCount, 64);
		assert.equal((await f.broker.commandResult(f.conversation.id, grant.requestId))?.result.status, "invalidated");
		assert.equal(
			(await f.harness.snapshot(CommandDoc, commandKey(f.conversation.id, grant.requestId), background))?.value
				?.firstResult,
			undefined,
		);
		await assert.rejects(
			f.harness.commit((tx) => f.broker.archiveInTransaction(tx, f.conversation.id), background),
			{ code: "RECONCILIATION_REQUIRED" },
		);
		for (let i = 0; i < 64; i++)
			assert.equal(
				(await f.broker.operation(f.conversation.id, { ...f.scope, operationId: `operation-${i}` }))?.status,
				"unknown",
			);
		assert.equal((await f.broker.approvals(f.conversation.id)).items.length, 1);
		await f.broker.authorize(f.conversation.id, { ...f.input, requestId: "renewed" });
		f.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("hipi_files_save", {
						rootId: f.root.rootId,
						path: "note.txt",
						text: "replacement",
						ifMatch: digest,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Cannot add effects over the live recovery quota."),
		]);
		const turn = await f.conversation.submit({ type: "input", content: "Propose a save" }, background);
		assert.equal((await turn.wait(background)).status, "done");
		assert.equal((await f.harness.snapshot(ContextDoc, String(f.conversation.id), background))?.approvalCount, 64);
	} finally {
		await f.close();
	}
});
