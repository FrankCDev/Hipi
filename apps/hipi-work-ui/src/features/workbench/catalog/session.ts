import {
	type AgentContext,
	type AppClient,
	AppError,
	type Conversation,
	type ErrorCode,
	type Params,
	type ProjectCompletedCommand,
	type ProjectPresentation,
	type ReceiptView,
	type Submit,
	type Workspace,
} from "@hipi/work-runtime/contracts";
import { parseProjectFolder } from "@hipi/work-runtime/files/protocol";
import type { FileAuthority } from "../../../app/file-client.ts";
import type { CatalogCommand, LegacyCatalogCommand, ProjectCatalogCommand } from "../command-recovery.ts";
import type { LocalState } from "../local-state.ts";
import { canExecuteModel } from "../model-policy.ts";
import {
	admitProjectCommand,
	assertAdoptionEvidence,
	finishProjectCommand,
	isProjectCatalogCommand,
	matchesProjectCommand,
} from "../projects/commands.ts";
import { canCreateProjectless } from "../projects/identity.ts";
import { reconcileReceipt } from "../receipt-reconciliation.ts";
import { submitRequest } from "../submit-request.ts";
import { matchesInitialGrant } from "./initial-context.ts";
import {
	admitInitialSend,
	advanceInitialContext,
	currentInitialSend,
	defaultChatWorkspaceId,
	finishInitialConversation,
	finishInitialWorkspace,
	finishLogicalInitialConversation,
	type InitialSend,
	type InitialSendInput,
	initialWorkspaceId,
	releaseInitialDraft,
	transferInitialSubmission,
} from "./initial-send.ts";
import {
	admitCatalog,
	currentCatalogRecovery,
	finishCatalog,
	type PreparedTask,
	readCatalogRecovery,
} from "./prepared-task.ts";

export type CatalogState = {
	pending: CatalogCommand | null;
	incompatible: boolean;
	busy: boolean;
	failed: boolean;
	notFound: boolean;
	projectPending: boolean;
	projectResult: ProjectCompletedCommand | null;
	result: Conversation | Workspace | null;
	resultMethod: CatalogCommand["method"] | null;
	preparedTask: PreparedTask | null;
	handoffConflict: boolean;
	initialSend: InitialSend | null;
	submission: Submit | null;
	receipt: ReceiptView | null;
	errorCode: ErrorCode | null;
	initialConsentInvalidated: boolean;
	initialConsentStage: "create" | "authorize" | "submit" | null;
	initialConsentGrantActive: boolean;
	initialConsentCanRecoverDraft: boolean;
};
type ProjectPinInput = Params<"setProjectPinned">;
export type ProjectPinLifecycle =
	| { phase: "initiated" | "admitted" | "retired"; input: Readonly<ProjectPinInput> }
	| { phase: "confirmed"; input: Readonly<ProjectPinInput>; result: Readonly<ProjectPresentation> };
/** Owns immutable directory commands. A lost reply is resolved by exact read-only lookup. */
export class CatalogSession {
	private state: CatalogState;
	private listeners = new Set<() => void>();
	private projectPinListeners = new Set<(event: ProjectPinLifecycle) => void>();
	private lifecycle = 0;
	private request: AbortController | undefined;
	private disposed = false;
	private client: AppClient;
	private local: LocalState;
	private fileAuthority: Pick<FileAuthority, "getProject"> | undefined;
	private liveConsentId: string | null = null;
	constructor(client: AppClient, local: LocalState, fileAuthority?: Pick<FileAuthority, "getProject">) {
		this.client = client;
		this.local = local;
		this.fileAuthority = fileAuthority;
		const saved = readCatalogRecovery(local.read("command.catalog"));
		this.state = {
			pending: saved.request,
			incompatible: saved.incompatible,
			busy: false,
			failed: false,
			notFound: false,
			projectPending: false,
			projectResult: null,
			result: null,
			resultMethod: null,
			preparedTask: saved.preparedTask,
			handoffConflict: false,
			initialSend: saved.initialSend,
			submission: null,
			receipt: null,
			errorCode: null,
			initialConsentInvalidated: !!saved.initialSend?.context,
			initialConsentStage: saved.initialSend?.context
				? saved.request
					? "create"
					: saved.initialSend.context.submitAttempted
						? "submit"
						: "authorize"
				: null,
			initialConsentGrantActive: false,
			initialConsentCanRecoverDraft: !!saved.initialSend?.context && !saved.initialSend.context.createAttempted,
		};
	}
	getSnapshot = () => this.state;
	defaultWorkspaceId = () => defaultChatWorkspaceId(this.local);
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	subscribeProjectPinLifecycle = (listener: (event: ProjectPinLifecycle) => void) => {
		this.projectPinListeners.add(listener);
		return () => {
			this.projectPinListeners.delete(listener);
		};
	};
	private projectPinEvent(event: ProjectPinLifecycle) {
		if (this.disposed) return;
		Object.freeze(event);
		for (const listener of this.projectPinListeners) listener(event);
	}
	private publish(patch: Partial<CatalogState>) {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		const task = this.state.initialSend;
		this.state.initialConsentInvalidated =
			!!task?.context && (task.context.invalidated || this.liveConsentId !== task.submissionId);
		this.state.initialConsentStage = task?.context
			? this.state.pending
				? "create"
				: task.context.submitAttempted
					? "submit"
					: "authorize"
			: null;
		if (!task?.context || task.context.submitAttempted) this.state.initialConsentCanRecoverDraft = false;
		else if (!task.context.createAttempted) this.state.initialConsentCanRecoverDraft = true;
		for (const listener of this.listeners) listener();
	}
	activate() {
		this.disposed = false;
		if (this.state.initialSend?.context) this.publish({});
	}
	dispose() {
		this.disposed = true;
		this.lifecycle++;
		this.request?.abort();
		this.request = undefined;
		this.liveConsentId = null;
		this.listeners.clear();
		this.projectPinListeners.clear();
	}
	private async run(work: (signal: AbortSignal) => Promise<void>) {
		if (this.disposed || this.request || this.state.incompatible) return;
		const controller = new AbortController();
		this.request = controller;
		const timeout = setTimeout(() => controller.abort(), 15000);
		this.publish({ busy: true, failed: false, notFound: false, result: null, projectResult: null, errorCode: null });
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
		command: LegacyCatalogCommand,
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
		if (isProjectCatalogCommand(command)) {
			await this.lookupProject(command, signal);
			return;
		}
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
	private async lookupProject(command: ProjectCatalogCommand, signal: AbortSignal) {
		currentCatalogRecovery(this.local, command);
		const receipt = await this.client.call("getProjectCommandResult", { requestId: command.params.requestId }, signal);
		signal.throwIfAborted();
		if (!receipt) {
			this.publish({ notFound: true, projectPending: false });
			return;
		}
		if (!matchesProjectCommand(command, receipt)) throw new Error("COMMAND_MISMATCH");
		if (receipt.status === "pending") {
			this.publish({ notFound: false, projectPending: true });
			return;
		}
		if (receipt.method === "createProjectConversation") {
			const created = receipt.result.conversation;
			const conversation = await this.client.call(
				"getConversation",
				{ workspaceId: created.workspaceId, conversationId: created.conversationId },
				signal,
			);
			signal.throwIfAborted();
			if (conversation.workspaceId !== created.workspaceId || conversation.conversationId !== created.conversationId)
				throw new Error("SCOPE_MISMATCH");
			if (this.state.initialSend) {
				const next = await finishLogicalInitialConversation(
					this.local,
					{ request: command, initialSend: this.state.initialSend },
					created,
					signal,
				);
				this.publish({
					pending: null,
					initialSend: next.initialSend,
					result: conversation,
					resultMethod: command.method,
					projectResult: receipt,
					projectPending: false,
					notFound: false,
				});
				return;
			}
			await finishProjectCommand(this.local, command, signal);
			this.publish({
				pending: null,
				result: conversation,
				resultMethod: command.method,
				projectResult: receipt,
				projectPending: false,
				notFound: false,
			});
			return;
		}
		const currentPresentation =
			receipt.method === "setProjectPinned"
				? await this.client.call("getProjectPresentation", { projectId: receipt.params.projectId }, signal)
				: null;
		signal.throwIfAborted();
		if (
			receipt.method === "setProjectPinned" &&
			currentPresentation &&
			(currentPresentation.projectId !== receipt.params.projectId ||
				currentPresentation.revision < receipt.result.revision)
		)
			throw new Error("RESULT_MISMATCH");
		await finishProjectCommand(this.local, command, signal);
		this.publish({
			pending: null,
			resultMethod: command.method,
			projectResult: receipt,
			projectPending: false,
			notFound: false,
		});
		if (receipt.method === "setProjectPinned" && currentPresentation)
			this.projectPinEvent({
				phase: "confirmed",
				input: Object.freeze({ ...receipt.params }),
				result: Object.freeze({ ...currentPresentation }),
			});
	}
	private async sendProject(command: ProjectCatalogCommand, signal: AbortSignal) {
		currentCatalogRecovery(this.local, command);
		if (command.method === "adoptLegacyDefaultWorkspace") assertAdoptionEvidence(this.local, command);
		let rejection: AppError | undefined;
		try {
			switch (command.method) {
				case "createProject":
					await this.client.call(command.method, command.params, signal);
					break;
				case "createProjectConversation":
					await this.client.call(command.method, command.params, signal);
					break;
				case "renameProject":
					await this.client.call(command.method, command.params, signal);
					break;
				case "setProjectPinned":
					await this.client.call(command.method, command.params, signal);
					break;
				case "reorderPinnedProject":
					await this.client.call(command.method, command.params, signal);
					break;
				case "adoptLegacyDefaultWorkspace":
					await this.client.call(command.method, command.params, signal);
					break;
			}
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof AppError && error.code === "STORE_MISMATCH") throw error;
			if (error instanceof AppError) rejection = error;
		}
		await this.lookupProject(command, signal);
		if (
			this.state.notFound &&
			rejection &&
			["IDEMPOTENCY_CONFLICT", "NOT_FOUND", "INVALID_REQUEST"].includes(rejection.code) &&
			(command.method === "renameProject" ||
				command.method === "setProjectPinned" ||
				command.method === "reorderPinnedProject")
		) {
			await finishProjectCommand(this.local, command, signal);
			this.publish({ pending: null, notFound: false, projectPending: false, failed: true, errorCode: rejection.code });
			if (command.method === "setProjectPinned")
				this.projectPinEvent({ phase: "retired", input: Object.freeze({ ...command.params }) });
		}
	}
	private async verifyInitialCreation(task: InitialSend, signal: AbortSignal) {
		const command = task.conversationCommand;
		if (command.method === "createProjectConversation") {
			const receipt = await this.client.call(
				"getProjectCommandResult",
				{ requestId: command.params.requestId },
				signal,
			);
			signal.throwIfAborted();
			if (
				!receipt ||
				receipt.status !== "completed" ||
				receipt.method !== command.method ||
				!matchesProjectCommand(command, receipt) ||
				receipt.result.conversation.workspaceId !== initialWorkspaceId(task) ||
				receipt.result.conversation.conversationId !== task.conversationId
			)
				throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
			return;
		}
		const receipt = await this.client.call(
			"getConversationCommandResult",
			{ workspaceId: command.params.workspaceId, requestId: command.params.requestId },
			signal,
		);
		signal.throwIfAborted();
		if (
			receipt?.method !== "createConversation" ||
			receipt.result.workspaceId !== command.params.workspaceId ||
			receipt.result.conversationId !== task.conversationId ||
			receipt.result.title !== command.params.title
		)
			throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
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
	/** Keeps a verified pre-submit conversation as a draft. Never abandons an unknown Submit. */
	recoverInitialDraft = () => this.recoverDraft(false);
	/** Explicit conflict resolution only: preserve the current draft first, then the original unsent text. */
	combineInitialDraft = () => this.recoverDraft(true);
	private recoverDraft(combine: boolean) {
		const task = this.state.initialSend;
		if (!task?.context || task.context.submitAttempted) return Promise.resolve();
		if (task.context.createAttempted && !task.conversationId) return Promise.resolve();
		return this.run(async (signal) => {
			// Capture at the explicit click, before provenance reads or a queued admission can yield.
			const key = task.conversationId ? `draft.${initialWorkspaceId(task)}.${task.conversationId}` : task.sourceKey;
			const combination = combine
				? { key, stored: this.local.storedValue(key), edited: this.local.valueSnapshot(key) }
				: undefined;
			this.liveConsentId = null;
			this.publish({});
			if (!task.context?.createAttempted) {
				const released = await releaseInitialDraft(
					this.local,
					{ request: this.state.pending, initialSend: task },
					signal,
					combination,
				);
				signal.throwIfAborted();
				this.publish({
					...(released ? { initialSend: null, pending: null } : {}),
					handoffConflict: !released,
				});
				return;
			}
			if (!task.conversationId) throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
			const conversationId = task.conversationId;
			currentInitialSend(this.local, { request: null, initialSend: task });
			const scope = { workspaceId: initialWorkspaceId(task), conversationId };
			await this.verifyInitialCreation(task, signal);
			const conversation = await this.client.call("getConversation", scope, signal);
			signal.throwIfAborted();
			if (conversation.workspaceId !== scope.workspaceId || conversation.conversationId !== scope.conversationId)
				throw new Error("SCOPE_MISMATCH");
			const authorization = task.context?.authorization;
			if (authorization) {
				const result = await this.client.call(
					"getAgentCommandResult",
					{ ...scope, requestId: authorization.requestId },
					signal,
				);
				signal.throwIfAborted();
				// A missing receipt does not establish that an authorization was never dispatched.
				if (result?.method !== "authorizeAgentContext" || !matchesInitialGrant(authorization, result.result))
					throw new Error("INITIAL_CONTEXT_AUTHORIZATION_UNKNOWN");
				const active = await this.client.call("listActiveAgentContexts", scope, signal);
				signal.throwIfAborted();
				this.publish({
					initialConsentGrantActive: active.some(
						(grant) =>
							grant.grantId === result.result.grantId &&
							grant.revision === result.result.revision &&
							grant.status === "active" &&
							grant.expiresAt > Date.now() &&
							matchesInitialGrant(authorization, grant),
					),
				});
			}
			const released = await releaseInitialDraft(this.local, { request: null, initialSend: task }, signal, combination);
			signal.throwIfAborted();
			this.publish({
				...(released ? { initialSend: null, pending: null, initialConsentCanRecoverDraft: false } : {}),
				handoffConflict: !released,
				result: conversation,
				resultMethod: "createConversation",
			});
		});
	}
	execute = (command: CatalogCommand, options?: { preparedDraft?: string }) => {
		if (this.state.pending || this.state.initialSend || this.state.incompatible || this.state.busy)
			return Promise.resolve();
		const captured = structuredClone(command);
		const preparedDraft = options?.preparedDraft;
		const lifecycle = this.lifecycle;
		let initiated = false;
		let admitted = false;
		return this.run(async (signal) => {
			if (isProjectCatalogCommand(captured)) {
				if (preparedDraft !== undefined) throw new Error("INVALID_PREPARED_TASK");
				if (captured.method === "setProjectPinned") {
					initiated = true;
					this.projectPinEvent({ phase: "initiated", input: Object.freeze({ ...captured.params }) });
				}
				const pending = await admitProjectCommand(this.local, captured, signal);
				admitted = true;
				if (captured.method === "setProjectPinned")
					this.projectPinEvent({ phase: "admitted", input: Object.freeze({ ...captured.params }) });
				this.publish({
					pending,
					preparedTask: null,
					submission: null,
					receipt: null,
					projectResult: null,
					projectPending: false,
				});
				await this.sendProject(pending, signal);
				return;
			}
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
		}).finally(() => {
			if (lifecycle === this.lifecycle && initiated && !admitted && captured.method === "setProjectPinned")
				this.projectPinEvent({ phase: "retired", input: Object.freeze({ ...captured.params }) });
		});
	};
	/** Explicit user retry only, after an exact lookup. Never a new identity or edited payload. */
	retry = () => {
		if (this.state.initialSend) {
			if (this.state.initialSend.context && this.state.initialConsentInvalidated) return Promise.resolve();
			if (!this.state.notFound && !this.state.projectPending && this.state.pending) return Promise.resolve();
			return this.run(async (signal) => {
				// Consent retries first reconcile every exact outcome; never replay from a stale missing-result flag.
				if (this.state.initialSend?.context) await this.recoverInitial(signal);
				if (this.state.initialSend) await this.continueInitial(signal);
			});
		}
		const command = this.state.pending;
		if (!command || (!this.state.notFound && !this.state.projectPending)) return Promise.resolve();
		return this.run((signal) =>
			isProjectCatalogCommand(command) ? this.sendProject(command, signal) : this.send(command, signal),
		);
	};
	/** One explicit Send authorizes this live create-and-submit chain. Mounting never calls it. */
	sendInitial = (input: InitialSendInput) => {
		if (this.state.pending || this.state.initialSend || this.state.incompatible || this.state.busy)
			return Promise.resolve();
		const captured = structuredClone(input);
		return this.run(async (signal) => {
			const projectCatalog =
				captured.projectId === null ? await this.client.call("getProjectCatalogState", {}, signal) : undefined;
			const saved = await admitInitialSend(this.local, captured, signal, projectCatalog);
			this.liveConsentId = saved.initialSend.context ? saved.initialSend.submissionId : null;
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
			if (isProjectCatalogCommand(command)) {
				if (command.method !== "createProjectConversation") throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
				if (command.params.projectId === null) {
					const state = await this.client.call("getProjectCatalogState", {}, signal);
					signal.throwIfAborted();
					if (!canCreateProjectless(this.local, state)) throw new Error("PROJECT_DESTINATION_UNVERIFIED");
				}
				if (this.state.initialSend.context) {
					await this.validateInitialContext(this.state.initialSend, signal);
					if (!this.state.initialSend.context.createAttempted) {
						const saved = await advanceInitialContext(
							this.local,
							{ request: command, initialSend: this.state.initialSend },
							"create",
							signal,
						);
						this.publish({ initialSend: saved.initialSend, initialConsentCanRecoverDraft: false });
					}
				}
				await this.sendProject(command, signal);
				if (this.state.pending === command) return;
				continue;
			}
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
			if (this.state.initialSend.context) await this.validateInitialContext(this.state.initialSend, signal);
			if (this.state.initialSend.context && !this.state.initialSend.context.createAttempted) {
				const saved = await advanceInitialContext(
					this.local,
					{ request: command, initialSend: this.state.initialSend },
					"create",
					signal,
				);
				this.publish({ initialSend: saved.initialSend, initialConsentCanRecoverDraft: false });
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
		const scope = { workspaceId: initialWorkspaceId(task), conversationId: task.conversationId };
		// A saved target is only a recovery hint. Re-establish its exact creation provenance after any interruption.
		await this.verifyInitialCreation(task, signal);
		const conversation = await this.client.call("getConversation", scope, signal);
		signal.throwIfAborted();
		if (conversation.workspaceId !== scope.workspaceId || conversation.conversationId !== scope.conversationId)
			throw new Error("SCOPE_MISMATCH");
		if (task.context) {
			await this.handoffInitialContext(task, conversation, signal, allowDispatch);
			return;
		}
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
	private async invalidateInitialContext(task: InitialSend, signal: AbortSignal): Promise<never> {
		this.liveConsentId = null;
		const saved = await advanceInitialContext(
			this.local,
			{ request: this.state.pending, initialSend: task },
			"invalidate",
			signal,
		);
		this.publish({ initialSend: saved.initialSend });
		throw new Error("INITIAL_CONTEXT_INVALIDATED");
	}
	private async validateInitialContext(task: InitialSend, signal: AbortSignal) {
		const context = task.context;
		if (!context || context.invalidated || this.liveConsentId !== task.submissionId)
			throw new Error("INITIAL_CONTEXT_INVALIDATED");
		if (!this.fileAuthority?.getProject) throw new Error("INITIAL_CONTEXT_AUTHORITY_UNAVAILABLE");
		const staged = context.staged;
		if (task.conversationCommand.method === "createProjectConversation") {
			const projectId = task.conversationCommand.params.projectId;
			if (!projectId) throw new Error("INITIAL_CONTEXT_INVALIDATED");
			const project = await this.client.call("getProject", { projectId }, signal);
			signal.throwIfAborted();
			if (project.projectId !== projectId || project.homeWorkspaceId !== staged.workspaceId)
				await this.invalidateInitialContext(task, signal);
		}
		const folder = parseProjectFolder(await this.fileAuthority.getProject(staged.workspaceId), staged.workspaceId);
		signal.throwIfAborted();
		currentInitialSend(this.local, { request: this.state.pending, initialSend: task });
		if (
			staged.expiresAt <= Date.now() ||
			folder.status !== "available" ||
			folder.bindingId !== staged.bindingId ||
			folder.revision !== staged.bindingRevision ||
			folder.root.rootId !== staged.rootId
		)
			await this.invalidateInitialContext(task, signal);
		if (task.conversationId) {
			const scope = { workspaceId: staged.workspaceId, conversationId: task.conversationId };
			const conversation = await this.client.call("getConversation", scope, signal);
			signal.throwIfAborted();
			if (
				conversation.workspaceId !== scope.workspaceId ||
				conversation.conversationId !== scope.conversationId ||
				conversation.archivedAt !== null
			)
				await this.invalidateInitialContext(task, signal);
			const model = await this.client.call("getConversationModel", scope, signal);
			signal.throwIfAborted();
			if (model.model.provider !== staged.model.provider || model.model.modelId !== staged.model.modelId)
				await this.invalidateInitialContext(task, signal);
			if (!canExecuteModel(model, false))
				throw new AppError(model.credentialState !== "configured" ? "CREDENTIAL_REQUIRED" : "RESUME_REQUIRED");
		}
		currentInitialSend(this.local, { request: this.state.pending, initialSend: task });
		if (staged.expiresAt <= Date.now()) await this.invalidateInitialContext(task, signal);
	}
	private async readInitialGrant(task: InitialSend, signal: AbortSignal): Promise<AgentContext | null> {
		const authorization = task.context?.authorization;
		if (!authorization) return null;
		const receipt = await this.client.call(
			"getAgentCommandResult",
			{
				workspaceId: authorization.workspaceId,
				conversationId: authorization.conversationId,
				requestId: authorization.requestId,
			},
			signal,
		);
		signal.throwIfAborted();
		if (!receipt) {
			this.publish({ initialConsentGrantActive: false, initialConsentCanRecoverDraft: false });
			return null;
		}
		if (receipt.method !== "authorizeAgentContext" || !matchesInitialGrant(authorization, receipt.result))
			throw new Error("INITIAL_CONTEXT_GRANT_MISMATCH");
		const active = await this.client.call(
			"listActiveAgentContexts",
			{ workspaceId: authorization.workspaceId, conversationId: authorization.conversationId },
			signal,
		);
		signal.throwIfAborted();
		const grant = active.find(
			(item) =>
				item.grantId === receipt.result.grantId &&
				item.revision === receipt.result.revision &&
				item.status === "active" &&
				matchesInitialGrant(authorization, item),
		);
		this.publish({ initialConsentGrantActive: !!grant, initialConsentCanRecoverDraft: !task.context?.submitAttempted });
		if (!grant || receipt.result.status !== "active" || grant.expiresAt <= Date.now())
			await this.invalidateInitialContext(task, signal);
		return grant ?? null;
	}
	private async finishInitialContextReceipt(task: InitialSend, receipt: ReceiptView, signal: AbortSignal) {
		const transfer = await transferInitialSubmission(
			this.local,
			{ request: null, initialSend: task },
			signal,
			(submission) => this.publish({ submission }),
			receipt,
		);
		signal.throwIfAborted();
		const key = `${transfer.input.workspaceId}.${transfer.input.conversationId}`;
		reconcileReceipt(this.local, key, this.local.read(`draft.${key}`) ?? "", transfer.input, receipt);
		this.liveConsentId = null;
		this.publish({ initialSend: null, pending: null, receipt, notFound: false });
	}
	private async handoffInitialContext(
		task: InitialSend,
		conversation: Conversation,
		signal: AbortSignal,
		allowDispatch: boolean,
	) {
		if (!task.context || !task.conversationId) throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
		const input: Submit = {
			workspaceId: initialWorkspaceId(task),
			conversationId: task.conversationId,
			requestId: task.submissionId,
			text: task.text,
		};
		this.publish({ result: conversation, resultMethod: "createConversation" });
		this.publish({ initialConsentCanRecoverDraft: !task.context.submitAttempted && !task.context.authorization });
		if (task.context.submitAttempted) {
			const receipt = await this.client.call(
				"getReceipt",
				{ workspaceId: input.workspaceId, requestId: input.requestId },
				signal,
			);
			signal.throwIfAborted();
			if (receipt) {
				await this.finishInitialContextReceipt(task, receipt, signal);
				return;
			}
		}
		let grant = await this.readInitialGrant(task, signal);
		if (!allowDispatch) {
			this.publish({ notFound: true });
			return;
		}
		await this.validateInitialContext(task, signal);
		if (!task.context.authorization) {
			const saved = await advanceInitialContext(this.local, { request: null, initialSend: task }, "authorize", signal);
			task = saved.initialSend;
			this.publish({ initialSend: task });
		}
		const authorization = task.context?.authorization;
		if (!authorization) throw new Error("INITIAL_CONTEXT_PREREQUISITE_REQUIRED");
		if (!grant) {
			await this.validateInitialContext(task, signal);
			try {
				const result = await this.client.call("authorizeAgentContext", authorization, signal);
				signal.throwIfAborted();
				if (!matchesInitialGrant(authorization, result)) throw new Error("INITIAL_CONTEXT_GRANT_MISMATCH");
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof AppError && error.code === "STORE_MISMATCH") throw error;
				grant = await this.readInitialGrant(task, signal);
				if (!grant) {
					this.publish({ notFound: true });
					return;
				}
			}
			grant = await this.readInitialGrant(task, signal);
			if (!grant) {
				this.publish({ notFound: true });
				return;
			}
		}
		await this.validateInitialContext(task, signal);
		// Re-read current authority after the last model/binding check, not merely the historical command result.
		if (!(await this.readInitialGrant(task, signal))) {
			this.publish({ notFound: true });
			return;
		}
		if (!task.context?.submitAttempted) {
			const saved = await advanceInitialContext(this.local, { request: null, initialSend: task }, "submit", signal);
			task = saved.initialSend;
			this.publish({ initialSend: task });
		}
		currentInitialSend(this.local, { request: null, initialSend: task });
		signal.throwIfAborted();
		if (!task.context || task.context.staged.expiresAt <= Date.now()) await this.invalidateInitialContext(task, signal);
		let receipt: ReceiptView | null;
		try {
			receipt = await this.client.call("submit", input, signal);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof AppError && error.code === "STORE_MISMATCH") throw error;
			receipt = await this.client.call(
				"getReceipt",
				{ workspaceId: input.workspaceId, requestId: input.requestId },
				signal,
			);
			signal.throwIfAborted();
			if (!receipt) {
				this.publish({ notFound: true });
				return;
			}
		}
		await this.finishInitialContextReceipt(task, receipt, signal);
	}
	private async send(command: LegacyCatalogCommand, signal: AbortSignal) {
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
