import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	AppError,
	type ErrorCode,
	type Frame,
	LIMITS,
	type ObservationStatus,
	PROTOCOL_VERSION,
	parseError,
	parseFrame,
	parseRequest,
	parseResult,
	parseScope,
	type Response,
	type Scope,
	type Subscription,
} from "./contracts.ts";

import {
	CREDENTIAL_BODY_BYTES,
	type CredentialManagement,
	parseCredentialRequest,
	parseCredentialResponse,
} from "./credential-contracts.ts";

import { FileServiceError } from "./files/contracts.ts";
import { type FileRequestHandler, parseFileRequest, parseFileResponse } from "./files/protocol.ts";

import { type PreviewRequestHandler, parsePreviewRequest, parsePreviewResponse } from "./previews/protocol.ts";

export interface TransportRuntime {
	execute(raw: unknown): Promise<Response>;
	observe(
		scope: Scope,
		listener: (frame: Frame) => void | Promise<void>,
		signal?: AbortSignal,
		onStatus?: (status: ObservationStatus) => void,
	): Promise<Subscription>;
}

export type AuthorizationFailure = "host_mismatch" | "origin_mismatch" | "missing_credentials" | "invalid_credentials";

/** Local protocol spike, not a production HTTP stack or a public server. */
export async function serveLoopback(
	runtime: TransportRuntime,
	options: {
		origin: string;
		credentials?: CredentialManagement;
		files?: FileRequestHandler;
		previews?: PreviewRequestHandler;
		token?: string;
		subscriptionTimeoutMs?: number;
		onDiagnostic?: (event: { code: ErrorCode; reason?: AuthorizationFailure }) => void | Promise<void>;
	},
) {
	const subscriptionTimeoutMs = options.subscriptionTimeoutMs ?? 60000;
	if (!Number.isSafeInteger(subscriptionTimeoutMs) || subscriptionTimeoutMs < 10 || subscriptionTimeoutMs > 60000)
		throw new AppError("INVALID_REQUEST");
	const origin = new URL(options.origin);
	if (origin.origin !== options.origin || !["http:", "https:"].includes(origin.protocol))
		throw new AppError("INVALID_REQUEST");
	const token = options.token ?? randomBytes(32).toString("hex");
	if (token.length < 32 || token.length > 256 || /[^a-zA-Z0-9_-]/.test(token)) throw new AppError("INVALID_REQUEST");
	const expectedAuth = Buffer.from(`Bearer ${token}`);
	const active = new Set<AbortController>();
	let authority = "";
	let diagnosticWindow = Date.now();
	let diagnosticCount = 0;
	const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 }, (req, res) => {
		void handle(req, res).catch(() => {
			if (!res.headersSent) reply(res, 500, { error: "INTERNAL" });
			else res.destroy();
		});
	});
	server.maxConnections = 32;
	server.maxRequestsPerSocket = 100;
	server.setTimeout(65000, (socket) => socket.destroy());

	function reply(res: ServerResponse, status: number, value: unknown, reason?: AuthorizationFailure) {
		const body = JSON.stringify(value);
		const oversized = Buffer.byteLength(body) > LIMITS.frameBytes;
		if (status >= 400 || oversized) {
			if (Date.now() - diagnosticWindow >= 60000) {
				diagnosticWindow = Date.now();
				diagnosticCount = 0;
			}
			if (diagnosticCount++ < 16) {
				const code = oversized
					? "CAPACITY_EXCEEDED"
					: parseError(value && typeof value === "object" && "error" in value ? value.error : undefined);
				try {
					void Promise.resolve(options.onDiagnostic?.({ code, ...(reason ? { reason } : {}) })).catch(
						() => undefined,
					);
				} catch {
					/* Diagnostics never affect transport behavior. */
				}
			}
		}
		res.writeHead(oversized ? 413 : status, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		});
		res.end(oversized ? JSON.stringify({ error: "CAPACITY_EXCEEDED" }) : body);
	}
	async function handle(req: IncomingMessage, res: ServerResponse) {
		res.setHeader("Cache-Control", "no-store");
		if (req.headers.host !== authority || req.headers.origin !== options.origin) {
			reply(
				res,
				403,
				{ error: "UNAUTHORIZED" },
				req.headers.host !== authority ? "host_mismatch" : "origin_mismatch",
			);
			return;
		}
		res.setHeader("Access-Control-Allow-Origin", options.origin);
		res.setHeader("Vary", "Origin");
		if (
			req.method === "OPTIONS" &&
			[
				"/call",
				"/observe",
				...(options.credentials ? ["/credentials"] : []),
				...(options.files ? ["/files"] : []),
				...(options.previews ? ["/previews"] : []),
			].includes(req.url ?? "")
		) {
			res.writeHead(204, {
				"Access-Control-Allow-Methods": "POST",
				"Access-Control-Allow-Headers": "Authorization, Content-Type",
			});
			res.end();
			return;
		}
		const auth = Buffer.from(req.headers.authorization ?? "");
		if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
			reply(
				res,
				401,
				{ error: "UNAUTHORIZED" },
				req.headers.authorization ? "invalid_credentials" : "missing_credentials",
			);
			return;
		}
		if (
			req.method !== "POST" ||
			![
				"/call",
				"/observe",
				...(options.credentials ? ["/credentials"] : []),
				...(options.files ? ["/files"] : []),
				...(options.previews ? ["/previews"] : []),
			].includes(req.url ?? "")
		) {
			reply(res, 404, { error: "NOT_FOUND" });
			return;
		}
		if (req.headers["content-type"] !== "application/json") {
			reply(res, 415, { error: "INVALID_REQUEST" });
			return;
		}
		if (active.size >= 16) {
			reply(res, 429, { error: "CAPACITY_EXCEEDED" });
			return;
		}
		const controller = new AbortController();
		active.add(controller);
		const close = () => {
			controller.abort();
			active.delete(controller);
		};
		res.once("close", close);
		let subscription: Subscription | undefined;
		try {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of req.iterator({ destroyOnReturn: false })) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += bytes.length;
				if (size > (req.url === "/credentials" ? CREDENTIAL_BODY_BYTES : LIMITS.frameBytes)) {
					reply(res, 413, { error: "INVALID_REQUEST" });
					req.resume();
					return;
				}
				chunks.push(bytes);
			}
			let input: unknown;
			try {
				input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
			} catch {
				throw new AppError("INVALID_REQUEST");
			}
			if (controller.signal.aborted) return;
			if (req.url === "/credentials" && options.credentials) {
				const result = parseCredentialResponse(await options.credentials.execute(parseCredentialRequest(input)));
				if (!controller.signal.aborted) reply(res, 200, result);
				return;
			}
			if (req.url === "/files" && options.files) {
				const request = parseFileRequest(input);
				const result = parseFileResponse(await options.files.execute(request), request);
				if (!controller.signal.aborted) reply(res, 200, result);
				return;
			}
			if (req.url === "/previews" && options.previews) {
				const request = parsePreviewRequest(input);
				const result = parsePreviewResponse(await options.previews.execute(request, controller.signal), request);
				if (!controller.signal.aborted) reply(res, 200, result);
				return;
			}
			if (req.url === "/call") {
				const request = parseRequest(input);
				const result = parseResult(request.method, await runtime.execute(request));
				if (!controller.signal.aborted) reply(res, 200, { result });
				return;
			}
			if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError("INVALID_REQUEST");
			const observation = input as Record<string, unknown>;
			if (Object.keys(observation).some((key) => !["scope", "expectedStoreId"].includes(key)))
				throw new AppError("INVALID_REQUEST");
			const request = parseRequest({
				version: PROTOCOL_VERSION,
				method: "snapshot",
				params: observation.scope,
				expectedStoreId: observation.expectedStoreId,
			});
			const scope = request.params;
			const checkedScope = parseScope(scope);
			await runtime.execute(request);
			// Start headers only after validation; each frame is a complete replaceable snapshot.
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			});
			res.flushHeaders();
			let writing = false;
			const timer = setTimeout(() => {
				if (writing) res.destroy();
				else res.end('event: close\ndata: {"state":"closed","reason":"expired"}\n\n');
			}, subscriptionTimeoutMs);
			try {
				subscription = await runtime.observe(
					checkedScope,
					async (frame) => {
						if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
						// Producers must await delivery. Refuse concurrent writes instead of building a frame queue.
						if (writing) {
							res.destroy();
							return;
						}
						writing = true;
						try {
							const body = `data: ${JSON.stringify(parseFrame(frame))}\n\n`;
							if (Buffer.byteLength(body) > LIMITS.frameBytes) {
								res.destroy();
								return;
							}
							// false means accepted with backpressure, including a single legal frame above Windows' HWM.
							if (res.write(body)) return;
							await new Promise<void>((resolve) => {
								const settled = () => {
									clearTimeout(timeout);
									res.off("drain", settled);
									res.off("close", settled);
									res.off("finish", settled);
									res.off("error", settled);
									controller.signal.removeEventListener("abort", settled);
									resolve();
								};
								const timeout = setTimeout(() => {
									res.destroy();
									settled();
								}, 10000);
								res.once("drain", settled);
								res.once("close", settled);
								res.once("finish", settled);
								res.once("error", settled);
								controller.signal.addEventListener("abort", settled, { once: true });
								if (
									controller.signal.aborted ||
									res.destroyed ||
									res.writableFinished ||
									!res.writableNeedDrain
								)
									settled();
							});
						} finally {
							writing = false;
						}
					},
					controller.signal,
					(status) => {
						if (status.state !== "closed" || controller.signal.aborted) return;
						if (writing) res.destroy();
						else
							res.end(
								`event: close\ndata: ${JSON.stringify({ ...status, reason: status.reason === "disposed" ? "disconnected" : status.reason })}\n\n`,
							);
						controller.abort();
					},
				);
				if (!controller.signal.aborted)
					await new Promise<void>((resolve) =>
						controller.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			if (!res.headersSent) {
				const code =
					error instanceof AppError
						? error.code
						: error instanceof FileServiceError
							? error.code === "UNAUTHORIZED"
								? "UNAUTHORIZED"
								: "INVALID_REQUEST"
							: "INTERNAL";
				const statuses: Record<ErrorCode, number> = {
					INVALID_REQUEST: 400,
					NOT_FOUND: 404,
					IDEMPOTENCY_CONFLICT: 409,
					CAPACITY_EXCEEDED: 429,
					WORKSPACE_BUSY: 409,
					CLOSED: 503,
					INTERNAL: 500,
					UNAUTHORIZED: 401,
					STORE_MISMATCH: 409,
					MODEL_UNAVAILABLE: 409,
					CREDENTIAL_REQUIRED: 409,
					CONTEXT_AUTHORIZATION_REQUIRED: 409,
					RESUME_REQUIRED: 409,
					CONVERSATION_BUSY: 409,
					CONVERSATION_ARCHIVED: 409,
					RECONCILIATION_REQUIRED: 409,
					CURSOR_STALE: 409,
					INDEX_RECOVERY_REQUIRED: 503,
				};
				reply(res, statuses[code], { error: code });
			} else res.destroy();
		} finally {
			await subscription?.dispose();
			close();
			res.off("close", close);
		}
	}
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new AppError("INTERNAL");
	authority = `127.0.0.1:${address.port}`;
	return {
		url: `http://${authority}`,
		token,
		async close() {
			for (const controller of active) controller.abort();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
