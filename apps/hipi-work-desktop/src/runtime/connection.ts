import {
	AppError,
	parseError,
	parseFrame,
	parseObservationStatus,
	parseRequest,
	parseResult,
	type Request,
} from "@hipi/work-runtime/contracts";
import { FileConnection } from "../files/connection.ts";
import { decode, encode, exact, identifier, MAX_ACTIVE, observation, WAIT_MS } from "../ipc/protocol.ts";
import { PreviewConnection } from "../previews/connection.ts";

type Pending = {
	awaitingAck?: boolean;
	request?: Request;
	receive(value: object): void;
	end(): void;
	timer: ReturnType<typeof setTimeout>;
};
/** A utility incarnation owns every request ID. No queued request is replayed after host loss. */
export class HostConnection {
	readonly files: FileConnection;
	readonly previews: PreviewConnection;
	readonly generation: string;
	readonly #post: (raw: string) => void;
	readonly #onProtocolFailure: () => void;
	readonly #active = new Map<string, Pending>();
	#next = 0;
	#closed = false;
	constructor(generation: string, post: (raw: string) => void, onProtocolFailure: () => void = () => {}) {
		this.generation = generation;
		this.files = new FileConnection(generation, post);
		this.previews = new PreviewConnection(generation, post);
		this.#post = post;
		this.#onProtocolFailure = onProtocolFailure;
	}
	#send(value: object) {
		if (this.#closed) throw new AppError("CLOSED");
		this.#post(encode({ generation: this.generation, ...value }));
	}
	#register(receive: (value: object) => void, end: () => void, request?: Request) {
		if (this.#closed) throw new AppError("CLOSED");
		if (this.#active.size >= MAX_ACTIVE) throw new AppError("CAPACITY_EXCEEDED");
		const id = String(++this.#next);
		const timer = setTimeout(() => this.cancel(id), WAIT_MS);
		this.#active.set(id, { request, receive, end, timer });
		return id;
	}
	call(raw: unknown): { result: Promise<object>; cancel(): void } {
		const request = parseRequest(raw);
		let id = "";
		const result = new Promise<object>((resolve, reject) => {
			try {
				id = this.#register(resolve, () => resolve({ ok: false, error: "CLOSED" }), request);
				this.#send({ id, kind: "call", request });
			} catch (error) {
				if (id) this.cancel(id);
				reject(error);
			}
		});
		return { result, cancel: () => this.cancel(id) };
	}
	observe(raw: unknown, listener: (value: object) => void): { ack(): void; dispose(): void } {
		const input = observation(raw);
		const id = this.#register(listener, () =>
			listener({ kind: "status", status: { state: "closed", reason: "disconnected" } }),
		);
		try {
			this.#send({ id, kind: "observe", input });
		} catch (error) {
			this.cancel(id);
			throw error;
		}
		return {
			ack: () => {
				const pending = this.#active.get(id);
				if (!pending) return;
				if (!pending.awaitingAck) return;
				pending.awaitingAck = false;
				clearTimeout(pending.timer);
				// A quiet observation is valid; each frame starts a separate acknowledgement deadline.
				try {
					this.#send({ id, kind: "ack" });
				} catch {
					this.close();
				}
			},
			dispose: () => this.cancel(id),
		};
	}
	receive(raw: unknown) {
		try {
			if (this.previews.receive(raw) || this.files.receive(raw)) return;
			const value = decode(raw);
			if (value.generation !== this.generation) return;
			const id = identifier(value.id);
			const pending = this.#active.get(id);
			if (!pending) return;
			if (value.kind === "error") {
				exact(value, ["generation", "id", "kind", "error"]);
				pending.receive(
					pending.request
						? { ok: false, error: parseError(value.error) }
						: { kind: "status", status: { state: "closed", reason: "error", code: parseError(value.error) } },
				);
				this.#remove(id);
			} else if (value.kind === "result" && pending.request) {
				exact(value, ["generation", "id", "kind", "result"]);
				pending.receive({ ok: true, result: parseResult(pending.request.method, value.result) });
				this.#remove(id);
			} else if (value.kind === "frame" && !pending.request) {
				exact(value, ["generation", "id", "kind", "frame"]);
				if (pending.awaitingAck) throw new AppError("INVALID_REQUEST");
				pending.awaitingAck = true;
				clearTimeout(pending.timer);
				pending.timer = setTimeout(() => this.cancel(id), WAIT_MS);
				pending.receive({ kind: "frame", frame: parseFrame(value.frame) });
			} else if (value.kind === "status" && !pending.request) {
				exact(value, ["generation", "id", "kind", "status"]);
				const status = parseObservationStatus(value.status);
				if (status.state !== "closed") throw new AppError("INVALID_REQUEST");
				pending.receive({ kind: "status", status });
				this.#remove(id);
			} else throw new AppError("INVALID_REQUEST");
		} catch {
			this.close();
			this.#onProtocolFailure();
		}
	}
	#remove(id: string) {
		const pending = this.#active.get(id);
		if (pending) clearTimeout(pending.timer);
		this.#active.delete(id);
	}
	cancel(id: string) {
		const pending = this.#active.get(id);
		if (!pending) return;
		this.#remove(id);
		try {
			this.#send({ kind: "cancel", id });
		} catch {
			/* Outcome remains unknown. */
		}
		try {
			pending.end();
		} catch {
			/* A failed renderer cannot retain other waits. */
		}
	}
	close() {
		if (this.#closed) return;
		this.previews.close();
		this.files.close();
		for (const id of this.#active.keys()) {
			try {
				this.#send({ kind: "cancel", id });
			} catch {
				/* Host may already be gone. */
			}
		}
		this.#closed = true;
		for (const [id, pending] of this.#active) {
			this.#remove(id);
			try {
				pending.end();
			} catch {
				/* A failed renderer cannot retain other waits. */
			}
		}
	}
	get activeCount() {
		return this.#active.size;
	}
}
