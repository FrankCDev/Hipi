import {
	type AppClient,
	AppError,
	type ConversationPresentation,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	type Request,
} from "@hipi/work-runtime/contracts";
import type { LocalState } from "./local-state.ts";

type PinCommand = Extract<Request, { method: "setConversationPinned" }>;
type PinInput = Params<"setConversationPinned">;
type State = {
	pending: PinCommand | null;
	busy: boolean;
	failed: boolean;
	incompatible: boolean;
	notFound: boolean;
	rejected: boolean;
	result: ConversationPresentation | null;
};
const key = "command.presentation";
const encode = (request: PinCommand | null) => JSON.stringify({ version: 2, request });

function read(raw: string | null): { pending: PinCommand | null; incompatible: boolean } {
	if (!raw) return { pending: null, incompatible: false };
	try {
		const saved: unknown = JSON.parse(raw);
		if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 2 || !("request" in saved))
			throw new Error("INVALID_RECOVERY");
		if (saved.request === null) return { pending: null, incompatible: false };
		const request = parseRequest(saved.request);
		if (request.method === "setConversationPinned" && request.expectedStoreId === undefined)
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
		this.#state = {
			...read(local.read(key)),
			busy: false,
			failed: false,
			notFound: false,
			rejected: false,
			result: null,
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
		this.#listeners.clear();
	}
	#publish(patch: Partial<State>) {
		if (this.#disposed) return;
		this.#state = { ...this.#state, ...patch };
		for (const listener of this.#listeners) listener();
	}
	async #run(work: (signal: AbortSignal) => Promise<void>) {
		if (this.#disposed || this.#request || this.#state.incompatible) return;
		const controller = new AbortController();
		this.#request = controller;
		this.#publish({ busy: true, failed: false, notFound: false, rejected: false, result: null });
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
			if (this.#request === controller) this.#publish({ ...read(this.#local.read(key)), failed: true });
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
	async #release(command: PinCommand, signal: AbortSignal) {
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
	async #lookup(command: PinCommand, signal: AbortSignal): Promise<boolean> {
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
		if (receipt.method !== command.method || encode({ ...command, params: receipt.params }) !== encode(command))
			throw new Error("REQUEST_MISMATCH");
		await this.#finish(command, receipt.result, signal);
		return true;
	}
	async #dispatch(command: PinCommand, signal: AbortSignal) {
		try {
			const result = await this.#client.call(command.method, command.params, signal);
			await this.#finish(command, result, signal);
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
	};
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
