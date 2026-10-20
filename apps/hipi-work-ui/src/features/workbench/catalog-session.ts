import {
	type AppClient,
	AppError,
	type Conversation,
	type ErrorCode,
	type ReceiptView,
	type Submit,
	type Workspace,
} from "@hipi/work-runtime/contracts";
import type { CatalogCommand } from "./command-recovery.ts";
import {
	admitInitialSend,
	currentInitialSend,
	defaultChatWorkspaceId,
	finishInitialConversation,
	finishInitialWorkspace,
	type InitialSend,
	type InitialSendInput,
	transferInitialSubmission,
} from "./initial-send.ts";
import type { LocalState } from "./local-state.ts";
import { canExecuteModel } from "./model-policy.ts";
import {
	admitCatalog,
	currentCatalogRecovery,
	finishCatalog,
	type PreparedTask,
	readCatalogRecovery,
} from "./prepared-task.ts";
import { reconcileReceipt } from "./receipt-reconciliation.ts";
import { submitRequest } from "./submit-request.ts";

export type CatalogState = {
	pending: CatalogCommand | null;
	incompatible: boolean;
	busy: boolean;
	failed: boolean;
	notFound: boolean;
	result: Conversation | Workspace | null;
	resultMethod: CatalogCommand["method"] | null;
	preparedTask: PreparedTask | null;
	handoffConflict: boolean;
	initialSend: InitialSend | null;
	submission: Submit | null;
	receipt: ReceiptView | null;
	errorCode: ErrorCode | null;
};
/** Owns immutable directory commands. A lost reply is resolved by exact read-only lookup. */
export class CatalogSession {
	private state: CatalogState;
	private listeners = new Set<() => void>();
	private request: AbortController | undefined;
	private disposed = false;
	private client: AppClient;
	private local: LocalState;
	constructor(client: AppClient, local: LocalState) {
		this.client = client;
		this.local = local;
		const saved = readCatalogRecovery(local.read("command.catalog"));
		this.state = {
			pending: saved.request,
			incompatible: saved.incompatible,
			busy: false,
			failed: false,
			notFound: false,
			result: null,
			resultMethod: null,
			preparedTask: saved.preparedTask,
			handoffConflict: false,
			initialSend: saved.initialSend,
			submission: null,
			receipt: null,
			errorCode: null,
		};
	}
	getSnapshot = () => this.state;
	defaultWorkspaceId = () => defaultChatWorkspaceId(this.local);
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private publish(patch: Partial<CatalogState>) {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	activate() {
		this.disposed = false;
	}
	dispose() {
		this.disposed = true;
		this.request?.abort();
		this.request = undefined;
		this.listeners.clear();
	}
	private async run(work: (signal: AbortSignal) => Promise<void>) {
		if (this.disposed || this.request || this.state.incompatible) return;
		const controller = new AbortController();
		this.request = controller;
		const timeout = setTimeout(() => controller.abort(), 15000);
		this.publish({ busy: true, failed: false, notFound: false, result: null, errorCode: null });
		let stopWaiting: (() => void) | undefined;
		try {
			await Promise.race([
				work(controller.signal),
				new Promise<never>((_, reject) => {
					stopWaiting = () => reject(new Error("WAIT_ABORTED"));
					controller.signal.addEventListener("abort", stopWaiting, { once: true });
				}),
			]);
		} catch (error) {
			if (this.request === controller) {
				const recovery = readCatalogRecovery(this.local.read("command.catalog"));
				this.publish({
					failed: true,
					incompatible: recovery.incompatible,
					preparedTask: recovery.preparedTask,
					initialSend: recovery.initialSend,
					pending: recovery.request,
					errorCode: error instanceof AppError ? error.code : null,
				});
			}
		} finally {
			clearTimeout(timeout);
			if (stopWaiting) controller.signal.removeEventListener("abort", stopWaiting);
			if (this.request === controller) {
				this.request = undefined;
				this.publish({ busy: false });
			}
		}
	}
	private async finish(
		command: CatalogCommand,
		result: Workspace | Conversation,
		signal: AbortSignal,
		discardPreparedTask = false,
	) {
		signal.throwIfAborted();
		if (result.workspaceId !== command.params.workspaceId) throw new Error("SCOPE_MISMATCH");
		if (command.method === "createWorkspace") {
			if (!("name" in result) || result.name !== command.params.name) throw new Error("COMMAND_MISMATCH");
		} else {
			if (!("conversationId" in result)) throw new Error("COMMAND_MISMATCH");
			if (command.method !== "createConversation" && result.conversationId !== command.params.conversationId)
				throw new Error("COMMAND_MISMATCH");
			if (
				(command.method === "createConversation" || command.method === "renameConversation") &&
				result.title !== command.params.title
			)
				throw new Error("COMMAND_MISMATCH");
			if (command.method !== "createConversation" && result.revision <= command.params.expectedRevision)
				throw new Error("REVISION_MISMATCH");
			if (command.method === "archiveConversation" && result.archivedAt === null) throw new Error("COMMAND_MISMATCH");
			if (command.method === "restoreConversation" && result.archivedAt !== null) throw new Error("COMMAND_MISMATCH");
			const conversationId = result.conversationId;
			// Command results are historical receipts. Read current catalog state before displaying it.
			result = await this.client.call(
				"getConversation",
				{ workspaceId: result.workspaceId, conversationId: result.conversationId },
				signal,
			);
			signal.throwIfAborted();
			if (result.workspaceId !== command.params.workspaceId || result.conversationId !== conversationId)
				throw new Error("SCOPE_MISMATCH");
		}
		if (this.state.initialSend) {
			const expected = { request: command, initialSend: this.state.initialSend };
			const next =
				command.method === "createWorkspace"
					? await finishInitialWorkspace(this.local, expected, signal)
					: "conversationId" in result
						? await finishInitialConversation(this.local, expected, result.conversationId, signal)
						: null;
			if (!next) throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
			signal.throwIfAborted();
			this.publish({ pending: next.request, initialSend: next.initialSend, result, resultMethod: command.method });
			return;
		}
		const completion = await finishCatalog(
			this.local,
			command,
			"conversationId" in result ? result.conversationId : null,
			signal,
			discardPreparedTask,
		);
		signal.throwIfAborted();
		this.publish({
			pending: completion.handoffConflict ? command : null,
			result,
			resultMethod: command.method,
			notFound: false,
			...completion,
		});
	}
	private async lookup(signal: AbortSignal, discardPreparedTask = false) {
		const command = this.state.pending;
		if (!command) return;
		if (command.method === "createWorkspace") {
			try {
				await this.finish(
					command,
					await this.client.call("getWorkspace", { workspaceId: command.params.workspaceId }, signal),
					signal,
				);
			} catch (error) {
				if (error instanceof AppError && error.code === "NOT_FOUND") {
					signal.throwIfAborted();
					this.publish({ notFound: true });
				} else throw error;
			}
			return;
		}
		const receipt = await this.client.call(
			"getConversationCommandResult",
			{ workspaceId: command.params.workspaceId, requestId: command.params.requestId },
			signal,
		);
		signal.throwIfAborted();
		if (!receipt) {
			this.publish({ notFound: true });
			return;
		}
		if (receipt.method !== command.method) throw new Error("COMMAND_MISMATCH");
		await this.finish(command, receipt.result, signal, discardPreparedTask);
	}
	check = () =>
		this.run(async (signal) => {
			if (this.state.initialSend) await this.recoverInitial(signal);
			else await this.lookup(signal);
		});
	/** Explicitly keep the target's existing draft. Source input is not discarded or submitted. */
	discardPreparedTask = () => {
		if (!this.state.preparedTask?.conversationId) return Promise.resolve();
		return this.run((signal) => this.lookup(signal, true));
	};
	execute = (command: CatalogCommand, options?: { preparedDraft?: string }) => {
		if (this.state.pending || this.state.initialSend || this.state.incompatible || this.state.busy)
			return Promise.resolve();
		const captured = structuredClone(command);
		const preparedDraft = options?.preparedDraft;
		return this.run(async (signal) => {
			const saved = await admitCatalog(this.local, captured, preparedDraft, signal);
			this.publish({
				pending: captured,
				preparedTask: saved.preparedTask,
				handoffConflict: false,
				submission: null,
				receipt: null,
			});
			signal.throwIfAborted();
			await this.send(captured, signal);
		});
	};
	/** Explicit user retry only, after an exact lookup. Never a new identity or edited payload. */
	retry = () => {
		if (this.state.initialSend) {
			if (!this.state.notFound && this.state.pending) return Promise.resolve();
			return this.run((signal) => this.continueInitial(signal));
		}
		const command = this.state.pending;
		if (!command || !this.state.notFound) return Promise.resolve();
		return this.run((signal) => this.send(command, signal));
	};
	/** One explicit Send authorizes this live create-and-submit chain. Mounting never calls it. */
	sendInitial = (input: InitialSendInput) => {
		if (this.state.pending || this.state.initialSend || this.state.incompatible || this.state.busy)
			return Promise.resolve();
		return this.run(async (signal) => {
			const saved = await admitInitialSend(this.local, input, signal);
			this.publish({
				pending: saved.request,
				initialSend: saved.initialSend,
				preparedTask: null,
				submission: null,
				receipt: null,
				handoffConflict: false,
			});
			await this.continueInitial(signal);
		});
	};
	private async recoverInitial(signal: AbortSignal) {
		while (this.state.initialSend && this.state.pending) {
			const command = this.state.pending;
			currentInitialSend(this.local, { request: command, initialSend: this.state.initialSend });
			await this.lookup(signal);
			signal.throwIfAborted();
			if (this.state.pending === command) return;
		}
		if (this.state.initialSend) await this.handoffInitial(signal, false);
	}
	private async continueInitial(signal: AbortSignal) {
		while (this.state.initialSend && this.state.pending) {
			const command = this.state.pending;
			currentInitialSend(this.local, { request: command, initialSend: this.state.initialSend });
			if (command.method === "createConversation") {
				const workspace = await this.client.call("getWorkspace", { workspaceId: command.params.workspaceId }, signal);
				signal.throwIfAborted();
				const savedWorkspace = this.state.initialSend.workspaceCommand;
				if (
					workspace.workspaceId !== command.params.workspaceId ||
					(savedWorkspace && workspace.name !== savedWorkspace.params.name)
				)
					throw new Error("SCOPE_MISMATCH");
			}
			signal.throwIfAborted();
			currentInitialSend(this.local, { request: command, initialSend: this.state.initialSend });
			let result: Workspace | Conversation;
			try {
				if (command.method === "createWorkspace")
					result = await this.client.call(command.method, command.params, signal);
				else if (command.method === "createConversation")
					result = await this.client.call(command.method, command.params, signal);
				else throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof AppError && error.code === "STORE_MISMATCH") throw error;
				await this.lookup(signal);
				if (this.state.pending === command) return;
				continue;
			}
			await this.finish(command, result, signal);
		}
		if (this.state.initialSend) await this.handoffInitial(signal, true);
	}
	private async handoffInitial(signal: AbortSignal, allowDispatch: boolean) {
		const task = this.state.initialSend;
		if (!task?.conversationId) throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
		const expected = { request: this.state.pending, initialSend: task };
		currentInitialSend(this.local, expected);
		const scope = { workspaceId: task.conversationCommand.params.workspaceId, conversationId: task.conversationId };
		// A saved target is only a recovery hint. Re-establish its exact creation provenance after any interruption.
		const creation = await this.client.call(
			"getConversationCommandResult",
			{ workspaceId: scope.workspaceId, requestId: task.conversationCommand.params.requestId },
			signal,
		);
		signal.throwIfAborted();
		if (
			!creation ||
			creation.method !== "createConversation" ||
			creation.result.workspaceId !== scope.workspaceId ||
			creation.result.conversationId !== scope.conversationId ||
			creation.result.title !== task.conversationCommand.params.title
		)
			throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
		const conversation = await this.client.call("getConversation", scope, signal);
		signal.throwIfAborted();
		if (conversation.workspaceId !== scope.workspaceId || conversation.conversationId !== scope.conversationId)
			throw new Error("SCOPE_MISMATCH");
		const transfer = await transferInitialSubmission(this.local, expected, signal, (submission) => {
			this.publish({ submission, result: conversation, resultMethod: "createConversation" });
		});
		signal.throwIfAborted();
		this.publish({ initialSend: null, pending: null });
		// A pre-existing pending request is already owned by conversation recovery, even if never sent.
		if (!allowDispatch || !transfer.newlyAdmitted) return;
		if (conversation.archivedAt !== null) throw new AppError("CONVERSATION_ARCHIVED");
		const model = await this.client.call("getConversationModel", scope, signal);
		signal.throwIfAborted();
		const selected = task.conversationCommand.params.model;
		if (selected && (selected.provider !== model.model.provider || selected.modelId !== model.model.modelId))
			throw new AppError("MODEL_UNAVAILABLE");
		if (!canExecuteModel(model, false))
			throw new AppError(model.credentialState !== "configured" ? "CREDENTIAL_REQUIRED" : "RESUME_REQUIRED");
		let receipt: ReceiptView | null;
		try {
			receipt = await submitRequest(this.client, this.local, transfer.input, signal);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof AppError && error.code === "STORE_MISMATCH") throw error;
			receipt = await this.client.call(
				"getReceipt",
				{ workspaceId: scope.workspaceId, requestId: transfer.input.requestId },
				signal,
			);
			if (!receipt) throw error;
		}
		signal.throwIfAborted();
		if (
			receipt.requestId !== transfer.input.requestId ||
			receipt.workspaceId !== scope.workspaceId ||
			receipt.conversationId !== scope.conversationId
		)
			throw new Error("RECEIPT_SCOPE_MISMATCH");
		const key = `${scope.workspaceId}.${scope.conversationId}`;
		reconcileReceipt(this.local, key, this.local.read(`draft.${key}`) ?? "", transfer.input, receipt);
		this.publish({ receipt });
	}
	private async send(command: CatalogCommand, signal: AbortSignal) {
		// Recheck on explicit retry too: a stale session never dispatches a displaced recovery record.
		signal.throwIfAborted();
		currentCatalogRecovery(this.local, command);
		try {
			let result: Conversation | Workspace;
			switch (command.method) {
				case "createWorkspace":
					result = await this.client.call(command.method, command.params, signal);
					break;
				case "createConversation":
					result = await this.client.call(command.method, command.params, signal);
					break;
				case "renameConversation":
					result = await this.client.call(command.method, command.params, signal);
					break;
				case "archiveConversation":
					result = await this.client.call(command.method, command.params, signal);
					break;
				case "restoreConversation":
					result = await this.client.call(command.method, command.params, signal);
					break;
			}
			await this.finish(command, result, signal);
		} catch {
			signal.throwIfAborted();
			await this.lookup(signal);
		}
	}
}
