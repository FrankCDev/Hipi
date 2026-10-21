import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import type { Models } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type CheckpointInfo,
	type ConversationId,
	type ConversationView,
	defineDoc,
	defineDocFamily,
	Harness,
	LiveDoc,
	type LiveState,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { createWorkspaceModels } from "./agent-tools/model-gate.ts";
import { AgentToolBroker, agentRegistry } from "./agent-tools.ts";
import {
	AppError,
	type Conversation,
	type ConversationCommandResult,
	type ConversationModel,
	type Frame,
	fitsPayloadBudget,
	type HistoryPage,
	LIMITS,
	type MessageTextChunk,
	type ModelReference,
	type ObservationStatus,
	type Params,
	parseResult,
	type Receipt,
	type ReceiptView,
	type Scope,
	type Snapshot,
	type Submit,
	type Subscription,
	type Workspace,
} from "./contracts.ts";
import {
	assertConversationActive,
	ConversationDeliveryDoc,
	ConversationMetaDoc,
	type ConversationMetadata,
	commandKey,
	DIRECTORY_LIMITS,
	DirectoryCommandDoc,
	directoryDigest,
	publicConversation,
	recordDirectoryChange,
	SubmissionReceiptDoc,
	updateWorkspaceLive,
	WorkspaceHeaderDoc,
	WorkspaceLiveDoc,
} from "./conversation-directory.ts";
import { cancelWait, type WorkspacePort } from "./core.ts";
import { projectExecution } from "./execution/projection.ts";
import { ToolPackLifecycle } from "./extensions/lifecycle.ts";
import type { TrustedAgentFileService } from "./files/service.ts";
import { readHistory, readMessageText, textEnd, textOf, visibleEntry } from "./history.ts";
import { readModelFailureDetail } from "./model-failure.ts";
import type { CredentialPort } from "./model-provider.ts";
import { ConversationActivityDoc, changesNavigation } from "./navigation/activity.ts";
import type { NavigationInvalidation } from "./navigation/contracts.ts";
import { StreamIdentity } from "./stream-identity.ts";

type Catalog = {
	workspaceId: string;
	name: string;
	conversations: { publicId: string; durableId: number; title: string; count: number }[];
	requests: string[];
};
type StoredReceipt = Receipt & {
	text: string;
	fingerprint: string;
	mappedRequestId: string;
	durableConversationId: number;
	/** Original first acceptance time; absent on legacy receipts and never synthesized during replay. */
	acceptedAt?: number;
};
// Match the directory and authorization documents: at most 31 deltas per cold read.
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) => info.deltasSinceBase >= 31;
const CatalogDoc = defineDoc<Catalog>({
	kind: "hipi.workspace",
	scope: "session",
	version: 1,
	checkpointWhen,
	initial: () => ({ workspaceId: "", name: "", conversations: [], requests: [] }),
});
const ReceiptDoc = defineDocFamily<{ receipt?: StoredReceipt }, null>({
	kind: "hipi.receipt",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({}),
});
// This records cancellation intent, never an alternative PI task outcome.
const CancellationDoc = defineDoc<{ requested: boolean }>({
	kind: "hipi.cancellation",
	scope: "conversation",
	history: "latest",
	fork: "initial",
	version: 1,
	checkpointWhen,
	initial: () => ({ requested: false }),
});
export type Failpoint =
	| "after_accept"
	| "after_dispatch_mark"
	| "after_submit"
	| "after_cancel_intent"
	| "after_directory_commit"
	| "after_directory_migration_item";
export type PiWorkspaceOptions = {
	workspaceId: string;
	name?: string;
	models: Models;
	model?: ModelReference;
	credentials?: CredentialPort;
	agentFiles?: () => TrustedAgentFileService | undefined;
	resume?: boolean;
	failpoint?: (point: Failpoint) => Promise<void>;
	onError?: (error: unknown) => void;
	/** Synchronous invalidation only. Must not block or call Session APIs. */
	onNavigationChanged?: (metadata?: NavigationInvalidation) => void;
};
/** Diagnostics must never become an unhandled rejection or break writer teardown. */
function report(options: PiWorkspaceOptions, error: unknown): void {
	try {
		void Promise.resolve(options.onError?.(error)).catch(() => undefined);
	} catch {
		/* Diagnostics are isolated. */
	}
}
function receiptOf(record: StoredReceipt): Receipt {
	return {
		workspaceId: record.workspaceId,
		conversationId: record.conversationId,
		requestId: record.requestId,
		receiptId: record.receiptId,
		state: record.state,
		...(record.submissionId ? { submissionId: record.submissionId } : {}),
	};
}
export class WorkspaceShutdownFailed extends Error {
	constructor(cause: unknown) {
		super("Workspace shutdown could not be confirmed", { cause });
	}
}
/** PI is the only authority for execution and answers; documents record delivery only. */
export class PiWorkspace implements WorkspacePort {
	readonly workspace: Workspace;
	readonly #harness: Harness;
	readonly #options: PiWorkspaceOptions;
	readonly #agentTools: AgentToolBroker;
	readonly #toolPacks: ToolPackLifecycle;
	readonly #epoch = randomUUID();
	#dispatch: Promise<void> = Promise.resolve();
	readonly #scheduled = new Set<string>();
	#closed = false;
	#closing: Promise<void> | undefined;
	#observers = 0;
	#paused = false;
	#mutation: Promise<unknown> = Promise.resolve();
	readonly #stopNavigation: () => void;
	private constructor(
		harness: Harness,
		catalog: Workspace,
		options: PiWorkspaceOptions,
		agentTools: AgentToolBroker,
		toolPacks: ToolPackLifecycle,
		generation: string,
	) {
		this.#harness = harness;
		this.#options = options;
		this.#agentTools = agentTools;
		this.#toolPacks = toolPacks;
		this.workspace = Object.freeze({ workspaceId: catalog.workspaceId, name: catalog.name });
		const started = new Set<number>();
		this.#stopNavigation = harness.subscribeCommits((publication) => {
			if (!changesNavigation(publication, started)) return;
			try {
				const conversations: NavigationInvalidation["conversations"] = [];
				let reset = false,
					header = false;
				for (const change of publication.changes) {
					if (change.type !== "document" && change.type !== "document.copy") continue;
					if (change.record.kind === "hipi.workspace-directory") {
						header = true;
						if (change.type !== "document" || change.value?.generation !== generation) reset = true;
					}
					if (change.record.kind !== "hipi.conversation-metadata") continue;
					const value = change.type === "document" ? change.value?.value : undefined;
					if (!value || typeof value !== "object" || Array.isArray(value) || conversations.length >= 256) {
						reset = true;
						continue;
					}
					if (
						typeof value.durableId !== "number" ||
						!Number.isSafeInteger(value.durableId) ||
						value.durableId <= 0
					) {
						reset = true;
						continue;
					}
					conversations.push({
						generation,
						durableId: value.durableId,
						conversation: parseResult("getConversation", {
							workspaceId: value.workspaceId,
							conversationId: value.conversationId,
							title: value.title,
							revision: value.revision,
							createdAt: value.createdAt,
							archivedAt: value.archivedAt,
						}),
					});
				}
				options.onNavigationChanged?.(
					conversations.length || reset || header
						? { conversations, reset: reset || (header && conversations.length === 0) }
						: undefined,
				);
			} catch (error) {
				try {
					options.onNavigationChanged?.({ conversations: [], reset: true });
				} catch {
					/* Report the original failure. */
				}
				report(options, error);
			}
		});
	}
	static async open(storage: Storage, options: PiWorkspaceOptions): Promise<PiWorkspace> {
		const agentTools = new AgentToolBroker(
			options.workspaceId,
			options.agentFiles,
			async (tx, submissionIds, publicId) => {
				const result: string[] = [];
				for (const id of submissionIds) {
					const binding = await tx.doc(SubmissionReceiptDoc, id, null);
					if (!binding.receiptId) {
						for (const key of (await tx.doc(ConversationDeliveryDoc, publicId, null)).keys) {
							const receipt = (await tx.doc(ReceiptDoc, key, null)).receipt;
							if (!receipt) throw new AppError("INTERNAL");
							const submission = await tx.submissionByRequest(
								receipt.durableConversationId as ConversationId,
								receipt.mappedRequestId,
							);
							if (submission && String(submission.id) === id) {
								binding.receiptId = receipt.receiptId;
								binding.requestKey = key;
								break;
							}
						}
					}
					if (!binding.receiptId) throw new AppError("UNAUTHORIZED");
					result.push(binding.receiptId);
				}
				return result;
			},
			{
				assertConversationActive,
				auditGeneration: async (tx) => (await tx.doc(WorkspaceHeaderDoc)).generation,
				updateBrokerLive: (tx, publicId, active) => updateWorkspaceLive(tx, publicId, "broker", active),
			},
		);
		const registry = agentRegistry(agentTools);
		let workspace: PiWorkspace | undefined;
		const toolPacks = new ToolPackLifecycle(options.workspaceId, agentTools, registry, async (tx, id, publicId) => {
			const meta = (await tx.doc(ConversationMetaDoc, publicId, null)).value;
			if (!workspace || !meta || meta.durableId !== id) throw new AppError("UNAUTHORIZED");
			await workspace.#assertIdle(tx, meta);
		});
		agentTools.attachExtensions(toolPacks);
		let harness: Harness;
		try {
			harness = await Harness.open(
				storage,
				{
					models: createWorkspaceModels(options.models, agentTools),
					registry,
					conversationCreated: async (tx, record) => {
						await agentTools.conversationCreated(tx, record);
						await toolPacks.conversationCreated(tx, record);
					},
					settings: {
						extensions: [...registry.snapshot().installed()],
						...(options.credentials ? { retry: { enabled: false } } : {}),
					},
					onReport: (error) => report(options, error),
				},
				context,
			);
		} catch (error) {
			// Upstream may hide a failed cleanup behind its original open error. Do not assume ownership is released.
			throw new WorkspaceShutdownFailed(error);
		}
		try {
			agentTools.attach(harness);
			await toolPacks.recover();
			let header = await harness.snapshot(WorkspaceHeaderDoc, context);
			if (!header?.initialized) {
				const legacy = await harness.snapshot(CatalogDoc, context);
				if (!legacy && options.name === undefined) throw new AppError("NOT_FOUND");
				const identity = legacy ?? { workspaceId: options.workspaceId, name: options.name ?? "" };
				if (identity.workspaceId !== options.workspaceId) throw new AppError("NOT_FOUND");
				await harness.commit(async (tx) => {
					const doc = await tx.doc(WorkspaceHeaderDoc);
					doc.workspaceId = identity.workspaceId;
					doc.name = identity.name;
				}, context);
				for (const item of legacy?.conversations ?? []) {
					await harness.commit(async (tx) => {
						const doc = await tx.doc(ConversationMetaDoc, item.publicId, null);
						if (!doc.value) {
							const head = await tx.doc(WorkspaceHeaderDoc);
							doc.value = {
								workspaceId: identity.workspaceId,
								conversationId: item.publicId,
								durableId: item.durableId,
								title: item.title,
								ordinal: head.nextOrdinal++,
								revision: 1,
								createdAt: null,
								archivedAt: null,
							};
							head.activeCount++;
							await recordDirectoryChange(tx, doc.value);
						}
						await agentTools.migrateConversation(tx, item.durableId as ConversationId, item.publicId);
					}, context);
					await options.failpoint?.("after_directory_migration_item");
				}
				// Existing receipts remain authoritative. Migration rebuilds only their live references.
				for (const key of legacy?.requests ?? []) {
					await harness.commit(async (tx) => {
						const receipt = (await tx.doc(ReceiptDoc, key, null)).receipt;
						if (!receipt) throw new AppError("INTERNAL");
						const submission = await tx.submissionByRequest(
							receipt.durableConversationId as ConversationId,
							receipt.mappedRequestId,
						);
						if (submission) {
							const binding = await tx.doc(SubmissionReceiptDoc, String(submission.id), null);
							binding.receiptId = receipt.receiptId;
							binding.requestKey = key;
						}
						if (
							(submission && (submission.status === "queued" || submission.status === "placed")) ||
							(!submission && receipt.state !== "cancelled")
						) {
							const live = await tx.doc(ConversationDeliveryDoc, receipt.conversationId, null);
							if (!live.keys.includes(key)) live.keys.push(key);
							await updateWorkspaceLive(tx, receipt.conversationId, "receipts", true);
						}
					}, context);
				}
				await harness.commit(async (tx) => {
					for (const item of legacy?.conversations ?? []) {
						if ((await tx.doc(CancellationDoc, item.durableId as ConversationId)).requested)
							await updateWorkspaceLive(tx, item.publicId, "cancellation", true);
					}
					(await tx.doc(WorkspaceHeaderDoc)).initialized = true;
					// Retiring the old document preserves its history and prevents a second live catalog authority.
					if (legacy) await tx.retireDoc(CatalogDoc);
				}, context);
				header = await harness.snapshot(WorkspaceHeaderDoc, context);
			}
			if (!header || header.workspaceId !== options.workspaceId) throw new AppError("NOT_FOUND");
			if (options.name !== undefined && header.name !== options.name) throw new AppError("IDEMPOTENCY_CONFLICT");
			workspace = new PiWorkspace(harness, header, options, agentTools, toolPacks, header.generation);
			const live = await harness.snapshot(WorkspaceLiveDoc, context);
			for (const item of live?.items ?? []) {
				const meta = await workspace.#metadata({ workspaceId: header.workspaceId, conversationId: item.publicId });
				if (item.broker) await agentTools.recover(meta.durableId as ConversationId);
				for (const key of (await harness.snapshot(ConversationDeliveryDoc, item.publicId, context))?.keys ?? [])
					await workspace.#reconcile(key);
				await workspace.#applyCancellation(meta.durableId as ConversationId);
				const currentWorkspace = workspace;
				await harness.commit((tx) => currentWorkspace.#refreshDelivery(tx, item.publicId), context);
			}
			if (options.credentials || !options.resume) {
				const inspection = await harness.inspect(context);
				workspace.#paused =
					inspection.tasks.length > 0 ||
					inspection.submissions.length > 0 ||
					(await workspace.#liveKeys()).length > 0;
			}
			if (options.resume && !options.credentials) {
				for (const key of await workspace.#liveKeys()) workspace.#schedule(key);
				harness.resume();
			}
			return workspace;
		} catch (error) {
			if (workspace) workspace.#stopNavigation();
			try {
				await harness.close(context);
			} catch (failure) {
				throw new WorkspaceShutdownFailed(failure);
			}
			throw error;
		}
	}
	async #metadata(scope: Scope): Promise<ConversationMetadata> {
		if (this.#closed) throw new AppError("CLOSED");
		if (scope.workspaceId !== this.workspace.workspaceId) throw new AppError("NOT_FOUND");
		const value = (await this.#harness.snapshot(ConversationMetaDoc, scope.conversationId, context))?.value;
		if (!value || value.workspaceId !== scope.workspaceId) throw new AppError("NOT_FOUND");
		return value;
	}
	async #conversation(scope: Scope) {
		const metadata = await this.#metadata(scope);
		const conversation = await this.#harness.conversation(metadata.durableId as ConversationId, context);
		if (!conversation) throw new AppError("NOT_FOUND");
		return conversation;
	}
	async getConversation(scope: Scope): Promise<Conversation> {
		return publicConversation(await this.#metadata(scope));
	}
	async getConversationCommandResult(
		input: Params<"getConversationCommandResult">,
	): Promise<ConversationCommandResult | null> {
		if (input.workspaceId !== this.workspace.workspaceId) throw new AppError("NOT_FOUND");
		return (
			(await this.#harness.snapshot(DirectoryCommandDoc, commandKey(input.workspaceId, input.requestId), context))
				?.value ?? null
		);
	}
	createConversation(input: Params<"createConversation">): Promise<Conversation> {
		return this.#serialize(async () => {
			if (input.workspaceId !== this.workspace.workspaceId) throw new AppError("NOT_FOUND");
			const key = commandKey(input.workspaceId, input.requestId);
			const digest = directoryDigest("createConversation", input);
			const prior = await this.#harness.snapshot(DirectoryCommandDoc, key, context);
			if (prior?.value) {
				if (prior.digest !== digest) throw new AppError("IDEMPOTENCY_CONFLICT");
				return prior.value.result;
			}
			const model = input.model ?? this.#options.model;
			if (!model || !this.#options.models.getModel(model.provider, model.modelId))
				throw new AppError("MODEL_UNAVAILABLE");
			const publicId = randomUUID();
			await this.#harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model },
					init: async (tx, id) => {
						const head = await tx.doc(WorkspaceHeaderDoc);
						if (head.activeCount >= DIRECTORY_LIMITS.activeConversations) throw new AppError("CAPACITY_EXCEEDED");
						const meta: ConversationMetadata = {
							workspaceId: input.workspaceId,
							conversationId: publicId,
							durableId: id,
							title: input.title,
							ordinal: head.nextOrdinal++,
							revision: 1,
							createdAt: Date.now(),
							archivedAt: null,
						};
						(await tx.doc(ConversationMetaDoc, publicId, null)).value = meta;
						head.activeCount++;
						await this.#agentTools.register(tx, id, publicId);
						await this.#toolPacks.register(tx, id, publicId);
						await recordDirectoryChange(tx, meta);
						const command = await tx.doc(DirectoryCommandDoc, key, null);
						command.digest = digest;
						command.value = { method: "createConversation", result: publicConversation(meta) };
					},
				},
				context,
			);
			await this.#options.failpoint?.("after_directory_commit");
			return this.getConversation({ workspaceId: input.workspaceId, conversationId: publicId });
		});
	}
	renameConversation(input: Params<"renameConversation">): Promise<Conversation> {
		return this.#changeConversation("renameConversation", input);
	}
	archiveConversation(input: Params<"archiveConversation">): Promise<Conversation> {
		return this.#changeConversation("archiveConversation", input);
	}
	restoreConversation(input: Params<"restoreConversation">): Promise<Conversation> {
		return this.#changeConversation("restoreConversation", input);
	}
	#changeConversation(
		method: "renameConversation" | "archiveConversation" | "restoreConversation",
		input: Params<"renameConversation"> | Params<"archiveConversation"> | Params<"restoreConversation">,
	): Promise<Conversation> {
		return this.#serialize(async () => {
			const meta = await this.#metadata(input);
			let invalidatedBindings: string[] = [];
			const result = await this.#agentTools.locked(meta.durableId, () =>
				this.#harness.commit(async (tx) => {
					const command = await tx.doc(DirectoryCommandDoc, commandKey(input.workspaceId, input.requestId), null);
					const digest = directoryDigest(method, input);
					if (command.value) {
						if (command.digest !== digest) throw new AppError("IDEMPOTENCY_CONFLICT");
						return { ...command.value.result };
					}
					const record = await tx.doc(ConversationMetaDoc, input.conversationId, null);
					const value = record.value;
					if (!value) throw new AppError("NOT_FOUND");
					if (value.revision !== input.expectedRevision) throw new AppError("IDEMPOTENCY_CONFLICT");
					const header = await tx.doc(WorkspaceHeaderDoc);
					if (method === "renameConversation" && "title" in input) value.title = input.title;
					if (method === "archiveConversation" && value.archivedAt === null) {
						await this.#assertIdle(tx, value);
						await this.#agentTools.archiveInTransaction(tx, value.durableId as ConversationId);
						invalidatedBindings = await this.#toolPacks.archive(tx, value.durableId as ConversationId);
						value.archivedAt = Date.now();
						header.activeCount--;
					}
					if (method === "restoreConversation" && value.archivedAt !== null) {
						if (header.activeCount >= DIRECTORY_LIMITS.activeConversations)
							throw new AppError("CAPACITY_EXCEEDED");
						value.archivedAt = null;
						header.activeCount++;
					}
					value.revision++;
					await recordDirectoryChange(tx, value);
					command.digest = digest;
					command.value = { method, result: publicConversation(value) };
					return { ...command.value.result };
				}, context),
			);
			this.#toolPacks.clearTimers(invalidatedBindings);
			await this.#options.failpoint?.("after_directory_commit");
			return result;
		});
	}
	async #assertIdle(tx: Tx, meta: ConversationMetadata): Promise<void> {
		await this.#refreshDelivery(tx, meta.conversationId);
		const delivery = await tx.doc(ConversationDeliveryDoc, meta.conversationId, null);
		if (delivery.keys.length) throw new AppError("CONVERSATION_BUSY");
		const id = meta.durableId as ConversationId;
		if ((await tx.doc(LiveDoc, id)).run) throw new AppError("CONVERSATION_BUSY");
		for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
			if ((await tx.scanTasks({ conversationId: id, status }, 1)).items.length)
				throw new AppError("CONVERSATION_BUSY");
		}
		(await tx.doc(CancellationDoc, id)).requested = false;
		await updateWorkspaceLive(tx, meta.conversationId, "cancellation", false);
	}
	async #liveKeys(): Promise<string[]> {
		const result: string[] = [];
		for (const item of (await this.#harness.snapshot(WorkspaceLiveDoc, context))?.items ?? []) {
			if (!item.receipts) continue;
			result.push(...((await this.#harness.snapshot(ConversationDeliveryDoc, item.publicId, context))?.keys ?? []));
		}
		return result;
	}
	async #refreshDelivery(tx: Tx, publicId: string): Promise<void> {
		const live = await tx.doc(ConversationDeliveryDoc, publicId, null);
		const remaining: string[] = [];
		for (const key of live.keys) {
			const receipt = (await tx.doc(ReceiptDoc, key, null)).receipt;
			if (!receipt) throw new AppError("INTERNAL");
			const submission = await tx.submissionByRequest(
				receipt.durableConversationId as ConversationId,
				receipt.mappedRequestId,
			);
			if (submission) {
				const binding = await tx.doc(SubmissionReceiptDoc, String(submission.id), null);
				binding.receiptId = receipt.receiptId;
				binding.requestKey = key;
				if (submission.status === "queued" || submission.status === "placed") remaining.push(key);
			} else if (receipt.state !== "cancelled") remaining.push(key);
		}
		live.keys = remaining;
		await updateWorkspaceLive(tx, publicId, "receipts", remaining.length > 0);
	}

	async getConversationModel(scope: Scope): Promise<ConversationModel> {
		const conversation = await this.#conversation(scope);
		const agent = await this.#harness.snapshot(AgentDoc, conversation.id, context);
		if (!agent?.model) throw new AppError("MODEL_UNAVAILABLE");
		const model = { provider: agent.model.provider, modelId: agent.model.modelId };
		const available = this.#options.models.getModel(model.provider, model.modelId) !== undefined;
		const state = await this.snapshot(scope);
		const cancellation = await this.#harness.snapshot(CancellationDoc, conversation.id, context);
		const inspection = this.#paused && cancellation?.requested ? await this.#harness.inspect(context) : undefined;
		const cancellationPending =
			inspection?.tasks.some(({ record }) => record.conversationId === conversation.id) ||
			inspection?.submissions.some((record) => record.conversationId === conversation.id);
		return {
			model,
			credentialState: !available
				? "unavailable"
				: this.#options.credentials
					? await this.#options.credentials.status(model.provider).catch(() => "unavailable" as const)
					: "configured",
			executionState: this.#paused
				? cancellationPending
					? "cancellation_pending"
					: "paused"
				: state.running
					? "running"
					: "ready",
		};
	}
	async authorizeAgentContext(input: Params<"authorizeAgentContext">) {
		return this.#agentTools.authorize((await this.#conversation(input)).id, input);
	}
	installToolPack(input: Params<"installToolPack">) {
		return this.#toolPacks.install(input);
	}
	setToolPackEnabled(input: Params<"setToolPackEnabled">) {
		return this.#serialize(() => this.#toolPacks.change("setToolPackEnabled", input));
	}
	uninstallToolPack(input: Params<"uninstallToolPack">) {
		return this.#serialize(() => this.#toolPacks.change("uninstallToolPack", input));
	}
	async bindToolPack(input: Params<"bindToolPack">) {
		return this.#serialize(async () => this.#toolPacks.bind((await this.#conversation(input)).id, input));
	}
	async authorizeRetainedToolPack(input: Params<"authorizeRetainedToolPack">) {
		return this.#serialize(async () => this.#toolPacks.bind((await this.#conversation(input)).id, input));
	}
	async revokeToolPackBinding(input: Params<"revokeToolPackBinding">) {
		return this.#serialize(async () => this.#toolPacks.revoke((await this.#conversation(input)).id, input));
	}
	async authorizeRetainedContext(input: Params<"authorizeRetainedContext">) {
		return this.#agentTools.authorizeRetained((await this.#conversation(input)).id, input);
	}
	async revokeAgentContext(input: Params<"revokeAgentContext">) {
		return this.#agentTools.revoke((await this.#conversation(input)).id, input);
	}
	async listAgentContexts(input: Params<"listAgentContexts">) {
		return this.#agentTools.contexts((await this.#conversation(input)).id, input.cursor);
	}
	async listActiveAgentContexts(input: Params<"listActiveAgentContexts">) {
		return this.#agentTools.activeContexts((await this.#conversation(input)).id);
	}
	async listPendingToolApprovals(input: Params<"listPendingToolApprovals">) {
		return this.#agentTools.pendingApprovals((await this.#conversation(input)).id, input.cursor);
	}
	async getAgentCommandResult(input: Params<"getAgentCommandResult">) {
		return this.#agentTools.commandResult((await this.#conversation(input)).id, input.requestId);
	}
	async listToolApprovals(input: Params<"listToolApprovals">) {
		return this.#agentTools.approvals((await this.#conversation(input)).id, input.cursor);
	}
	async decideToolApproval(input: Params<"decideToolApproval">) {
		return this.#agentTools.decide((await this.#conversation(input)).id, input);
	}
	async getFileOperation(input: Params<"getFileOperation">) {
		return this.#agentTools.operation((await this.#conversation(input)).id, input);
	}
	async #checkCredentials(scope: Scope): Promise<void> {
		const conversation = await this.#conversation(scope);
		const agent = await this.#harness.snapshot(AgentDoc, conversation.id, context);
		const model = agent?.model;
		if (!model || !this.#options.models.getModel(model.provider, model.modelId))
			throw new AppError("MODEL_UNAVAILABLE");
		if (
			this.#options.credentials &&
			(await this.#options.credentials.status(model.provider).catch(() => "unavailable" as const)) !== "configured"
		)
			throw new AppError("CREDENTIAL_REQUIRED");
	}
	continueWorkspace(): Promise<{ workspaceId: string; state: "authorized" }> {
		return this.#serialize(() => this.#continueWorkspace());
	}
	async #continueWorkspace(): Promise<{ workspaceId: string; state: "authorized" }> {
		const live = await this.#harness.snapshot(WorkspaceLiveDoc, context);
		for (const item of live?.items ?? []) {
			if (!item.receipts && !item.cancellation) continue;
			await this.#checkCredentials({ workspaceId: this.workspace.workspaceId, conversationId: item.publicId });
		}
		// Complete persisted cancellation intents before any call can enable scheduling.
		for (const item of live?.items ?? []) {
			const meta = await this.#metadata({ workspaceId: this.workspace.workspaceId, conversationId: item.publicId });
			await this.#applyCancellation(meta.durableId as ConversationId);
		}
		this.#paused = false;
		for (const key of await this.#liveKeys()) this.#schedule(key);
		this.#harness.resume();
		return { workspaceId: this.workspace.workspaceId, state: "authorized" };
	}
	cancelExecution(scope: Scope): Promise<ConversationModel> {
		return this.#serialize(() => this.#cancelExecution(scope));
	}
	async #cancelExecution(scope: Scope): Promise<ConversationModel> {
		const conversation = await this.#conversation(scope);
		await this.#agentTools.cancel(conversation.id);
		if (this.#paused) {
			// Persist the intent and delivery withdrawals atomically. A crash before PI marks is
			// repaired on open/continue; no scheduler or provider is needed to request cancellation.
			await this.#harness.commit(async (tx) => {
				(await tx.doc(CancellationDoc, conversation.id)).requested = true;
				await updateWorkspaceLive(tx, scope.conversationId, "cancellation", true);
				for (const key of (await tx.doc(ConversationDeliveryDoc, scope.conversationId, null)).keys) {
					const receipt = (await tx.doc(ReceiptDoc, key, null)).receipt;
					if (
						receipt?.durableConversationId === conversation.id &&
						(receipt.state === "accepted" || receipt.state === "dispatching")
					)
						receipt.state = "cancelled";
				}
			}, context);
			await this.#options.failpoint?.("after_cancel_intent");
			await this.#applyCancellation(conversation.id);
			return this.getConversationModel(scope);
		}
		await this.#dispatch;
		await conversation.abort(context, { background: true });
		return await this.getConversationModel(scope);
	}
	async #applyCancellation(conversationId: ConversationId): Promise<void> {
		if (!(await this.#harness.snapshot(CancellationDoc, conversationId, context))?.requested) return;
		const inspection = await this.#harness.inspect(context);
		// Unlike Conversation.abort(), these APIs never resume the workspace. PI owns the
		// durable marks, descendant cascade, and eventual cleanup when continuation is authorized.
		for (const { record } of inspection.tasks) {
			if (record.conversationId === conversationId) await this.#harness.abortTask(record.id, context);
		}
		for (const submission of inspection.submissions) {
			if (submission.conversationId === conversationId && submission.status === "queued")
				await this.#harness.abortSubmission(submission.id, context, conversationId);
		}
	}
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#mutation.then(operation);
		this.#mutation = result.catch(() => undefined);
		return result;
	}
	submit(input: Submit): Promise<Receipt> {
		return this.#serialize(() => this.#submit(input));
	}
	async #submit(input: Submit): Promise<Receipt> {
		if (input.workspaceId !== this.workspace.workspaceId) throw new AppError("NOT_FOUND");
		const fingerprint = createHash("sha256")
			.update(JSON.stringify([1, input.conversationId, input.text, "followUp"]))
			.digest("hex");
		// Owner identity is supplied by the trusted local host, never by the wire body.
		const key = createHash("sha256")
			.update(JSON.stringify(["local-owner", this.workspace.workspaceId, "submit", input.requestId]))
			.digest("hex");
		const prior = (await this.#harness.snapshot(ReceiptDoc, key, context))?.receipt;
		if (prior) {
			if (prior.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT");
			return receiptOf(prior);
		}
		if (this.#paused) throw new AppError("RESUME_REQUIRED");
		if ((await this.#metadata(input)).archivedAt !== null) throw new AppError("CONVERSATION_ARCHIVED");
		await this.#agentTools.assertContext((await this.#conversation(input)).id);
		await this.#checkCredentials(input);
		const conversation = await this.#conversation(input);
		const receipt = await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ReceiptDoc, key, null);
			if (doc.receipt) {
				if (doc.receipt.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT");
				return receiptOf(doc.receipt);
			}
			await assertConversationActive(tx, input.conversationId);
			await this.#refreshDelivery(tx, input.conversationId);
			const live = await tx.doc(ConversationDeliveryDoc, input.conversationId, null);
			if (live.keys.length >= DIRECTORY_LIMITS.pendingReceipts) throw new AppError("CAPACITY_EXCEEDED");
			live.keys.push(key);
			await updateWorkspaceLive(tx, input.conversationId, "receipts", true);
			await updateWorkspaceLive(tx, input.conversationId, "cancellation", false);
			// A new explicitly submitted request supersedes the previous cancellation intent.
			// Existing PI abort marks and withdrawn receipts remain authoritative.
			(await tx.doc(CancellationDoc, conversation.id)).requested = false;
			await this.#agentTools.submitted(tx, conversation.id);
			const activity = await tx.doc(ConversationActivityDoc, input.conversationId, null);
			if (
				activity.latestAcceptedAt !== null &&
				(!Number.isSafeInteger(activity.latestAcceptedAt) || activity.latestAcceptedAt < 0)
			)
				throw new AppError("STORE_MISMATCH");
			const acceptedAt = Date.now();
			activity.latestAcceptedAt = Math.max(activity.latestAcceptedAt ?? acceptedAt, acceptedAt);
			doc.receipt = {
				...input,
				receiptId: randomUUID(),
				state: "accepted",
				fingerprint,
				mappedRequestId: key,
				durableConversationId: conversation.id,
				acceptedAt,
			};
			return receiptOf(doc.receipt);
		}, context);
		await this.#options.failpoint?.("after_accept");
		this.#schedule(key);
		return receipt;
	}
	#schedule(key: string): void {
		if (this.#scheduled.has(key)) return;
		// One queued closure per admitted receipt; admission bounds receipts to this capacity.
		if (this.#scheduled.size >= DIRECTORY_LIMITS.liveConversations * DIRECTORY_LIMITS.pendingReceipts)
			throw new AppError("CAPACITY_EXCEEDED");
		this.#scheduled.add(key);
		this.#dispatch = this.#dispatch
			.then(() => this.#deliver(key))
			.catch((error) => report(this.#options, error))
			.finally(() => {
				this.#scheduled.delete(key);
			});
	}

	async #reconcile(key: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const record = await tx.doc(ReceiptDoc, key, null);
			const receipt = record.receipt;
			if (!receipt || receipt.state !== "dispatching") return;
			const submission = await tx.submissionByRequest(
				receipt.durableConversationId as ConversationId,
				receipt.mappedRequestId,
			);
			if (submission) {
				receipt.submissionId = String(submission.id);
				receipt.state = "dispatched";
				const binding = await tx.doc(SubmissionReceiptDoc, String(submission.id), null);
				binding.receiptId = receipt.receiptId;
				binding.requestKey = key;
			}
		}, context);
	}
	async #deliver(key: string): Promise<void> {
		await this.#reconcile(key);
		const saved = await this.#harness.snapshot(ReceiptDoc, key, context);
		if (
			!saved?.receipt ||
			saved.receipt.state === "dispatched" ||
			saved.receipt.state === "reconciliation_required" ||
			saved.receipt.state === "cancelled"
		)
			return;
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ReceiptDoc, key, null);
			if (doc.receipt) doc.receipt.state = "dispatching";
		}, context);
		await this.#options.failpoint?.("after_dispatch_mark");
		await this.#checkCredentials(saved.receipt);
		const conversation = await this.#conversation(saved.receipt);
		const submission = await conversation.submit(
			{ type: "input", content: saved.receipt.text, requestId: saved.receipt.mappedRequestId, whenBusy: "followUp" },
			context,
		);
		await this.#options.failpoint?.("after_submit");
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ReceiptDoc, key, null);
			if (doc.receipt) {
				doc.receipt.state = "dispatched";
				doc.receipt.submissionId = String(submission.id);
				const binding = await tx.doc(SubmissionReceiptDoc, String(submission.id), null);
				binding.receiptId = doc.receipt.receiptId;
				binding.requestKey = key;
			}
		}, context);
	}
	async getReceipt(requestId: string): Promise<ReceiptView | null> {
		const key = createHash("sha256")
			.update(JSON.stringify(["local-owner", this.workspace.workspaceId, "submit", requestId]))
			.digest("hex");
		const saved = await this.#harness.snapshot(ReceiptDoc, key, context);
		if (!saved?.receipt) return null;
		const receipt = saved.receipt;
		const record = await this.#harness.commit(
			(tx) => tx.submissionByRequest(receipt.durableConversationId as ConversationId, receipt.mappedRequestId),
			context,
		);
		const result: ReceiptView = receiptOf(receipt);
		if (record) {
			result.execution = record.status;
			if (record.status === "unanswered") {
				const end = textEnd(record.reason, 0, LIMITS.messagePreview);
				result.reason = record.reason.slice(0, end);
				result.reasonLength = record.reason.length;
				result.reasonTruncated = end < record.reason.length;
				if (record.reason === "model_error") {
					const failure = readModelFailureDetail(record.detail);
					if (failure) result.modelFailure = failure;
				}
			}
			if (record.status === "done" && record.type === "input") {
				const conversation = await this.#conversation(receipt);
				const entry = await visibleEntry(conversation, record.answer);
				if (entry) {
					let preview = "";
					let length = 0;
					let count = 0;
					for (const message of entry.model ?? []) {
						if (message.role !== "user" && message.role !== "assistant") continue;
						const text = textOf(message);
						const separator = count++ ? "\n" : "";
						length += separator.length + text.length;
						if (preview.length < LIMITS.messagePreview)
							preview += (separator + text).slice(0, LIMITS.messagePreview - preview.length + 1);
					}
					const end = textEnd(preview, 0, LIMITS.messagePreview);
					result.answer = preview.slice(0, end);
					result.answerLength = length;
					result.answerTruncated = end < length;
					result.answerEntryId = String(entry.id);
				}
			}
		}
		return result;
	}
	async getHistory(input: Params<"getHistory">): Promise<HistoryPage> {
		return readHistory(
			await this.#conversation(input),
			{ workspaceId: input.workspaceId, conversationId: input.conversationId },
			input.cursor,
		);
	}
	async getMessageText(input: Params<"getMessageText">): Promise<MessageTextChunk> {
		return readMessageText(
			await this.#conversation(input),
			{ workspaceId: input.workspaceId, conversationId: input.conversationId },
			input.messageId,
			input.offset,
		);
	}
	#project(scope: Scope, view: ConversationView, history: HistoryPage): Snapshot {
		const live = view.docs["pi.live"] as LiveState | undefined;
		const message = live?.generation?.message;
		const partial = message ? textOf(message) : "";
		const end = textEnd(partial, 0, LIMITS.partialPreview);
		const execution = projectExecution(live, view);
		return {
			...scope,
			...(execution ? { execution } : {}),
			messages: history.messages,
			historyCursor: history.nextCursor,
			partial: partial.slice(0, end),
			partialLength: partial.length,
			partialTruncated: end < partial.length,
			running: !this.#paused && Boolean(live?.run),
		};
	}
	async snapshot(scope: Scope): Promise<Snapshot> {
		const conversation = await this.#conversation(scope);
		const watch = await conversation.watch(context);
		try {
			const view = watch.value;
			const upper = view.entries.reduce((max, entry) => Math.max(max, entry.id), 0);
			const history = upper
				? await readHistory(conversation, scope, undefined, upper)
				: { ...scope, messages: [], nextCursor: null };
			return this.#project(scope, view, history);
		} finally {
			await watch.stop();
		}
	}
	async observe(
		scope: Scope,
		listener: (frame: Frame) => void | Promise<void>,
		signal?: AbortSignal,
		onStatus?: (status: ObservationStatus) => void,
	): Promise<Subscription> {
		if (signal?.aborted) throw signal.reason;
		if (this.#observers >= 16) throw new AppError("CAPACITY_EXCEEDED");
		this.#observers++;
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		let released = false;
		let identity: StreamIdentity | undefined;
		const release = () => {
			if (released) return;
			released = true;
			identity?.dispose();
			this.#observers--;
			signal?.removeEventListener("abort", abort);
			controller.abort();
		};
		try {
			const conversation = await this.#conversation(scope);
			const watch = await conversation.watch({ ...context, abortSignal: controller.signal });
			identity = new StreamIdentity(conversation.id);
			let cachedUpper = -1;
			let cachedHistory: HistoryPage = { ...scope, messages: [], nextCursor: null };
			let version = 0;
			let listenerFailed = false;
			void watch.closed.then((end) => {
				const reason =
					listenerFailed || end.reason === "listener_error" || end.reason === "session_failed"
						? "error"
						: signal?.aborted || released
							? "disposed"
							: "disconnected";
				release();
				try {
					void Promise.resolve(
						onStatus?.({ state: "closed", reason, ...(reason === "error" ? { code: "INTERNAL" as const } : {}) }),
					).catch(() => undefined);
				} catch {
					/* Consumer diagnostics cannot retain a watch. */
				}
			});
			const emit = async (view: ConversationView, ops?: readonly Op[]) => {
				if (released || controller.signal.aborted) return;
				// Head markers are prepended, so the last active entry is not necessarily the newest ID.
				const upper = view.entries.reduce((max, entry) => Math.max(max, entry.id), 0);
				if (upper !== cachedUpper) {
					cachedHistory = upper
						? await readHistory(conversation, scope, undefined, upper)
						: { ...scope, messages: [], nextCursor: null };
					cachedUpper = upper;
				}
				if (released || controller.signal.aborted) return;
				const frame: Frame = {
					kind: "snapshot",
					epoch: this.#epoch,
					version: ++version,
					snapshot: {
						...this.#project(scope, view, cachedHistory),
						...identity?.project(view, cachedHistory, ops),
					},
				};
				if (!fitsPayloadBudget(frame)) throw new AppError("CAPACITY_EXCEEDED");
				await cancelWait(Promise.resolve(listener(frame)), controller.signal);
			};
			// Install lifecycle before the first asynchronous callback; a hung consumer cannot hold ownership.
			const initial = emit(watch.value).catch((error) => {
				if (!controller.signal.aborted) {
					listenerFailed = true;
					report(this.#options, error);
				}
				void watch.stop();
			});
			watch.start(async (view, ops) => {
				await initial;
				await emit(view, ops);
			});
			return {
				dispose: async () => {
					release();
					await watch.stop();
				},
			};
		} catch (error) {
			release();
			throw error;
		}
	}

	/** Caller must hold its admission lease until close; this never resumes or mutates execution. */
	async canEvict(): Promise<boolean> {
		if (this.#closed || this.#closing || this.#observers > 0 || this.#scheduled.size > 0) return false;
		if (await this.#toolPacks.hasLive()) return false;
		const inspection = await this.#harness.inspect(context);
		if (inspection.tasks.length > 0 || inspection.submissions.length > 0) return false;
		const live = await this.#harness.snapshot(WorkspaceLiveDoc, context);
		for (const item of live?.items ?? []) {
			if (item.broker) return false;
			for (const key of (await this.#harness.snapshot(ConversationDeliveryDoc, item.publicId, context))?.keys ??
				[]) {
				const receipt = (await this.#harness.snapshot(ReceiptDoc, key, context))?.receipt;
				if (!receipt) return false;
				const submission = await this.#harness.commit(
					(tx) => tx.submissionByRequest(receipt.durableConversationId as ConversationId, receipt.mappedRequestId),
					context,
				);
				if (
					submission
						? submission.status === "queued" || submission.status === "placed"
						: receipt.state !== "cancelled"
				)
					return false;
			}
		}
		return true;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closing ??= (async () => {
			this.#toolPacks.close();
			this.#agentTools.close();
			try {
				await this.#dispatch;
			} finally {
				try {
					await this.#harness.close(context);
				} finally {
					this.#stopNavigation();
				}
			}
			this.#closed = true;
		})();
		try {
			await this.#closing;
		} catch (error) {
			this.#closing = undefined;
			throw error;
		}
	}
}
