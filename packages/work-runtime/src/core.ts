import {
	type AppClient,
	AppError,
	type Conversation,
	type ConversationModel,
	type Frame,
	type HistoryPage,
	type MessageTextChunk,
	type Method,
	type ModelCatalog,
	type ObservationStatus,
	type Params,
	PROTOCOL_VERSION,
	parseObservationScope,
	parseRequest,
	type Receipt,
	type ReceiptView,
	type Response,
	type Result,
	type Scope,
	type Snapshot,
	type Submit,
	type Subscription,
	type Workspace,
} from "./contracts.ts";

/** The application owns use cases; the implementation owns PI and storage, never a window. */
export interface WorkspacePort {
	installToolPack(input: Params<"installToolPack">): Promise<Result<"installToolPack">>;
	setToolPackEnabled(input: Params<"setToolPackEnabled">): Promise<Result<"setToolPackEnabled">>;
	uninstallToolPack(input: Params<"uninstallToolPack">): Promise<Result<"uninstallToolPack">>;
	bindToolPack(input: Params<"bindToolPack">): Promise<Result<"bindToolPack">>;
	revokeToolPackBinding(input: Params<"revokeToolPackBinding">): Promise<Result<"revokeToolPackBinding">>;
	authorizeRetainedToolPack(input: Params<"authorizeRetainedToolPack">): Promise<Result<"authorizeRetainedToolPack">>;
	readonly workspace: Workspace;
	createConversation(input: Params<"createConversation">): Promise<Conversation>;
	getConversation(input: Params<"getConversation">): Promise<Result<"getConversation">>;
	renameConversation(input: Params<"renameConversation">): Promise<Result<"renameConversation">>;
	archiveConversation(input: Params<"archiveConversation">): Promise<Result<"archiveConversation">>;
	restoreConversation(input: Params<"restoreConversation">): Promise<Result<"restoreConversation">>;
	getConversationCommandResult(
		input: Params<"getConversationCommandResult">,
	): Promise<Result<"getConversationCommandResult">>;

	getConversationModel(scope: Scope): Promise<ConversationModel>;
	continueWorkspace(): Promise<{ workspaceId: string; state: "authorized" }>;
	cancelExecution(scope: Scope): Promise<ConversationModel>;
	submit(input: Submit): Promise<Receipt>;
	getReceipt(requestId: string): Promise<ReceiptView | null>;
	snapshot(scope: Scope): Promise<Snapshot>;
	getHistory(input: Params<"getHistory">): Promise<HistoryPage>;
	getMessageText(input: Params<"getMessageText">): Promise<MessageTextChunk>;
	authorizeAgentContext(input: Params<"authorizeAgentContext">): Promise<Result<"authorizeAgentContext">>;
	authorizeRetainedContext(input: Params<"authorizeRetainedContext">): Promise<Result<"authorizeRetainedContext">>;
	revokeAgentContext(input: Params<"revokeAgentContext">): Promise<Result<"revokeAgentContext">>;
	listActiveAgentContexts(input: Params<"listActiveAgentContexts">): Promise<Result<"listActiveAgentContexts">>;
	listPendingToolApprovals(input: Params<"listPendingToolApprovals">): Promise<Result<"listPendingToolApprovals">>;
	getAgentCommandResult(input: Params<"getAgentCommandResult">): Promise<Result<"getAgentCommandResult">>;
	listAgentContexts(input: Params<"listAgentContexts">): Promise<Result<"listAgentContexts">>;
	listToolApprovals(input: Params<"listToolApprovals">): Promise<Result<"listToolApprovals">>;
	decideToolApproval(input: Params<"decideToolApproval">): Promise<Result<"decideToolApproval">>;
	getFileOperation(input: Params<"getFileOperation">): Promise<Result<"getFileOperation">>;
	observe(
		scope: Scope,
		listener: (frame: Frame) => void | Promise<void>,
		signal?: AbortSignal,
		onStatus?: (status: ObservationStatus) => void,
	): Promise<Subscription>;
	/** True only when closing cannot interrupt work or invalidate active authorization. Unknown must return false. */
	canEvict?(): Promise<boolean>;
	close(): Promise<void>;
}
export type RuntimePorts = {
	previewToolPack(input: Params<"previewToolPack">): Promise<Result<"previewToolPack">>;
	listToolPacks(input: Params<"listToolPacks">): Promise<Result<"listToolPacks">>;
	getToolPackSource(input: Params<"getToolPackSource">): Promise<Result<"getToolPackSource">>;
	listToolPackBindings(input: Params<"listToolPackBindings">): Promise<Result<"listToolPackBindings">>;
	listActiveToolPackBindings(
		input: Params<"listActiveToolPackBindings">,
	): Promise<Result<"listActiveToolPackBindings">>;
	getToolPackCommandResult(input: Params<"getToolPackCommandResult">): Promise<Result<"getToolPackCommandResult">>;
	getToolActivities(input: Params<"getToolActivities">): Promise<Result<"getToolActivities">>;
	getToolActivityText(input: Params<"getToolActivityText">): Promise<Result<"getToolActivityText">>;
	readonly storeId: string;
	getAgentCommandResult(input: Params<"getAgentCommandResult">): Promise<Result<"getAgentCommandResult">>;
	getConversation(input: Params<"getConversation">): Promise<Result<"getConversation">>;
	getConversationCommandResult(
		input: Params<"getConversationCommandResult">,
	): Promise<Result<"getConversationCommandResult">>;
	getWorkspace(input: Params<"getWorkspace">): Promise<Workspace>;
	listModels(): Promise<ModelCatalog>;
	listWorkspaces(input: Params<"listWorkspaces">): Promise<Result<"listWorkspaces">>;
	listConversations(input: Params<"listConversations">): Promise<Result<"listConversations">>;
	openWorkspace(id: string, name?: string, options?: { resume: false }): Promise<WorkspacePort>;
	close(): Promise<void>;
};

/** Cancellation stops this caller waiting, never the already-admitted operation. */
export function cancelWait<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Wait cancelled"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
type CachedWorkspace = { port: WorkspacePort; leases: number; closeFailed: boolean };
type WorkspaceLease = { port: WorkspacePort; release(): void };

export class WorkRuntime implements AppClient {
	readonly #ports: RuntimePorts;
	readonly #workspaces = new Map<string, CachedWorkspace>();
	#cacheMutation: Promise<unknown> = Promise.resolve();
	// After recycling begins, all cold opens are read-only until explicit continuation.
	// One bit avoids an unbounded history of previously opened workspace IDs.
	#evicted = false;
	readonly #subscriptions = new Set<Subscription>();
	#closed = false;
	#closing: Promise<void> | undefined;
	readonly #active = new Set<Promise<unknown>>();
	constructor(ports: RuntimePorts) {
		this.#ports = ports;
	}
	#workspace(id: string, name?: string): Promise<WorkspaceLease> {
		// Admission, idle proof, close and replacement are one serialized ownership transition.
		const result = this.#cacheMutation.then(async () => {
			if (this.#closed) throw new AppError("CLOSED");
			let entry = this.#workspaces.get(id);
			if (!entry) {
				if (this.#workspaces.size >= 16) {
					for (const [key, candidate] of this.#workspaces) {
						if (candidate.leases || candidate.closeFailed) continue;
						let idle = false;
						try {
							idle = (await candidate.port.canEvict?.()) === true;
						} catch {
							// Failure to prove idle is not permission to stop a writer.
						}
						if (this.#closed) throw new AppError("CLOSED");
						if (!idle) continue;
						try {
							await candidate.port.close();
						} catch {
							candidate.closeFailed = true;
							throw new AppError("WORKSPACE_BUSY");
						}
						this.#workspaces.delete(key);
						this.#evicted = true;
						break;
					}
					if (this.#workspaces.size >= 16) throw new AppError("CAPACITY_EXCEEDED");
				}
				if (this.#closed) throw new AppError("CLOSED");
				entry = {
					port: await this.#ports.openWorkspace(id, name, this.#evicted ? { resume: false } : undefined),
					leases: 0,
					closeFailed: false,
				};
				this.#workspaces.set(id, entry);
			}
			if (entry.closeFailed) throw new AppError("WORKSPACE_BUSY");
			if (name !== undefined && entry.port.workspace.name !== name) throw new AppError("IDEMPOTENCY_CONFLICT");
			entry.leases++;
			this.#workspaces.delete(id);
			this.#workspaces.set(id, entry);
			let released = false;
			return {
				port: entry.port,
				release: () => {
					if (!released) entry.leases--;
					released = true;
				},
			};
		});
		this.#cacheMutation = result.catch(() => undefined);
		return result;
	}
	#track<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new AppError("CLOSED"));
		const pending = operation();
		this.#active.add(pending);
		void pending.finally(() => this.#active.delete(pending)).catch(() => undefined);
		return pending;
	}
	execute(raw: unknown): Promise<Response> {
		return this.#track(() => this.#execute(raw));
	}
	async #execute(raw: unknown): Promise<Response> {
		const request = parseRequest(raw);
		if (this.#closed) throw new AppError("CLOSED");
		if (request.method === "handshake") return { protocolVersion: PROTOCOL_VERSION, storeId: this.#ports.storeId };
		if (request.expectedStoreId !== this.#ports.storeId) throw new AppError("STORE_MISMATCH");
		if (request.method === "previewToolPack") return this.#ports.previewToolPack(request.params);
		if (request.method === "listToolPacks") return this.#ports.listToolPacks(request.params);
		if (request.method === "getToolPackSource") return this.#ports.getToolPackSource(request.params);
		if (request.method === "listToolPackBindings") return this.#ports.listToolPackBindings(request.params);
		if (request.method === "listActiveToolPackBindings")
			return this.#ports.listActiveToolPackBindings(request.params);
		if (request.method === "getToolPackCommandResult") return this.#ports.getToolPackCommandResult(request.params);
		if (request.method === "getToolActivities") return this.#ports.getToolActivities(request.params);
		if (request.method === "getToolActivityText") return this.#ports.getToolActivityText(request.params);
		if (request.method === "getAgentCommandResult") return this.#ports.getAgentCommandResult(request.params);
		if (request.method === "getConversation") return this.#ports.getConversation(request.params);
		if (request.method === "getConversationCommandResult")
			return this.#ports.getConversationCommandResult(request.params);
		if (request.method === "getWorkspace") return this.#ports.getWorkspace(request.params);
		if (request.method === "listModels") return this.#ports.listModels();
		if (request.method === "listWorkspaces") return this.#ports.listWorkspaces(request.params);
		if (request.method === "listConversations") return this.#ports.listConversations(request.params);
		const lease = await this.#workspace(
			request.params.workspaceId,
			request.method === "createWorkspace" ? request.params.name : undefined,
		);
		const workspace = lease.port;
		try {
			switch (request.method) {
				case "installToolPack":
					return await workspace.installToolPack(request.params);
				case "setToolPackEnabled":
					return await workspace.setToolPackEnabled(request.params);
				case "uninstallToolPack":
					return await workspace.uninstallToolPack(request.params);
				case "bindToolPack":
					return await workspace.bindToolPack(request.params);
				case "revokeToolPackBinding":
					return await workspace.revokeToolPackBinding(request.params);
				case "authorizeRetainedToolPack":
					return await workspace.authorizeRetainedToolPack(request.params);
				case "createWorkspace":
				case "openWorkspace":
					return { ...workspace.workspace };
				case "createConversation":
					return await workspace.createConversation(request.params);
				case "renameConversation":
					return await workspace.renameConversation(request.params);
				case "archiveConversation":
					return await workspace.archiveConversation(request.params);
				case "restoreConversation":
					return await workspace.restoreConversation(request.params);
				case "listActiveAgentContexts":
					return await workspace.listActiveAgentContexts(request.params);
				case "listPendingToolApprovals":
					return await workspace.listPendingToolApprovals(request.params);

				case "getConversationModel":
					return await workspace.getConversationModel(request.params);
				case "continueWorkspace":
					return await workspace.continueWorkspace();
				case "cancelExecution":
					return await workspace.cancelExecution(request.params);
				case "submit":
					return await workspace.submit(request.params);
				case "getReceipt":
					return await workspace.getReceipt(request.params.requestId);
				case "snapshot":
					return await workspace.snapshot(request.params);
				case "getHistory":
					return await workspace.getHistory(request.params);
				case "getMessageText":
					return await workspace.getMessageText(request.params);
				case "authorizeAgentContext":
					return await workspace.authorizeAgentContext(request.params);
				case "authorizeRetainedContext":
					return await workspace.authorizeRetainedContext(request.params);
				case "revokeAgentContext":
					return await workspace.revokeAgentContext(request.params);
				case "listAgentContexts":
					return await workspace.listAgentContexts(request.params);
				case "listToolApprovals":
					return await workspace.listToolApprovals(request.params);
				case "decideToolApproval":
					return await workspace.decideToolApproval(request.params);
				case "getFileOperation":
					return await workspace.getFileOperation(request.params);
			}
		} finally {
			lease.release();
		}
	}

	call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal): Promise<Result<M>> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		// execute validates the discriminated request before calling a port.
		return cancelWait(
			this.execute({ version: PROTOCOL_VERSION, expectedStoreId: this.#ports.storeId, method, params }) as Promise<
				Result<M>
			>,
			signal,
		);
	}
	observe(
		raw: Scope,
		listener: (frame: Frame) => void | Promise<void>,
		signal?: AbortSignal,
		onStatus?: (status: ObservationStatus) => void,
	): Promise<Subscription> {
		return this.#track(() => this.#observe(raw, listener, signal, onStatus));
	}
	async #observe(
		raw: Scope,
		listener: (frame: Frame) => void | Promise<void>,
		signal?: AbortSignal,
		onStatus?: (status: ObservationStatus) => void,
	): Promise<Subscription> {
		if (signal?.aborted) throw signal.reason;
		const scope = parseObservationScope(raw);
		const lease = await this.#workspace(scope.workspaceId);
		let disposed = false;
		let terminal = false;
		let setupComplete = false;
		let subscription: Subscription | undefined;
		let owned: Subscription | undefined;
		let removeAbort: (() => void) | undefined;
		const release = () => {
			lease.release();
			removeAbort?.();
			if (owned) this.#subscriptions.delete(owned);
		};
		const notify = (value: ObservationStatus) => {
			try {
				void Promise.resolve(onStatus?.(value)).catch(() => undefined);
			} catch {
				/* Consumer callbacks are isolated. */
			}
		};
		const status = (value: ObservationStatus) => {
			if (terminal) return;
			if (value.state === "closed") {
				terminal = true;
				if (setupComplete) release();
			}
			notify(value);
		};
		try {
			subscription = await lease.port.observe(
				scope,
				(frame) => (disposed ? undefined : listener(frame)),
				signal,
				status,
			);
		} catch (error) {
			release();
			throw error;
		}
		const source = subscription;
		let disposing: Promise<void> | undefined;
		const dispose = () => {
			disposed = true;
			signal?.removeEventListener("abort", abort);
			disposing ??= (async () => {
				await source.dispose();
				status({ state: "closed", reason: "disposed" });
				release();
			})().catch((error) => {
				disposing = undefined;
				throw error;
			});
			return disposing;
		};
		const abort = () => {
			void dispose().catch(() => undefined);
		};
		owned = { dispose };
		this.#subscriptions.add(owned);
		setupComplete = true;
		if (terminal) release();
		if (signal?.aborted) {
			await dispose();
			throw signal.reason;
		}
		if (!terminal) {
			signal?.addEventListener("abort", abort, { once: true });
			removeAbort = () => signal?.removeEventListener("abort", abort);
		}
		status({ state: "connected" });
		return owned;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#closing ??= (async () => {
			// Admission stops first; accepted calls must settle before releasing any writer or root owner.
			await Promise.allSettled([...this.#active]);
			const disposals = await Promise.allSettled([...this.#subscriptions].map((item) => item.dispose()));
			const disposalFailure = disposals.find((result) => result.status === "rejected");
			if (disposalFailure?.status === "rejected") throw disposalFailure.reason;
			await this.#cacheMutation;
			const results = await Promise.allSettled(
				[...this.#workspaces].map(async ([id, entry]) => {
					await entry.port.close();
					this.#workspaces.delete(id);
				}),
			);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			await this.#ports.close();
			this.#workspaces.clear();
		})();
		try {
			await this.#closing;
		} catch (error) {
			this.#closing = undefined;
			throw error;
		}
	}
}
