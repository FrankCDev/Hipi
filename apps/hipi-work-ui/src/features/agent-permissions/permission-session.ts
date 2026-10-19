import {
	type AgentContext,
	type AgentContextRequest,
	type AppClient,
	AppError,
	type FileOperation,
	PROTOCOL_VERSION,
	type RetainedContextRequest,
	type Scope,
	type ToolApproval,
	type ToolApprovalPage,
} from "@hipi/work-runtime/contracts";
import { type AgentCommand, readCommand, saveCommand } from "../workbench/command-recovery.ts";
import type { LocalState } from "../workbench/local-state.ts";

export const MAX_UNRESOLVED_OPERATIONS = 64;

export type PermissionState = {
	contexts: AgentContext[];
	activeContexts: AgentContext[];
	contextMode: "active" | "history";
	contextCursor: string | null;
	approvalMode: "pending" | "history";
	approval: ToolApproval | null;
	operation: FileOperation | null;
	unresolvedOperations: FileOperation[];
	checkedOperation: FileOperation | null;
	operationLimitReached: boolean;
	nextCursor: string | null;
	busy: boolean;
	failed: boolean;
	uncertain: boolean;
	incompatible: boolean;
	notFound: boolean;
	loaded: boolean;
};
/** Bounded current/history projections. Unknown commands use exact read-only result lookup. */
export class PermissionSession {
	private client: AppClient;
	private scope: Scope;
	private local: LocalState | undefined;
	private recoveryKey: string;
	private listeners = new Set<() => void>();
	private request: AbortController | null = null;
	private disposed = false;
	private cursor: string | undefined;
	private contextPage: string | undefined;
	private unresolved: AgentCommand | null = null;
	private state: PermissionState = {
		contexts: [],
		activeContexts: [],
		contextMode: "active",
		contextCursor: null,
		approvalMode: "pending",
		approval: null,
		operation: null,
		unresolvedOperations: [],
		checkedOperation: null,
		operationLimitReached: false,
		nextCursor: null,
		busy: false,
		failed: false,
		uncertain: false,
		incompatible: false,
		notFound: false,
		loaded: false,
	};
	constructor(client: AppClient, scope: Scope, local?: LocalState) {
		this.client = client;
		this.scope = { workspaceId: scope.workspaceId, conversationId: scope.conversationId };
		this.local = local;
		this.recoveryKey = `permissions.${scope.workspaceId}.${scope.conversationId}`;
		const saved = readCommand(local, this.recoveryKey);
		const command = saved.request;
		if (
			command &&
			(command.method === "authorizeAgentContext" ||
				command.method === "authorizeRetainedContext" ||
				command.method === "revokeAgentContext" ||
				command.method === "decideToolApproval") &&
			this.inScope(command.params)
		)
			this.unresolved = command;
		this.state.incompatible = saved.incompatible || (command !== null && this.unresolved === null);
		this.state.uncertain = this.unresolved !== null || this.state.incompatible;
	}
	getSnapshot = () => this.state;
	getPending = () => (this.unresolved ? structuredClone(this.unresolved) : null);
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private inScope(item: Scope) {
		return item.workspaceId === this.scope.workspaceId && item.conversationId === this.scope.conversationId;
	}
	private publish(patch: Partial<PermissionState>) {
		if (!this.disposed) {
			this.state = { ...this.state, ...patch };
			for (const listener of this.listeners) listener();
		}
	}
	private async run(work: (signal: AbortSignal) => Promise<void>) {
		if (this.disposed || this.request) return;
		const request = new AbortController();
		this.request = request;
		const timeout = setTimeout(() => request.abort(), 15000);
		this.publish({ busy: true, failed: false });
		let stopWaiting: (() => void) | undefined;
		try {
			await Promise.race([
				work(request.signal),
				new Promise<never>((_, reject) => {
					stopWaiting = () => reject(new Error("WAIT_ABORTED"));
					request.signal.addEventListener("abort", stopWaiting, { once: true });
				}),
			]);
		} catch {
			if (this.request === request)
				this.publish({ failed: true, uncertain: this.unresolved !== null || this.state.incompatible });
		} finally {
			clearTimeout(timeout);
			if (stopWaiting) request.signal.removeEventListener("abort", stopWaiting);
			if (this.request === request) {
				this.request = null;
				this.publish({ busy: false });
			}
		}
	}
	private matches(command: AgentCommand, result: AgentContext | ToolApproval) {
		if (!this.inScope(result)) return false;
		const p = command.params;
		if (command.method === "decideToolApproval")
			return (
				"approvalId" in result &&
				result.approvalId === command.params.approvalId &&
				result.argumentsDigest === command.params.argumentsDigest &&
				result.contentDigest === command.params.contentDigest &&
				result.revision > command.params.expectedRevision
			);
		if (!("grantId" in result) || "approvalId" in result) return false;
		if (command.method === "revokeAgentContext")
			return result.grantId === command.params.grantId && result.revision > command.params.expectedRevision;
		if (!("model" in p)) return false;
		if (
			result.requestId !== p.requestId ||
			result.model.provider !== p.model.provider ||
			result.model.modelId !== p.model.modelId ||
			result.expiresAt !== p.expiresAt ||
			result.disclosureVersion !== p.disclosureVersion
		)
			return false;
		if (command.method === "authorizeAgentContext")
			return (
				result.purpose === "live-files" &&
				result.rootId === command.params.rootId &&
				JSON.stringify(result.pathPrefixes) === JSON.stringify(command.params.pathPrefixes)
			);
		const source = [...this.state.contexts, ...this.state.activeContexts].find(
			(item) => item.grantId === command.params.sourceGrantId && item.purpose === "live-files",
		);
		return (
			result.purpose === "retained-context" &&
			result.sourceGrantId === command.params.sourceGrantId &&
			(!source ||
				(result.rootId === source.rootId &&
					JSON.stringify(result.pathPrefixes) === JSON.stringify(source.pathPrefixes)))
		);
	}
	private resolve(command: AgentCommand, result: AgentContext | ToolApproval, signal: AbortSignal) {
		signal.throwIfAborted();
		if (!this.matches(command, result)) throw new Error("COMMAND_MISMATCH");
		saveCommand(this.local, this.recoveryKey, null);
		this.unresolved = null;
		this.publish({ uncertain: false, notFound: false });
	}
	private async check(signal: AbortSignal) {
		const command = this.unresolved;
		if (!command) return;
		const receipt = await this.client.call(
			"getAgentCommandResult",
			{ ...this.scope, requestId: command.params.requestId },
			signal,
		);
		signal.throwIfAborted();
		if (!receipt) {
			this.publish({ uncertain: true, notFound: true });
			return;
		}
		if (receipt.method !== command.method) throw new Error("COMMAND_MISMATCH");
		this.resolve(command, receipt.result, signal);
	}
	private async read(signal: AbortSignal, reconcile = false) {
		await this.check(signal);
		const activeContexts = await this.client.call("listActiveAgentContexts", this.scope, signal);
		signal.throwIfAborted();
		const contextPage =
			this.state.contextMode === "history"
				? await this.client.call(
						"listAgentContexts",
						{ ...this.scope, ...(this.contextPage ? { cursor: this.contextPage } : {}) },
						signal,
					)
				: null;
		signal.throwIfAborted();
		const contexts = contextPage?.items ?? activeContexts;
		if ([...contexts, ...activeContexts].some((item) => !this.inScope(item))) throw new Error("SCOPE_MISMATCH");
		// Capacity limits discovery, never command reconciliation or consent recovery.
		if (this.state.unresolvedOperations.length >= MAX_UNRESOLVED_OPERATIONS) {
			this.publish({
				contexts,
				activeContexts,
				contextCursor: contextPage?.nextCursor ?? null,
				loaded: true,
				operationLimitReached: true,
				uncertain: this.unresolved !== null || this.state.incompatible,
			});
			return;
		}
		const method = this.state.approvalMode === "pending" ? "listPendingToolApprovals" : "listToolApprovals";
		let page: ToolApprovalPage;
		try {
			page = await this.client.call(method, { ...this.scope, ...(this.cursor ? { cursor: this.cursor } : {}) }, signal);
		} catch (error) {
			if (!(error instanceof AppError) || error.code !== "CURSOR_STALE" || !this.cursor) throw error;
			signal.throwIfAborted();
			this.cursor = undefined;
			// One bounded read-only restart. A second failure propagates; commands are never replayed.
			page = await this.client.call(method, this.scope, signal);
		}
		signal.throwIfAborted();
		if (page.items.some((item) => !this.inScope(item))) throw new Error("SCOPE_MISMATCH");
		const approval = page.items[0] ?? null;
		const operation = approval?.operationId
			? await this.client.call(
					"getFileOperation",
					{ ...this.scope, operationId: approval.operationId, ...(reconcile ? { reconcile: true } : {}) },
					signal,
				)
			: null;
		signal.throwIfAborted();
		if (
			operation &&
			(!this.inScope(operation) ||
				operation.approvalId !== approval?.approvalId ||
				operation.operationId !== approval.operationId ||
				operation.taskId !== approval.taskId ||
				operation.callId !== approval.callId ||
				operation.rootId !== approval.rootId ||
				operation.path !== approval.path ||
				operation.argumentsDigest !== approval.argumentsDigest ||
				operation.contentDigest !== approval.contentDigest)
		)
			throw new Error("OPERATION_MISMATCH");
		this.publish({
			contexts,
			activeContexts,
			contextCursor: contextPage?.nextCursor ?? null,
			approval,
			operation,
			unresolvedOperations: operation ? this.trackOperation(operation) : this.state.unresolvedOperations,
			nextCursor: page.nextCursor,
			loaded: true,
			uncertain: this.unresolved !== null || this.state.incompatible,
		});
	}
	private sameOperation(expected: FileOperation, actual: FileOperation) {
		return (
			this.inScope(actual) &&
			actual.operationId === expected.operationId &&
			actual.approvalId === expected.approvalId &&
			actual.taskId === expected.taskId &&
			actual.callId === expected.callId &&
			actual.rootId === expected.rootId &&
			actual.path === expected.path &&
			actual.argumentsDigest === expected.argumentsDigest &&
			actual.contentDigest === expected.contentDigest &&
			actual.revision >= expected.revision &&
			(actual.revision !== expected.revision || actual.status === expected.status)
		);
	}
	private trackOperation(operation: FileOperation) {
		const previous = this.state.unresolvedOperations.find((item) => item.operationId === operation.operationId);
		if (previous && !this.sameOperation(previous, operation)) throw new Error("OPERATION_MISMATCH");
		const retained = this.state.unresolvedOperations.filter((item) => item.operationId !== operation.operationId);
		if (operation.status === "unknown" || operation.status === "executing") retained.push(structuredClone(operation));
		else if (operation.status === "prepared" && previous) retained.push(previous);
		return retained;
	}
	/** An explicit read-only check addresses retained evidence, never the current approval page. */
	reconcileOperation = (operationId: string) => {
		const expected = this.state.unresolvedOperations.find((item) => item.operationId === operationId);
		if (!expected) return Promise.resolve();
		return this.run(async (signal) => {
			const result = await this.client.call(
				"getFileOperation",
				{ ...this.scope, operationId, reconcile: true },
				signal,
			);
			signal.throwIfAborted();
			if (!result || !this.sameOperation(expected, result)) throw new Error("OPERATION_MISMATCH");
			const unresolvedOperations = this.trackOperation(result);
			this.publish({
				checkedOperation: result,
				unresolvedOperations,
				operationLimitReached: unresolvedOperations.length >= MAX_UNRESOLVED_OPERATIONS,
			});
		});
	};
	refresh = (reconcile = false) => this.run((signal) => this.read(signal, reconcile));
	page = (cursor?: string) => {
		if (this.state.busy || this.state.uncertain) return Promise.resolve();
		this.cursor = cursor;
		return this.refresh();
	};
	contextHistory = (mode: "active" | "history", cursor?: string) => {
		if (this.state.busy || this.state.uncertain) return Promise.resolve();
		this.contextPage = cursor;
		this.publish({ contextMode: mode });
		return this.refresh();
	};
	approvalHistory = (mode: "pending" | "history") => {
		if (this.state.busy || this.state.uncertain) return Promise.resolve();
		this.cursor = undefined;
		this.publish({ approvalMode: mode });
		return this.refresh();
	};
	authorize = (input: AgentContextRequest) =>
		this.mutate({ version: PROTOCOL_VERSION, method: "authorizeAgentContext", params: input });
	authorizeRetained = (input: RetainedContextRequest) => {
		const source = [...this.state.contexts, ...this.state.activeContexts].find(
			(context) => context.grantId === input.sourceGrantId && context.purpose === "live-files",
		);
		if (!source || !this.inScope(input)) return Promise.resolve();
		return this.mutate({ version: PROTOCOL_VERSION, method: "authorizeRetainedContext", params: input });
	};
	revoke = (context: AgentContext) =>
		this.mutate({
			version: PROTOCOL_VERSION,
			method: "revokeAgentContext",
			params: {
				...this.scope,
				requestId: crypto.randomUUID(),
				grantId: context.grantId,
				expectedRevision: context.revision,
			},
		});
	decide = (approval: ToolApproval, decision: "approve" | "reject") => {
		if (!canDecide(approval, this.state.activeContexts, Date.now()) || !this.inScope(approval))
			return Promise.resolve();
		return this.mutate({
			version: PROTOCOL_VERSION,
			method: "decideToolApproval",
			params: {
				...this.scope,
				requestId: crypto.randomUUID(),
				approvalId: approval.approvalId,
				expectedRevision: approval.revision,
				decision,
				argumentsDigest: approval.argumentsDigest,
				contentDigest: approval.contentDigest,
			},
		});
	};
	private mutate(command: AgentCommand) {
		if (
			!this.inScope(command.params) ||
			this.state.uncertain ||
			this.unresolved ||
			this.state.failed ||
			!this.state.loaded ||
			(command.method === "decideToolApproval" &&
				command.params.decision === "approve" &&
				this.state.unresolvedOperations.length >= MAX_UNRESOLVED_OPERATIONS)
		)
			return Promise.resolve();
		const captured = structuredClone(command);
		return this.run(async (signal) => {
			saveCommand(this.local, this.recoveryKey, captured);
			this.unresolved = captured;
			await this.send(captured, signal);
		});
	}
	/** Only explicit user action can resubmit the immutable original after a missing-result query. */
	retry = () => {
		const command = this.unresolved;
		if (!command || !this.state.notFound || this.state.incompatible) return Promise.resolve();
		return this.run((signal) => this.send(command, signal));
	};
	private async send(command: AgentCommand, signal: AbortSignal) {
		try {
			let result: AgentContext | ToolApproval;
			switch (command.method) {
				case "authorizeAgentContext":
					result = await this.client.call(command.method, command.params, signal);
					break;
				case "authorizeRetainedContext":
					result = await this.client.call(command.method, command.params, signal);
					break;
				case "revokeAgentContext":
					result = await this.client.call(command.method, command.params, signal);
					break;
				case "decideToolApproval":
					result = await this.client.call(command.method, command.params, signal);
					break;
			}
			this.resolve(command, result, signal);
		} catch {
			signal.throwIfAborted();
			this.publish({ uncertain: true });
		}
		await this.read(signal);
	}
	cancel() {
		this.request?.abort();
	}
	activate() {
		this.disposed = false;
	}
	dispose() {
		this.disposed = true;
		this.request?.abort();
		this.request = null;
		this.listeners.clear();
	}
}
export function canDecide(approval: ToolApproval, contexts: AgentContext[], now: number) {
	return (
		approval.status === "pending" &&
		approval.expiresAt > now &&
		contexts.some(
			(context) =>
				context.purpose === "live-files" &&
				context.workspaceId === approval.workspaceId &&
				context.conversationId === approval.conversationId &&
				context.rootId === approval.rootId &&
				context.model.provider === approval.model.provider &&
				context.model.modelId === approval.model.modelId &&
				context.grantId === approval.grantId &&
				context.revision === approval.grantRevision &&
				context.status === "active" &&
				context.expiresAt > now,
		)
	);
}
