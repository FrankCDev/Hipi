import type { ChildProcess } from "node:child_process";
import {
	type AppClient,
	AppError,
	LIMITS,
	type Method,
	type ObservationStatus,
	type Params,
	PROTOCOL_VERSION,
	parseError,
	parseFrame,
	parseObservationScope,
	parseObservationStatus,
	parseRequest,
	parseResult,
	type Result,
	type Subscription,
} from "./contracts.ts";
import type { TransportRuntime } from "./transport-http.ts";

function decode(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMITS.frameBytes) throw new AppError("INVALID_REQUEST");
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INVALID_REQUEST");
	return value as Record<string, unknown>;
}
function wireId(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new AppError("INVALID_REQUEST");
	return value;
}

/** Only the inherited Node child channel is accepted. Electron sender/preload policy is not implemented here. */
export function serveNodeIpc(runtime: TransportRuntime, peer: NodeJS.Process = process): () => void {
	if (!peer.send || !peer.connected) throw new AppError("CLOSED");
	const active = new Map<string, AbortController>();
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		peer.off("message", onMessage);
		peer.off("disconnect", close);
		for (const controller of active.values()) controller.abort();
		active.clear();
		// This adapter owns the inherited channel; silent shutdown would strand ready subscriptions.
		try {
			if (peer.connected) peer.disconnect?.();
		} catch {
			/* Already disconnected. */
		}
	};
	const send = (message: object) => {
		if (closed || !peer.connected || !peer.send) return;
		const encoded = JSON.stringify(message);
		if (Buffer.byteLength(encoded) > LIMITS.frameBytes) {
			close();
			return;
		}
		try {
			if (
				!peer.send(encoded, (error) => {
					if (error) close();
				})
			)
				close();
		} catch {
			close();
		}
	};
	async function handle(raw: unknown) {
		let id: string | undefined;
		let controller: AbortController | undefined;
		let subscription: Subscription | undefined;
		try {
			const message = decode(raw);
			id = wireId(message.id);
			const keys =
				message.kind === "call"
					? ["kind", "id", "request"]
					: message.kind === "observe"
						? ["kind", "id", "scope", "expectedStoreId"]
						: ["kind", "id"];
			if (Object.keys(message).some((key) => !keys.includes(key))) throw new AppError("INVALID_REQUEST");
			if (message.kind === "cancelWait") {
				active.get(id)?.abort();
				return;
			}
			if (active.has(id)) {
				send({ id, kind: "error", error: "INVALID_REQUEST" });
				return;
			}
			if (active.size >= 16) {
				send({ id, kind: "error", error: "CAPACITY_EXCEEDED" });
				return;
			}
			controller = new AbortController();
			active.set(id, controller);
			if (message.kind === "call") {
				const request = parseRequest(message.request);
				const result = parseResult(request.method, await runtime.execute(request, controller.signal));
				if (!controller.signal.aborted) send({ id, kind: "result", result });
			} else if (message.kind === "observe") {
				await runtime.execute({
					version: PROTOCOL_VERSION,
					method: "snapshot",
					params: message.scope,
					expectedStoreId: message.expectedStoreId,
				});
				subscription = await runtime.observe(
					parseObservationScope(message.scope),
					(frame) => {
						if (!controller?.signal.aborted) send({ id, kind: "frame", frame });
					},
					controller.signal,
					(status) => {
						if (status.state !== "closed" || controller?.signal.aborted) return;
						send({
							id,
							kind: "status",
							status: { ...status, reason: status.reason === "disposed" ? "disconnected" : status.reason },
						});
						controller?.abort();
					},
				);
				if (!controller.signal.aborted)
					await new Promise<void>((resolve) =>
						controller?.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
			} else throw new AppError("INVALID_REQUEST");
		} catch (error) {
			if (id) send({ id, kind: "error", error: error instanceof AppError ? error.code : "INTERNAL" });
		} finally {
			await subscription?.dispose();
			if (id && controller) active.delete(id);
		}
	}
	function onMessage(raw: unknown) {
		void handle(raw).catch(close);
	}
	peer.on("message", onMessage);
	peer.once("disconnect", close);
	return close;
}

export function createNodeIpcClient(child: ChildProcess): AppClient & { close(): void } {
	let next = 0;
	let closed = false;
	const pending = new Map<
		string,
		{ receive(message: Record<string, unknown>): void; fail(reason?: "disposed" | "disconnected"): void }
	>();
	const send = (value: object) => {
		const raw = JSON.stringify(value);
		if (closed || !child.connected) throw new AppError("CLOSED");
		if (Buffer.byteLength(raw) > LIMITS.frameBytes) throw new AppError("INVALID_REQUEST");
		if (
			!child.send(raw, (error) => {
				if (error) close();
			})
		)
			close();
	};
	function close(reason: "disposed" | "disconnected" = "disconnected") {
		if (closed) return;
		// Release only observations/waits. Do not kill the runtime or cancel accepted submissions.
		closed = true;
		for (const id of pending.keys()) {
			try {
				if (child.connected) child.send(JSON.stringify({ id, kind: "cancelWait" }), () => {});
			} catch {
				/* The peer may already be gone. */
			}
		}
		child.off("message", onMessage);
		child.off("disconnect", onDisconnect);
		child.off("exit", onDisconnect);
		child.off("error", onDisconnect);
		for (const waiter of pending.values()) waiter.fail(reason);
		pending.clear();
	}
	function onMessage(raw: unknown) {
		try {
			const message = decode(raw);
			pending.get(wireId(message.id))?.receive(message);
		} catch {
			close();
		}
	}
	const onDisconnect = () => close();
	child.on("message", onMessage);
	child.once("disconnect", onDisconnect);
	child.once("exit", onDisconnect);
	child.once("error", onDisconnect);
	let storeId: string | undefined;
	const client: AppClient & { close(): void } = {
		close: () => close("disposed"),
		async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal): Promise<Result<M>> {
			if (method !== "handshake" && !storeId) await client.call("handshake", {}, signal);
			return new Promise((resolve, reject) => {
				if (closed || signal?.aborted) {
					reject(new AppError("CLOSED"));
					return;
				}
				if (pending.size >= 16) {
					reject(new AppError("CAPACITY_EXCEEDED"));
					return;
				}
				const id = String(++next);
				const cleanup = () => {
					clearTimeout(timer);
					pending.delete(id);
					signal?.removeEventListener("abort", abort);
				};
				const abort = () => {
					cleanup();
					try {
						send({ id, kind: "cancelWait" });
					} catch {
						/* Receipt lookup remains available after reconnect. */
					}
					reject(new AppError("CLOSED"));
				};
				const timer = setTimeout(abort, 10000);
				pending.set(id, {
					fail: abort,
					receive(message) {
						cleanup();
						try {
							if (message.kind === "error") throw new AppError(parseError(message.error));
							if (message.kind !== "result") throw new AppError("INVALID_REQUEST");
							const result = parseResult(method, message.result);
							if (method === "handshake") {
								const identity = parseResult("handshake", result);
								if (storeId && storeId !== identity.storeId) throw new AppError("STORE_MISMATCH");
								storeId = identity.storeId;
							}
							resolve(result);
						} catch (error) {
							reject(error);
						}
					},
				});
				signal?.addEventListener("abort", abort, { once: true });
				try {
					send({
						id,
						kind: "call",
						request: parseRequest({ version: PROTOCOL_VERSION, method, params, expectedStoreId: storeId }),
					});
				} catch (error) {
					cleanup();
					reject(error);
				}
			});
		},
		async observe(scope, listener, signal, onStatus) {
			if (!storeId) await client.call("handshake", {}, signal);
			if (closed || signal?.aborted) throw new AppError("CLOSED");
			if (pending.size >= 16) throw new AppError("CAPACITY_EXCEEDED");
			const id = String(++next);
			let busy = false;
			let ready = false;
			let terminal = false;
			const notify = (status: ObservationStatus) => {
				if (terminal) return;
				if (status.state === "closed") terminal = true;
				try {
					void Promise.resolve(onStatus?.(status)).catch(() => {});
				} catch {
					/* UI status failure cannot retain a subscription. */
				}
			};
			let accept: (() => void) | undefined;
			let refuse: ((error: Error) => void) | undefined;
			const started = new Promise<void>((resolve, reject) => {
				accept = resolve;
				refuse = reject;
			});
			const timer = setTimeout(() => {
				notify({ state: "closed", reason: "disconnected" });
				refuse?.(new AppError("CLOSED"));
				abort();
			}, 10000);
			const dispose = async () => {
				notify({ state: "closed", reason: "disposed" });
				clearTimeout(timer);
				if (!pending.delete(id)) return;
				signal?.removeEventListener("abort", abort);
				if (!ready) refuse?.(new AppError("CLOSED"));
				try {
					send({ id, kind: "cancelWait" });
				} catch {
					/* Disconnected channels already release observations. */
				}
			};
			const abort = () => {
				void dispose();
			};
			pending.set(id, {
				fail: (reason = "disconnected") => {
					notify({ state: "closed", reason });
					abort();
				},
				receive(message) {
					try {
						if (message.kind === "status") {
							const status = parseObservationStatus(message.status);
							if (status.state !== "closed") throw new AppError("INVALID_REQUEST");
							notify(status);
							abort();
							return;
						}
						if (message.kind === "error") throw new AppError(parseError(message.error));
						if (message.kind !== "frame" || busy) throw new AppError("INVALID_REQUEST");
						const frame = parseFrame(message.frame);
						if (!ready) {
							ready = true;
							clearTimeout(timer);
							notify({ state: "connected" });
							accept?.();
						}
						busy = true;
						const delivery = listener(frame);
						// Node may dispatch several valid IPC messages in one callback batch. A void
						// listener has already finished; deferring its release to a microtask falsely
						// treats the next frame as an overlapping asynchronous delivery.
						if (delivery === undefined) busy = false;
						else
							void Promise.resolve(delivery)
								.catch(() => {
									notify({ state: "closed", reason: "error", code: "INTERNAL" });
									abort();
								})
								.finally(() => {
									busy = false;
								});
					} catch (error) {
						notify({
							state: "closed",
							reason: "error",
							code: error instanceof AppError ? error.code : "INTERNAL",
						});
						refuse?.(error instanceof Error ? error : new AppError("INTERNAL"));
						abort();
					}
				},
			});
			signal?.addEventListener("abort", abort, { once: true });
			try {
				send({ id, kind: "observe", scope: parseObservationScope(scope), expectedStoreId: storeId });
			} catch (error) {
				refuse?.(error instanceof Error ? error : new AppError("INTERNAL"));
				await dispose();
			}
			await started;
			return { dispose };
		},
	};
	return client;
}
