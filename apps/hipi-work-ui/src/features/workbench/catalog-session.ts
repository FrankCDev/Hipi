import { type AppClient, AppError, type Conversation, type Workspace } from "@hipi/work-runtime/contracts";
import { type CatalogCommand, readCommand, saveCommand } from "./command-recovery.ts";
import type { LocalState } from "./local-state.ts";

export type CatalogState = {
	pending: CatalogCommand | null;
	incompatible: boolean;
	busy: boolean;
	failed: boolean;
	notFound: boolean;
	result: Conversation | Workspace | null;
	resultMethod: CatalogCommand["method"] | null;
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
		const saved = readCommand(local, "catalog");
		const pending = saved.request;
		const catalog =
			pending &&
			(pending.method === "createWorkspace" ||
				pending.method === "createConversation" ||
				pending.method === "renameConversation" ||
				pending.method === "archiveConversation" ||
				pending.method === "restoreConversation")
				? pending
				: null;
		this.state = {
			pending: catalog,
			incompatible: saved.incompatible || (pending !== null && catalog === null),
			busy: false,
			failed: false,
			notFound: false,
			result: null,
			resultMethod: null,
		};
	}
	getSnapshot = () => this.state;
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
		this.publish({ busy: true, failed: false, notFound: false, result: null });
		let stopWaiting: (() => void) | undefined;
		try {
			await Promise.race([
				work(controller.signal),
				new Promise<never>((_, reject) => {
					stopWaiting = () => reject(new Error("WAIT_ABORTED"));
					controller.signal.addEventListener("abort", stopWaiting, { once: true });
				}),
			]);
		} catch {
			if (this.request === controller) this.publish({ failed: true });
		} finally {
			clearTimeout(timeout);
			if (stopWaiting) controller.signal.removeEventListener("abort", stopWaiting);
			if (this.request === controller) {
				this.request = undefined;
				this.publish({ busy: false });
			}
		}
	}
	private async finish(command: CatalogCommand, result: Workspace | Conversation, signal: AbortSignal) {
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
		saveCommand(this.local, "catalog", null);
		this.publish({ pending: null, result, resultMethod: command.method, notFound: false });
	}
	private async lookup(signal: AbortSignal) {
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
		await this.finish(command, receipt.result, signal);
	}
	check = () => this.run((signal) => this.lookup(signal));
	execute = (command: CatalogCommand) => {
		if (this.state.pending || this.state.incompatible || this.state.busy) return Promise.resolve();
		const captured = structuredClone(command);
		return this.run(async (signal) => {
			saveCommand(this.local, "catalog", captured);
			this.publish({ pending: captured });
			await this.send(captured, signal);
		});
	};
	/** Explicit user retry only, after an exact lookup. Never a new identity or edited payload. */
	retry = () => {
		const command = this.state.pending;
		if (!command || !this.state.notFound) return Promise.resolve();
		return this.run((signal) => this.send(command, signal));
	};
	private async send(command: CatalogCommand, signal: AbortSignal) {
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
