import {
	AppError,
	type ConversationModel,
	parseRequest,
	type Receipt,
	type Scope,
	type Snapshot,
} from "../src/contracts.ts";
import { WorkRuntime } from "../src/core.ts";
import type { TransportRuntime } from "../src/transport-http.ts";
import { serveNodeIpc } from "../src/transport-ipc.ts";
import { deniedFeatureMutations, deniedFeatureReads } from "./feature-port-fixture.ts";

export function fixtureRuntime() {
	const receipts = new Map<string, { text: string; receipt: Receipt }>();
	let observers = 0;
	return new WorkRuntime({
		...deniedFeatureReads,
		storeId: "fixture-store",
		async getAgentCommandResult() {
			throw new AppError("UNAUTHORIZED");
		},
		async getConversation(scope) {
			return { ...scope, title: "One", revision: 1, createdAt: null, archivedAt: null };
		},
		async getConversationCommandResult() {
			return null;
		},
		async getWorkspace({ workspaceId }) {
			if (workspaceId !== "test") throw new AppError("NOT_FOUND");
			return { workspaceId, name: "Test" };
		},
		async listModels() {
			return {
				models: [{ provider: "faux", modelId: "faux-1", name: "Fixture" }],
				providers: [{ provider: "faux", name: "Fixture", credentialState: "configured" }],
			};
		},
		async listWorkspaces() {
			return { items: [{ workspaceId: "test", name: "Test" }], nextCursor: null };
		},
		async listConversations({ workspaceId }) {
			return {
				items: [
					{
						workspaceId,
						conversationId: "conversation",
						title: "One",
						revision: 1,
						createdAt: null,
						archivedAt: null,
					},
				],
				nextCursor: null,
			};
		},
		async close() {},
		async openWorkspace(workspaceId, name) {
			if (!name && workspaceId !== "test") throw new AppError("NOT_FOUND");
			const snapshot = (scope: Scope): Snapshot => ({
				...scope,
				messages: [],
				partial: String(observers),
				partialLength: String(observers).length,
				partialTruncated: false,
				historyCursor: null,
				running: false,
			});
			return {
				...deniedFeatureMutations,
				workspace: { workspaceId, name: name ?? "Test" },
				async getConversationModel(): Promise<ConversationModel> {
					return {
						model: { provider: "faux", modelId: "faux-1" },
						credentialState: "configured",
						executionState: "ready",
					};
				},
				async cancelExecution(): Promise<ConversationModel> {
					return {
						model: { provider: "faux", modelId: "faux-1" },
						credentialState: "configured",
						executionState: "ready",
					};
				},
				async continueWorkspace() {
					return { workspaceId, state: "authorized" as const };
				},
				async createConversation({ title }) {
					return {
						workspaceId,
						conversationId: "conversation",
						title,
						revision: 1,
						createdAt: null,
						archivedAt: null,
					};
				},
				async getConversation(scope) {
					return { ...scope, title: "One", revision: 1, createdAt: null, archivedAt: null };
				},
				async getConversationCommandResult() {
					return null;
				},
				async renameConversation() {
					throw new AppError("NOT_FOUND");
				},
				async archiveConversation() {
					throw new AppError("NOT_FOUND");
				},
				async restoreConversation() {
					throw new AppError("NOT_FOUND");
				},
				async getAgentCommandResult() {
					throw new AppError("UNAUTHORIZED");
				},
				async listActiveAgentContexts() {
					throw new AppError("UNAUTHORIZED");
				},
				async listPendingToolApprovals() {
					throw new AppError("UNAUTHORIZED");
				},
				async submit(input) {
					const prior = receipts.get(input.requestId);
					if (prior) {
						if (prior.text !== input.text) throw new AppError("IDEMPOTENCY_CONFLICT");
						return prior.receipt;
					}
					const receipt: Receipt = {
						workspaceId,
						conversationId: input.conversationId,
						requestId: input.requestId,
						receiptId: input.requestId,
						state: "accepted",
					};
					receipts.set(input.requestId, { text: input.text, receipt });
					await new Promise((resolve) => setTimeout(resolve, 50));
					receipt.state = "dispatched";
					return receipt;
				},
				async getReceipt(requestId) {
					return receipts.get(requestId)?.receipt ?? null;
				},
				async snapshot(scope) {
					return snapshot(scope);
				},
				async getHistory(scope) {
					return {
						workspaceId: scope.workspaceId,
						conversationId: scope.conversationId,
						messages: [],
						nextCursor: null,
					};
				},
				async getMessageText() {
					throw new AppError("NOT_FOUND");
				},
				async authorizeAgentContext() {
					throw new AppError("UNAUTHORIZED");
				},
				async authorizeRetainedContext() {
					throw new AppError("UNAUTHORIZED");
				},
				async revokeAgentContext() {
					throw new AppError("UNAUTHORIZED");
				},
				async listAgentContexts() {
					throw new AppError("UNAUTHORIZED");
				},
				async listToolApprovals() {
					throw new AppError("UNAUTHORIZED");
				},
				async decideToolApproval() {
					throw new AppError("UNAUTHORIZED");
				},
				async getFileOperation() {
					throw new AppError("UNAUTHORIZED");
				},
				async observe(scope, listener) {
					observers++;
					await listener({ kind: "snapshot", epoch: "epoch", version: 1, snapshot: snapshot(scope) });
					let disposed = false;
					return {
						async dispose() {
							if (!disposed) {
								disposed = true;
								observers--;
							}
						},
					};
				},
				async close() {},
			};
		},
	});
}
export function fixtureTransport(runtime: WorkRuntime): TransportRuntime {
	return {
		execute: (raw) => runtime.execute(raw),
		async observe(scope, listener, signal, onStatus) {
			const subscription = await runtime.observe(scope, listener, signal);
			const timer =
				scope.conversationId === "source-close"
					? setTimeout(() => onStatus?.({ state: "closed", reason: "error", code: "INTERNAL" }), 20)
					: undefined;
			return {
				async dispose() {
					clearTimeout(timer);
					await subscription.dispose();
				},
			};
		},
	};
}
if (process.send && process.argv.includes("--transport-fixture")) {
	const runtime = fixtureRuntime();
	const stop = serveNodeIpc(fixtureTransport(runtime));
	process.on("message", (message) => {
		if (message === "close-adapter") stop();
	});
	process.once("disconnect", () => {
		stop();
		void runtime.close();
	});
}
if (process.send && process.argv.includes("--protocol-admission-fixture")) {
	serveNodeIpc({
		async execute() {
			throw new Error("Protocol mismatch must be rejected before runtime admission");
		},
		async observe() {
			throw new Error("Protocol mismatch must not start an observation");
		},
	});
}
if (process.send && process.argv.includes("--snapshot-burst-fixture")) {
	const runtime = fixtureRuntime();
	const stop = serveNodeIpc({
		execute: (request) => runtime.execute(request),
		async observe(scope, listener) {
			for (let version = 1; version <= (scope.conversationId === "single" ? 1 : 10); version++) {
				await listener({
					kind: "snapshot",
					epoch: "burst",
					version,
					snapshot: {
						...scope,
						messages: [],
						partial: String(version),
						partialLength: String(version).length,
						partialTruncated: false,
						historyCursor: null,
						running: true,
					},
				});
			}
			return { async dispose() {} };
		},
	});
	process.once("disconnect", () => {
		stop();
		void runtime.close();
	});
}
if (process.send && process.argv.includes("--stale-protocol-fixture")) {
	const methods: string[] = [];
	process.on("message", (raw) => {
		if (raw === "received-methods") {
			process.send?.(JSON.stringify({ id: "inspection", kind: "result", result: methods }));
			return;
		}
		const message: unknown = JSON.parse(String(raw));
		if (!message || typeof message !== "object" || !("id" in message) || !("request" in message))
			throw new Error("Unexpected fixture message");
		methods.push(parseRequest(message.request).method);
		process.send?.(
			JSON.stringify({ id: message.id, kind: "result", result: { protocolVersion: 7, storeId: "old-store" } }),
		);
	});
}
