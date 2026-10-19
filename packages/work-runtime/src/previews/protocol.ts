import { FileServiceError, type FileTarget, validateRelativePath } from "../files/contracts.ts";
import { FILE_FRAME_BYTES, fileIdentifier } from "../files/protocol.ts";
import { type DocumentPreview, validateDocumentPreview } from "./contracts.ts";

export const PREVIEW_LIMITS = {
	chunkBytes: 192 * 1024,
	pageBytes: 256 * 1024,
	cacheBytes: 64 * 1024 * 1024,
	handles: 8,
	concurrent: 2,
	queue: 8,
	ttlMs: 60000,
} as const;
export type PreviewKind = "docx" | "xlsx" | "csv" | "pdf" | "png" | "jpeg";
export type PreviewHandle = {
	id: string;
	revision: string;
	kind: PreviewKind;
	summary: { bytes: number; pages: number; truncated: boolean };
};
export type PreviewPage = { id: string; revision: string; page: number; content: DocumentPreview };
export type PreviewBytes = { id: string; revision: string; offset: number; total: number; base64: string };
export interface PreviewClient {
	open(target: FileTarget, signal?: AbortSignal): Promise<PreviewHandle>;
	readPage(id: string, page: number, signal?: AbortSignal): Promise<PreviewPage>;
	readBytes(id: string, offset: number, signal?: AbortSignal): Promise<PreviewBytes>;
	close(id: string, signal?: AbortSignal): Promise<void>;
}
export type PreviewRequest = { version: 1; expectedStoreId: string } & (
	| { method: "open"; params: FileTarget }
	| { method: "readPage"; params: { id: string; page: number } }
	| { method: "readBytes"; params: { id: string; offset: number } }
	| { method: "close"; params: { id: string } }
);
export type PreviewResult = PreviewHandle | PreviewPage | PreviewBytes | null;
export type PreviewResponse = { version: 1; storeId: string; request: PreviewRequest } & (
	| { ok: true; result: PreviewResult }
	| {
			ok: false;
			error:
				| "UNAUTHORIZED"
				| "NOT_FOUND"
				| "BLOCKED_RESOURCE"
				| "LIMIT_EXCEEDED"
				| "BUSY"
				| "CLOSED"
				| "IO_ERROR"
				| "INVALID_PATH";
	  }
);
export interface PreviewRequestHandler {
	execute(raw: unknown, signal?: AbortSignal): Promise<PreviewResponse>;
}
function invalid(): never {
	throw new FileServiceError("INVALID_PATH");
}
function object(raw: unknown, keys: string[]): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !keys.includes(key)))
		invalid();
	return raw as Record<string, unknown>;
}
function integer(raw: unknown, max = 20 * 1024 * 1024): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > max) invalid();
	return raw;
}
function revision(raw: unknown): string {
	if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) invalid();
	return raw;
}
function frame(raw: unknown, max = FILE_FRAME_BYTES) {
	if (new TextEncoder().encode(JSON.stringify(raw)).length > max) throw new FileServiceError("LIMIT_EXCEEDED");
}
export function parsePreviewRequest(raw: unknown): PreviewRequest {
	frame(raw);
	const v = object(raw, ["version", "expectedStoreId", "method", "params"]);
	if (v.version !== 1) invalid();
	const base = { version: 1 as const, expectedStoreId: fileIdentifier(v.expectedStoreId) };
	const p = object(
		v.params,
		v.method === "open"
			? ["workspaceId", "rootId", "path"]
			: v.method === "readPage"
				? ["id", "page"]
				: v.method === "readBytes"
					? ["id", "offset"]
					: ["id"],
	);
	if (v.method === "open")
		return {
			...base,
			method: "open",
			params: {
				workspaceId: fileIdentifier(p.workspaceId),
				rootId: fileIdentifier(p.rootId),
				path: validateRelativePath(p.path),
			},
		};
	const id = fileIdentifier(p.id);
	if (v.method === "readPage") return { ...base, method: "readPage", params: { id, page: integer(p.page, 10000) } };
	if (v.method === "readBytes") return { ...base, method: "readBytes", params: { id, offset: integer(p.offset) } };
	if (v.method === "close") return { ...base, method: "close", params: { id } };
	return invalid();
}
export function parsePreviewHandle(raw: unknown): PreviewHandle {
	const v = object(raw, ["id", "revision", "kind", "summary"]);
	const s = object(v.summary, ["bytes", "pages", "truncated"]);
	if (!["docx", "xlsx", "csv", "pdf", "png", "jpeg"].includes(String(v.kind)) || typeof s.truncated !== "boolean")
		invalid();
	return {
		id: fileIdentifier(v.id),
		revision: revision(v.revision),
		kind: v.kind as PreviewKind,
		summary: { bytes: integer(s.bytes), pages: integer(s.pages, 10000), truncated: s.truncated },
	};
}
export function parsePreviewPage(raw: unknown): PreviewPage {
	const v = object(raw, ["id", "revision", "page", "content"]);
	frame(v.content, PREVIEW_LIMITS.pageBytes);
	return {
		id: fileIdentifier(v.id),
		revision: revision(v.revision),
		page: integer(v.page, 10000),
		content: validateDocumentPreview(v.content),
	};
}
export function parsePreviewBytes(raw: unknown): PreviewBytes {
	const v = object(raw, ["id", "revision", "offset", "total", "base64"]);
	const offset = integer(v.offset),
		total = integer(v.total);
	if (
		offset > total ||
		offset % PREVIEW_LIMITS.chunkBytes !== 0 ||
		typeof v.base64 !== "string" ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.base64)
	)
		invalid();
	const length = (v.base64.length / 4) * 3 - (v.base64.endsWith("==") ? 2 : v.base64.endsWith("=") ? 1 : 0);
	if (length !== Math.min(PREVIEW_LIMITS.chunkBytes, total - offset)) invalid();
	return { id: fileIdentifier(v.id), revision: revision(v.revision), offset, total, base64: v.base64 };
}
export function parsePreviewResponse(raw: unknown, request: PreviewRequest): PreviewResponse {
	frame(raw);
	const v = object(raw, ["version", "storeId", "request", "ok", "result", "error"]);
	if (
		v.version !== 1 ||
		v.storeId !== request.expectedStoreId ||
		JSON.stringify(parsePreviewRequest(v.request)) !== JSON.stringify(request)
	)
		invalid();
	const base = { version: 1 as const, storeId: request.expectedStoreId, request };
	if (v.ok === false) {
		object(raw, ["version", "storeId", "request", "ok", "error"]);
		const codes = [
			"UNAUTHORIZED",
			"NOT_FOUND",
			"BLOCKED_RESOURCE",
			"LIMIT_EXCEEDED",
			"BUSY",
			"CLOSED",
			"IO_ERROR",
			"INVALID_PATH",
		] as const;
		const error = codes.find((code) => code === v.error);
		if (!error) invalid();
		return { ...base, ok: false, error };
	}
	object(raw, ["version", "storeId", "request", "ok", "result"]);
	if (v.ok !== true) invalid();
	const result =
		request.method === "open"
			? parsePreviewHandle(v.result)
			: request.method === "readPage"
				? parsePreviewPage(v.result)
				: request.method === "readBytes"
					? parsePreviewBytes(v.result)
					: v.result === null
						? null
						: invalid();
	if (request.method !== "open" && result && result.id !== request.params.id) invalid();
	if (request.method === "readPage" && result && "page" in result && result.page !== request.params.page) invalid();
	if (request.method === "readBytes" && result && "offset" in result && result.offset !== request.params.offset)
		invalid();
	return { ...base, ok: true, result };
}
export function createPreviewRequestHandler(service: PreviewClient, storeId: string): PreviewRequestHandler {
	fileIdentifier(storeId);
	return {
		async execute(raw, signal) {
			const request = parsePreviewRequest(raw);
			if (request.expectedStoreId !== storeId) throw new FileServiceError("UNAUTHORIZED");
			const base = { version: 1 as const, storeId, request };
			try {
				if (request.method === "close") await service.close(request.params.id, signal);
				const result =
					request.method === "open"
						? await service.open(request.params, signal)
						: request.method === "readPage"
							? await service.readPage(request.params.id, request.params.page, signal)
							: request.method === "readBytes"
								? await service.readBytes(request.params.id, request.params.offset, signal)
								: null;
				return parsePreviewResponse({ ...base, ok: true, result }, request);
			} catch (error) {
				const code = error instanceof FileServiceError ? error.code : "IO_ERROR";
				const safe = [
					"UNAUTHORIZED",
					"NOT_FOUND",
					"BLOCKED_RESOURCE",
					"LIMIT_EXCEEDED",
					"BUSY",
					"CLOSED",
					"INVALID_PATH",
				].includes(code)
					? code
					: "IO_ERROR";
				return parsePreviewResponse({ ...base, ok: false, error: safe }, request);
			}
		},
	};
}
export function createPreviewClient(options: {
	storeId: string;
	request(request: PreviewRequest, signal?: AbortSignal): Promise<unknown>;
}): PreviewClient {
	const base = { version: 1, expectedStoreId: fileIdentifier(options.storeId) };
	const revisions = new Map<string, string>();
	async function invoke(method: string, params: unknown, signal?: AbortSignal): Promise<PreviewResult> {
		if (signal?.aborted) throw new FileServiceError("CLOSED");
		const request = parsePreviewRequest({ ...base, method, params });
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, 10000);
		try {
			const raw = await new Promise<unknown>((resolve, reject) => {
				const stop = () => reject(new FileServiceError("CLOSED"));
				controller.signal.addEventListener("abort", stop, { once: true });
				Promise.resolve()
					.then(() => options.request(request, controller.signal))
					.then(async (value) => {
						if (controller.signal.aborted && request.method === "open") {
							const late = parsePreviewResponse(value, request);
							if (late.ok && late.result) {
								const handle = parsePreviewHandle(late.result);
								const cleanup = parsePreviewRequest({ ...base, method: "close", params: { id: handle.id } });
								await options.request(cleanup, AbortSignal.timeout(10000));
							}
						}
						resolve(value);
					}, reject)
					.catch(reject)
					.finally(() => controller.signal.removeEventListener("abort", stop));
			});
			if (controller.signal.aborted) {
				if (request.method === "open") {
					const late = parsePreviewResponse(raw, request);
					if (late.ok && late.result) {
						const handle = parsePreviewHandle(late.result);
						await options.request(
							parsePreviewRequest({ ...base, method: "close", params: { id: handle.id } }),
							AbortSignal.timeout(10000),
						);
					}
				}
				throw new FileServiceError("CLOSED");
			}
			const response = parsePreviewResponse(raw, request);
			if (!response.ok) throw new FileServiceError(response.error);
			if (
				response.result &&
				request.method !== "open" &&
				revisions.get(response.result.id) !== response.result.revision
			)
				invalid();
			return response.result;
		} catch (error) {
			throw new FileServiceError(
				controller.signal.aborted ? "CLOSED" : error instanceof FileServiceError ? error.code : "IO_ERROR",
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}
	return {
		async open(target, signal) {
			const result = parsePreviewHandle(await invoke("open", target, signal));
			if (revisions.size >= PREVIEW_LIMITS.handles) {
				const oldest = revisions.keys().next().value;
				if (oldest !== undefined) revisions.delete(oldest);
			}
			revisions.set(result.id, result.revision);
			return result;
		},
		async readPage(id, page, signal) {
			return parsePreviewPage(await invoke("readPage", { id, page }, signal));
		},
		async readBytes(id, offset, signal) {
			return parsePreviewBytes(await invoke("readBytes", { id, offset }, signal));
		},
		async close(id, signal) {
			await invoke("close", { id }, signal);
			revisions.delete(id);
		},
	};
}
