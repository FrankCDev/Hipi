import {
	type AppClient,
	AppError,
	type ConversationPresentation,
	type Params,
	type PinnedConversationPage,
	PROTOCOL_VERSION,
	parseRequest,
	type Request,
	type Result,
} from "@hipi/work-runtime/contracts";
import type { LocalState } from "./local-state.ts";

type PinCommand = Extract<Request, { method: "setConversationPinned" }>;
type OrderCommand = Extract<Request, { method: "reorderPinnedConversation" }>;
type PresentationCommand = PinCommand | OrderCommand;
type PinInput = Params<"setConversationPinned">;
type State = {
	pending: PresentationCommand | null;
	busy: boolean;
	failed: boolean;
	incompatible: boolean;
	notFound: boolean;
	rejected: boolean;
	result: ConversationPresentation | null;
	orderResult: PinnedConversationPage | null;
	order: boolean;
};
const key = "command.presentation";
const encode = (request: PresentationCommand | null) => JSON.stringify({ version: 2, request });

function read(raw: string | null): { pending: PresentationCommand | null; incompatible: boolean } {
	if (!raw) return { pending: null, incompatible: false };
	try {
		const saved: unknown = JSON.parse(raw);
		if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 2 || !("request" in saved))
			throw new Error("INVALID_RECOVERY");
		if (saved.request === null) return { pending: null, incompatible: false };
		const request = parseRequest(saved.request);
		if (
			(request.method === "setConversationPinned" || request.method === "reorderPinnedConversation") &&
			request.expectedStoreId === undefined
		)
			return { pending: request, incompatible: false };
	} catch {
		// Preserve an unrecognized record. Never invent its original identity or intent.
	}
	return { pending: null, incompatible: true };
}

/** Store-scoped presentation commands never acquire execution, draft, or permission ownership. */
export class PresentationSession {
	readonly #client: AppClient;
	readonly #local: LocalState;
	readonly #listeners = new Set<() => void>();
	#request: AbortController | undefined;
	#disposed = false;
	#state: State;
	constructor(client: AppClient, local: LocalState) {
		this.#client = client;
		this.#local = local;
		const saved = read(local.read(key));
		this.#state = {
			...saved,
			busy: false,
			failed: false,
			notFound: false,
			rejected: false,
			result: null,
			orderResult: null,
			order: saved.pending?.method === "reorderPinnedConversation",
		};
	}
	getSnapshot = () => this.#state;
	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	activate() {
		this.#disposed = false;
	}
	dispose() {
		this.#disposed = true;
		this.#request?.abort();
		this.#request = undefined;
		this.#state = { ...this.#state, busy: false };
		this.#listeners.clear();
	}
	#publish(patch: Partial<State>) {
		if (this.#disposed) return;
		this.#state = {
			...this.#state,
			...patch,
			...(patch.pending ? { order: patch.pending.method === "reorderPinnedConversation" } : {}),
		};
		for (const listener of this.#listeners) listener();
	}
	async #run(work: (signal: AbortSignal) => Promise<void>) {
		if (this.#disposed || this.#request || this.#state.incompatible) return;
		const controller = new AbortController();
		this.#request = controller;
		this.#publish({ busy: true, failed: false, notFound: false, rejected: false, result: null, orderResult: null });
		const timeout = setTimeout(() => controller.abort(), 15000);
		let abort: (() => void) | undefined;
		try {
			await Promise.race([
				work(controller.signal),
				new Promise<never>((_, reject) => {
					abort = () => reject(new Error("WAIT_ABORTED"));
					controller.signal.addEventListener("abort", abort, { once: true });
				}),
			]);
		} catch {
			// #current/#admit already published authoritative locked storage. Another tab's
			// command may not exist in this LocalState's startup cache.
			if (this.#request === controller) this.#publish({ failed: true });
		} finally {
			clearTimeout(timeout);
			if (abort) controller.signal.removeEventListener("abort", abort);
			if (this.#request === controller) {
				this.#request = undefined;
				this.#publish({ busy: false });
			}
		}
	}
	async #current(signal: AbortSignal) {
		return this.#local.withAdmission(key, () => {
			signal.throwIfAborted();
			const saved = read(this.#local.storedValue(key)?.value ?? null);
			this.#publish(saved);
			if (saved.incompatible) throw new Error("INVALID_RECOVERY");
			return saved.pending;
		});
	}
	async #release(command: PresentationCommand, signal: AbortSignal) {
		await this.#local.withAdmission(key, () => {
			signal.throwIfAborted();
			const saved = read(this.#local.storedValue(key)?.value ?? null);
			if (saved.incompatible || encode(saved.pending) !== encode(command)) throw new Error("RECOVERY_CHANGED");
			this.#local.persistValue({ kind: "value", key, value: encode(null) });
		});
		signal.throwIfAborted();
		this.#publish({ pending: null, notFound: false });
	}
	async #finish(command: PinCommand, result: ConversationPresentation, signal: AbortSignal) {
		signal.throwIfAborted();
		const input = command.params;
		if (
			result.workspaceId !== input.workspaceId ||
			result.conversationId !== input.conversationId ||
			result.pinned !== input.pinned ||
			(result.revision !== input.expectedPresentationRevision &&
				result.revision !== input.expectedPresentationRevision + 1)
		)
			throw new Error("RESULT_MISMATCH");
		// Receipts are historical. A replay must not visually restore an old pin after later unpin/archive.
		const current = await this.#client.call(
			"getConversationPresentation",
			{ workspaceId: input.workspaceId, conversationId: input.conversationId },
			signal,
		);
		signal.throwIfAborted();
		if (
			current.workspaceId !== input.workspaceId ||
			current.conversationId !== input.conversationId ||
			current.revision < result.revision
		)
			throw new Error("RESULT_MISMATCH");
		await this.#release(command, signal);
		this.#publish({ result: current });
	}
	async #finishOrder(command: OrderCommand, result: Result<"reorderPinnedConversation">, signal: AbortSignal) {
		signal.throwIfAborted();
		if (
			result.orderGeneration !== command.params.expectedOrderGeneration &&
			result.orderGeneration !== command.params.expectedOrderGeneration + 1
		)
			throw new Error("RESULT_MISMATCH");
		// A receipt proves this operation, not today's list placement. Never apply historical order.
		const current = await this.#client.call("listPinnedConversations", {}, signal);
		signal.throwIfAborted();
		if (current.orderGeneration < result.orderGeneration) throw new Error("RESULT_MISMATCH");
		await this.#release(command, signal);
		this.#publish({ orderResult: current });
	}
	async #lookup(command: PresentationCommand, signal: AbortSignal): Promise<boolean> {
		const receipt = await this.#client.call(
			"getPresentationCommandResult",
			{ requestId: command.params.requestId },
			signal,
		);
		signal.throwIfAborted();
		if (!receipt) {
			this.#publish({ notFound: true });
			return false;
		}
		if (receipt.method !== command.method || JSON.stringify(receipt.params) !== JSON.stringify(command.params))
			throw new Error("REQUEST_MISMATCH");
		if (command.method === "setConversationPinned" && receipt.method === "setConversationPinned")
			await this.#finish(command, receipt.result, signal);
		else if (command.method === "reorderPinnedConversation" && receipt.method === "reorderPinnedConversation")
			await this.#finishOrder(command, receipt.result, signal);
		return true;
	}
	async #dispatch(command: PresentationCommand, signal: AbortSignal) {
		try {
			if (command.method === "setConversationPinned") {
				const result = await this.#client.call(command.method, command.params, signal);
				await this.#finish(command, result, signal);
			} else {
				const result = await this.#client.call(command.method, command.params, signal);
				await this.#finishOrder(command, result, signal);
			}
		} catch (error) {
			signal.throwIfAborted();
			if (await this.#lookup(command, signal)) return;
			// These runtime contract rejections happen before mutation. Network/timeout failures do not.
			if (
				error instanceof AppError &&
				["IDEMPOTENCY_CONFLICT", "NOT_FOUND", "CONVERSATION_ARCHIVED", "INVALID_REQUEST"].includes(error.code)
			) {
				await this.#release(command, signal);
				this.#publish({ rejected: true, failed: true });
			}
		}
	}
	execute = async (input: PinInput) => {
		// Snapshot the explicit action before lock admission. No later menu state changes its payload.
		const command = parseRequest({
			version: PROTOCOL_VERSION,
			method: "setConversationPinned",
			params: { ...input },
		});
		if (command.method !== "setConversationPinned") return;
		await this.#admit(command);
	};
	reorder = async (input: Params<"reorderPinnedConversation">) => {
		const command = parseRequest({
			version: PROTOCOL_VERSION,
			method: "reorderPinnedConversation",
			params: { ...input, moved: { ...input.moved }, before: input.before ? { ...input.before } : null },
		});
		if (command.method === "reorderPinnedConversation") await this.#admit(command);
	};
	async #admit(command: PresentationCommand) {
		await this.#run(async (signal) => {
			await this.#local.withAdmission(key, () => {
				signal.throwIfAborted();
				const saved = read(this.#local.storedValue(key)?.value ?? null);
				this.#publish(saved);
				if (saved.pending || saved.incompatible) throw new Error("RECOVERY_PENDING");
				this.#local.persistValue({ kind: "value", key, value: encode(command) });
				this.#publish({ pending: command });
			});
			signal.throwIfAborted();
			await this.#dispatch(command, signal);
		});
	}
	check = () =>
		this.#run(async (signal) => {
			const command = await this.#current(signal);
			if (command) await this.#lookup(command, signal);
		});
	retry = () =>
		this.#run(async (signal) => {
			const command = await this.#current(signal);
			if (command && !(await this.#lookup(command, signal))) await this.#dispatch(command, signal);
		});
}
