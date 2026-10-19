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
} from "./contracts.ts";

/** Browser-safe adapter. The host injects a token; never persist it in a URL or page storage. */
export function createHttpClient(options: { url: string; token: string; origin?: string }): AppClient {
	const target = new URL(options.url);
	if (
		target.protocol !== "http:" ||
		target.hostname !== "127.0.0.1" ||
		target.pathname !== "/" ||
		target.search ||
		target.hash ||
		target.username ||
		target.password
	)
		throw new AppError("INVALID_REQUEST");
	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.token}`,
		"Content-Type": "application/json",
	};
	// Native Node integration tests need an explicit Origin. Browsers supply their own trusted Origin.
	if (options.origin) headers.Origin = options.origin;
	async function readJson(response: globalThis.Response): Promise<Record<string, unknown>> {
		if (!response.body) throw new AppError("INVALID_REQUEST");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let text = "";
		let bytes = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > LIMITS.frameBytes) throw new AppError("INVALID_REQUEST");
				text += decoder.decode(chunk.value, { stream: true });
			}
			text += decoder.decode();
			const value: unknown = JSON.parse(text);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INVALID_REQUEST");
			return value as Record<string, unknown>;
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	let storeId: string | undefined;
	const client: AppClient = {
		async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal): Promise<Result<M>> {
			if (signal?.aborted) throw new AppError("CLOSED");
			if (method !== "handshake" && !storeId) await client.call("handshake", {}, signal);
			const response = await fetch(`${target.origin}/call`, {
				method: "POST",
				headers,
				body: JSON.stringify(parseRequest({ version: PROTOCOL_VERSION, expectedStoreId: storeId, method, params })),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
				redirect: "error",
			});
			const body = await readJson(response);
			if (!response.ok || "error" in body) throw new AppError(parseError(body.error));
			const result = parseResult(method, body.result);
			if (method === "handshake") {
				const identity = parseResult("handshake", result);
				if (storeId && storeId !== identity.storeId) throw new AppError("STORE_MISMATCH");
				storeId = identity.storeId;
			}
			return result;
		},
		async observe(scope, listener, signal, onStatus) {
			if (!storeId) await client.call("handshake", {}, signal);
			if (signal?.aborted) throw new AppError("CLOSED");
			const controller = new AbortController();
			let terminal = false;
			const notify = (status: ObservationStatus) => {
				if (terminal) return;
				if (status.state === "closed") terminal = true;
				try {
					void Promise.resolve(onStatus?.(status)).catch(() => {});
				} catch {
					/* A UI callback cannot retain a closed stream. */
				}
			};
			const abort = () => {
				notify({ state: "closed", reason: "disposed" });
				controller.abort();
			};
			signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(() => {
				notify({ state: "closed", reason: "disconnected" });
				controller.abort();
			}, 65000);
			let reading: Promise<void> | undefined;
			const cleanup = () => {
				controller.abort();
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			};
			try {
				const response = await fetch(`${target.origin}/observe`, {
					method: "POST",
					headers,
					body: JSON.stringify({ scope: parseObservationScope(scope), expectedStoreId: storeId }),
					signal: controller.signal,
					redirect: "error",
				});
				if (!response.ok) {
					const body = await readJson(response);
					throw new AppError(parseError(body.error));
				}
				if (!response.body || response.headers.get("content-type") !== "text/event-stream")
					throw new AppError("INVALID_REQUEST");
				const reader = response.body.getReader();
				notify({ state: "connected" });
				reading = (async () => {
					const decoder = new TextDecoder();
					let buffer = "";
					try {
						while (!controller.signal.aborted) {
							const chunk = await reader.read();
							if (chunk.done) break;
							buffer += decoder.decode(chunk.value, { stream: true });
							if (buffer.length > LIMITS.frameBytes) throw new AppError("INVALID_REQUEST");
							let boundary = buffer.indexOf("\n\n");
							while (boundary >= 0 && !controller.signal.aborted) {
								const event = buffer.slice(0, boundary);
								buffer = buffer.slice(boundary + 2);
								if (event.startsWith("event: close\ndata: ")) {
									const status = parseObservationStatus(
										JSON.parse(event.slice("event: close\ndata: ".length)),
									);
									if (status.state !== "closed") throw new AppError("INVALID_REQUEST");
									notify(status);
									cleanup();
									break;
								}
								if (!event.startsWith("data: ")) throw new AppError("INVALID_REQUEST");
								const frame = parseFrame(JSON.parse(event.slice(6)));
								await new Promise<void>((resolve, reject) => {
									const stopWaiting = () => resolve();
									controller.signal.addEventListener("abort", stopWaiting, { once: true });
									Promise.resolve()
										.then(() => (controller.signal.aborted ? undefined : listener(frame)))
										.then(
											() => {
												controller.signal.removeEventListener("abort", stopWaiting);
												resolve();
											},
											(error) => {
												controller.signal.removeEventListener("abort", stopWaiting);
												reject(error);
											},
										);
								});
								boundary = buffer.indexOf("\n\n");
							}
						}
					} catch (error) {
						notify({
							state: "closed",
							reason: error instanceof AppError ? "error" : "disconnected",
							...(error instanceof AppError ? { code: error.code } : {}),
						});
					} finally {
						notify({ state: "closed", reason: "disconnected" });
						await reader.cancel().catch(() => {});
						reader.releaseLock();
						cleanup();
					}
				})().catch(cleanup);
				return {
					async dispose() {
						notify({ state: "closed", reason: "disposed" });
						cleanup();
						await reading;
					},
				};
			} catch (error) {
				notify({
					state: "closed",
					reason: error instanceof AppError ? "error" : "disconnected",
					...(error instanceof AppError ? { code: error.code } : {}),
				});
				cleanup();
				throw error;
			}
		},
	};
	return client;
}
