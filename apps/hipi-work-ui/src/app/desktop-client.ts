import {
	type AppClient,
	AppError,
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
} from "@hipi/work-runtime/contracts";

/** Restricted preload capability, not an Electron API. All boundary values are validated. */
export interface DesktopBridge {
	request(input: unknown): Promise<unknown>;
	subscribe(input: unknown, listener: (event: unknown) => void | Promise<void>): () => void;
}

declare global {
	interface Window {
		hipiWorkDesktop?: DesktopBridge;
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INVALID_REQUEST");
	return value as Record<string, unknown>;
}

/** Stops waiting only. The host may already have committed a command; never retry here. */
function waitForReply(bridge: DesktopBridge, input: unknown, signal?: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new AppError("CLOSED"));
		const stop = () => finish(new AppError("CLOSED"));
		const timer = setTimeout(stop, 10000);
		let settled = false;
		function finish(error: AppError | null, value?: unknown) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			if (error) reject(error);
			else resolve(value);
		}
		signal?.addEventListener("abort", stop, { once: true });
		try {
			void bridge.request(input).then(
				(value) => finish(null, value),
				() => finish(new AppError("CLOSED")),
			);
		} catch {
			finish(new AppError("CLOSED"));
		}
	});
}

export function createDesktopClient(bridge: DesktopBridge): AppClient {
	let storeId: string | undefined;
	const client: AppClient = {
		async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal): Promise<Result<M>> {
			if (signal?.aborted) throw new AppError("CLOSED");
			if (method !== "handshake" && !storeId) await client.call("handshake", {}, signal);
			const input = parseRequest({ version: PROTOCOL_VERSION, expectedStoreId: storeId, method, params });
			const response = record(await waitForReply(bridge, input, signal));
			if (response.ok === false) {
				if (Object.keys(response).some((key) => key !== "ok" && key !== "error")) throw new AppError("INVALID_REQUEST");
				throw new AppError(parseError(response.error));
			}
			if (response.ok !== true || Object.keys(response).some((key) => key !== "ok" && key !== "result"))
				throw new AppError("INVALID_REQUEST");
			const result = parseResult(method, response.result);
			if (method === "handshake") {
				const identity = parseResult("handshake", result);
				if (storeId && storeId !== identity.storeId) throw new AppError("STORE_MISMATCH");
				storeId = identity.storeId;
			}
			return result;
		},
		async observe(input, listener, signal, onStatus) {
			const scope = parseObservationScope(input);
			if (!storeId) await client.call("handshake", {}, signal);
			if (signal?.aborted) throw new AppError("CLOSED");
			let ready = false;
			let resolveReady: () => void = () => {};
			let rejectReady: (error: AppError) => void = () => {};
			const startup = new Promise<void>((resolve, reject) => {
				resolveReady = resolve;
				rejectReady = reject;
			});
			let closed = false;
			let busy = false;
			let epoch: string | undefined;
			let version = -1;
			let unsubscribe: (() => void) | undefined;
			const notify = (status: ObservationStatus) => {
				try {
					void Promise.resolve(onStatus?.(status)).catch(() => {});
				} catch {
					// A failed consumer must not retain host resources.
				}
			};
			const close = (status: ObservationStatus) => {
				if (closed) return;
				closed = true;
				clearTimeout(timer);
				clearTimeout(startTimer);
				if (!ready) rejectReady(new AppError(status.state === "closed" ? (status.code ?? "CLOSED") : "CLOSED"));
				signal?.removeEventListener("abort", abort);
				try {
					unsubscribe?.();
				} catch {
					// Cancellation remains terminal even if the bridge is already gone.
				} finally {
					notify(status);
				}
			};
			const abort = () => close({ state: "closed", reason: "disposed" });
			const timer = setTimeout(() => close({ state: "closed", reason: "expired" }), 65000);
			const startTimer = setTimeout(() => close({ state: "closed", reason: "disconnected", code: "CLOSED" }), 10000);
			signal?.addEventListener("abort", abort, { once: true });
			try {
				unsubscribe = bridge.subscribe({ scope, expectedStoreId: storeId }, async (value) => {
					if (closed) return;
					try {
						const event = record(value);
						if (event.kind === "status") {
							if (Object.keys(event).some((key) => key !== "kind" && key !== "status"))
								throw new AppError("INVALID_REQUEST");
							const status = parseObservationStatus(event.status);
							if (status.state === "closed") close(status);
							// Connected is established only by a validated initial snapshot.
							return;
						}
						if (event.kind !== "frame" || busy || Object.keys(event).some((key) => key !== "kind" && key !== "frame"))
							throw new AppError("INVALID_REQUEST");
						const frame = parseFrame(event.frame);
						if (
							frame.snapshot.workspaceId !== scope.workspaceId ||
							frame.snapshot.conversationId !== scope.conversationId ||
							(epoch !== undefined && frame.epoch !== epoch)
						)
							throw new AppError("INVALID_REQUEST");
						if (frame.version <= version) return;
						epoch = frame.epoch;
						version = frame.version;
						busy = true;
						await listener(frame);
						busy = false;
						if (!closed && !ready) {
							ready = true;
							clearTimeout(startTimer);
							notify({ state: "connected" });
							resolveReady();
						}
					} catch (error) {
						close({ state: "closed", reason: "error", code: error instanceof AppError ? error.code : "INTERNAL" });
					}
				});
				// Synchronous terminal callbacks can arrive before subscribe returns its disposer.
				if (closed) unsubscribe();
			} catch {
				close({ state: "closed", reason: "disconnected", code: "CLOSED" });
			}
			await startup;
			return {
				async dispose() {
					abort();
				},
			};
		},
	};
	return client;
}
