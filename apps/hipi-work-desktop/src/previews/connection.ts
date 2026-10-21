import { FileServiceError } from "@hipi/work-runtime/files";
import { type PreviewRequest, parsePreviewRequest, parsePreviewResponse } from "@hipi/work-runtime/previews/protocol";
import { decode, encode, exact, identifier, MAX_ACTIVE, WAIT_MS } from "../ipc/protocol.ts";

type Pending = {
	request: PreviewRequest;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};

/** Main owns waits, utility owns parse cancellation and handle lifetime. Never replay on restart. */
export class PreviewConnection {
	readonly #generation: string;
	readonly #post: (raw: string) => void;
	readonly #pending = new Map<string, Pending>();
	#next = 0;
	#closed = false;
	constructor(generation: string, post: (raw: string) => void) {
		this.#generation = generation;
		this.#post = post;
	}
	call(raw: unknown): { result: Promise<unknown>; cancel(): void } {
		const request = parsePreviewRequest(raw);
		if (this.#closed) throw new FileServiceError("CLOSED");
		if (this.#pending.size >= MAX_ACTIVE) throw new FileServiceError("BUSY");
		const id = String(++this.#next);
		const cancel = () => this.#cancel(id);
		const result = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(cancel, WAIT_MS);
			this.#pending.set(id, { request, resolve, reject, timer });
			try {
				this.#post(encode({ generation: this.#generation, kind: "previewCall", id, input: request }));
			} catch {
				this.close();
			}
		});
		return { result, cancel };
	}
	#cancel(id: string) {
		const pending = this.#pending.get(id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.#pending.delete(id);
		try {
			this.#post(encode({ generation: this.#generation, kind: "previewCancel", id }));
		} catch {
			/* The utility may already be gone. */
		}
		pending.reject(new FileServiceError("CLOSED"));
	}
	receive(raw: unknown): boolean {
		const value = decode(raw);
		if (value.kind !== "previewResult") return false;
		if (value.generation !== this.#generation) return true;
		exact(value, ["generation", "kind", "id", "ok", ...(value.ok === true ? ["result"] : ["error"])]);
		const id = identifier(value.id);
		const pending = this.#pending.get(id);
		if (!pending) {
			// Cancellation can cross a successful open reply in flight. Reclaim its orphaned handle.
			if (!this.#closed && value.ok === true) {
				const rawResult = value.result;
				if (rawResult && typeof rawResult === "object" && "request" in rawResult) {
					const request = parsePreviewRequest(rawResult.request);
					const response = parsePreviewResponse(rawResult, request);
					if (request.method === "open" && response.ok && response.result) {
						try {
							void this.call({
								version: 1,
								expectedStoreId: request.expectedStoreId,
								method: "close",
								params: { id: response.result.id },
							}).result.catch(() => undefined);
						} catch {
							/* Utility teardown and bounded TTL are the final cleanup backstop. */
						}
					}
				}
			}
			return true;
		}
		let result: unknown;
		let error: FileServiceError | undefined;
		if (value.ok === true) result = parsePreviewResponse(value.result, pending.request);
		else if (value.ok === false) {
			const code = (
				[
					"INVALID_PATH",
					"UNAUTHORIZED",
					"NOT_FOUND",
					"BLOCKED_RESOURCE",
					"LIMIT_EXCEEDED",
					"BUSY",
					"CLOSED",
					"IO_ERROR",
				] as const
			).find((code) => code === value.error);
			if (!code) throw new FileServiceError("INVALID_PATH");
			error = new FileServiceError(code);
		} else throw new FileServiceError("INVALID_PATH");
		clearTimeout(pending.timer);
		this.#pending.delete(id);
		if (error) pending.reject(error);
		else pending.resolve(result);
		return true;
	}
	close() {
		this.#closed = true;
		for (const id of this.#pending.keys()) this.#cancel(id);
	}
}
