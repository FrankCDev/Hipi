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
	type SidebarPinPage,
} from "@hipi/work-runtime/contracts";
import type { LocalState } from "../local-state.ts";
import { parseStoredRequest } from "../recovery/stored-request.ts";

type PinCommand = Extract<Request, { method: "setConversationPinned" }>;
type OrderCommand = Extract<Request, { method: "reorderPinnedConversation" }>;
type MixedOrderCommand = Extract<Request, { method: "reorderSidebarPin" }>;
type PresentationCommand = PinCommand | OrderCommand | MixedOrderCommand;
type PinInput = Params<"setConversationPinned">;
export type PinLifecycle =
	| { phase: "initiated" | "admitted" | "retired"; input: Readonly<PinInput> }
	| { phase: "confirmed"; input: Readonly<PinInput>; result: Readonly<ConversationPresentation> };
type State = {
	pending: PresentationCommand | null;
	busy: boolean;
	failed: boolean;
	incompatible: boolean;
	notFound: boolean;
	rejected: boolean;
	result: ConversationPresentation | null;
	orderResult: PinnedConversationPage | null;
	mixedOrderResult: SidebarPinPage | null;
	order: boolean;
};
const key = "command.presentation";
const encode = (request: PresentationCommand | null) =>
	JSON.stringify(
		request?.method === "reorderSidebarPin"
			? { version: 3, kind: "mixed-pin-order", request }
			: { version: 2, request },
	);

function read(raw: string | null): { pending: PresentationCommand | null; incompatible: boolean } {
	if (!raw) return { pending: null, incompatible: false };
	try {
		const saved: unknown = JSON.parse(raw);
		if (saved && typeof saved === "object" && "version" in saved && saved.version === 3) {
			if (
				!("kind" in saved) ||
				saved.kind !== "mixed-pin-order" ||
				!("request" in saved) ||
				Object.keys(saved).some((field) => !["version", "kind", "request"].includes(field))
			)
				throw new Error("INVALID_RECOVERY");
			const input = saved.request;
			if (
				!input ||
				typeof input !== "object" ||
				!("version" in input) ||
				input.version !== PROTOCOL_VERSION ||
				Object.keys(input).some((field) => !["version", "method", "params"].includes(field))
			)
				throw new Error("INVALID_RECOVERY");
			const request = parseRequest(input);
			if (request.method !== "reorderSidebarPin" || request.expectedStoreId !== undefined)
				throw new Error("INVALID_RECOVERY");
			return { pending: request, incompatible: false };
		}
		if (
			!saved ||
			typeof saved !== "object" ||
			!("version" in saved) ||
			saved.version !== 2 ||
			!("request" in saved) ||
			Object.keys(saved).some((field) => field !== "version" && field !== "request")
		)
			throw new Error("INVALID_RECOVERY");
		if (saved.request === null) return { pending: null, incompatible: false };
		const request = parseStoredRequest(saved.request);
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
	readonly #pinListeners = new Set<(event: PinLifecycle) => void>();
	#request: AbortController | undefined;
	#disposed = false;
	#lifecycle = 0;
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
			mixedOrderResult: null,
			order: saved.pending?.method === "reorderPinnedConversation" || saved.pending?.method === "reorderSidebarPin",
		};
	}
	getSnapshot = () => this.#state;
	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	subscribePinLifecycle = (listener: (event: PinLifecycle) => void) => {
		this.#pinListeners.add(listener);
		return () => {
			this.#pinListeners.delete(listener);
		};
	};
	activate() {
		this.#disposed = false;
	}
	dispose() {
		this.#disposed = true;
		this.#lifecycle++;
		this.#request?.abort();
		this.#request = undefined;
		this.#state = { ...this.#state, busy: false };
		this.#listeners.clear();
		this.#pinListeners.clear();
	}
	#pinEvent(event: PinLifecycle) {
		if (this.#disposed) return;
		Object.freeze(event);
		for (const listener of this.#pinListeners) listener(event);
	}
	#publish(patch: Partial<State>) {
		if (this.#disposed) return;
		this.#state = {
			...this.#state,
			...patch,
			...(patch.pending
				? {
						order: patch.pending.method === "reorderPinnedConversation" || patch.pending.method === "reorderSidebarPin",
					}
				: {}),
		};
		for (const listener of this.#listeners) listener();
	}
	async #run(work: (signal: AbortSignal) => Promise<void>) {
		if (this.#disposed || this.#request || this.#state.incompatible) return;
		const controller = new AbortController();
		this.#request = controller;
		this.#publish({
			busy: true,
			failed: false,
			notFound: false,
			rejected: false,
			result: null,
			orderResult: null,
			mixedOrderResult: null,
		});
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
		this.#pinEvent({
			phase: "confirmed",
			input: Object.freeze({ ...input }),
			result: Object.freeze({ ...current }),
		});
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
	async #finishMixedOrder(command: MixedOrderCommand, result: Result<"reorderSidebarPin">, signal: AbortSignal) {
		signal.throwIfAborted();
		if (
			result.orderRevision !== command.params.expectedOrderRevision &&
			result.orderRevision !== command.params.expectedOrderRevision + 1
		)
			throw new Error("RESULT_MISMATCH");
		const current = await this.#client.call("listSidebarPins", {}, signal);
		signal.throwIfAborted();
		if (current.orderRevision < result.orderRevision) throw new Error("RESULT_MISMATCH");
		await this.#release(command, signal);
		this.#publish({ mixedOrderResult: current });
	}
	async #lookup(command: PresentationCommand, signal: AbortSignal): Promise<boolean> {
		if (command.method === "reorderSidebarPin") {
			const receipt = await this.#client.call(
				"getSidebarPinCommandResult",
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
			await this.#finishMixedOrder(command, receipt.result, signal);
			return true;
		}
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
			} else if (command.method === "reorderSidebarPin") {
				const result = await this.#client.call(command.method, command.params, signal);
				await this.#finishMixedOrder(command, result, signal);
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
				if (command.method === "setConversationPinned")
					this.#pinEvent({ phase: "retired", input: Object.freeze({ ...command.params }) });
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
	reorderMixed = async (input: Params<"reorderSidebarPin">) => {
		const command = parseRequest({
			version: PROTOCOL_VERSION,
			method: "reorderSidebarPin",
			params: { ...input, moved: { ...input.moved }, before: input.before ? { ...input.before } : null },
		});
		if (command.method === "reorderSidebarPin") await this.#admit(command);
	};
	async #admit(command: PresentationCommand) {
		const lifecycle = this.#lifecycle;
		let initiated = false;
		let admitted = false;
		await this.#run(async (signal) => {
			// Navigation may change while waiting for admission. This local request
			// boundary is distinct from observing another window's saved pending command.
			if (command.method === "setConversationPinned") {
				initiated = true;
				this.#pinEvent({ phase: "initiated", input: Object.freeze({ ...command.params }) });
			}
			await this.#local.withAdmission(key, () => {
				signal.throwIfAborted();
				const saved = read(this.#local.storedValue(key)?.value ?? null);
				this.#publish(saved);
				if (saved.pending || saved.incompatible) throw new Error("RECOVERY_PENDING");
				this.#local.persistValue({ kind: "value", key, value: encode(command) });
				admitted = true;
				this.#publish({ pending: command });
				if (command.method === "setConversationPinned")
					this.#pinEvent({ phase: "admitted", input: Object.freeze({ ...command.params }) });
			});
			signal.throwIfAborted();
			await this.#dispatch(command, signal);
		});
		if (lifecycle === this.#lifecycle && initiated && !admitted && command.method === "setConversationPinned")
			this.#pinEvent({ phase: "retired", input: Object.freeze({ ...command.params }) });
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
