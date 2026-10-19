import type {
	FileEntry,
	FileErrorCode,
	FilePage,
	FilePreview,
	FileRoot,
	FileService,
	FileTarget,
	FileText,
} from "./contracts.ts";
import { FILE_LIMITS, FileServiceError, validateRelativePath } from "./contracts.ts";

export const FILE_PROTOCOL_VERSION = 1;
export const FILE_FRAME_BYTES = 1024 * 1024;
export type FileRequest = { version: 1; expectedStoreId: string } & (
	| { method: "listRoots"; params: { workspaceId: string } }
	| { method: "list"; params: FileTarget & { cursor?: string } }
	| { method: "readText"; params: FileTarget }
	| { method: "preview"; params: FileTarget }
	| { method: "saveText"; params: FileTarget & { text: string; ifMatch: string } }
);
export type FileResult = FileRoot[] | FilePage | FileText | FilePreview;
export type FileResponse = {
	version: 1;
	storeId: string;
	method: FileRequest["method"];
	target: { workspaceId: string; rootId?: string; path?: string };
} & ({ ok: true; result: FileResult } | { ok: false; error: FileErrorCode });
export interface FileRequestHandler {
	execute(raw: unknown): Promise<FileResponse>;
}
export interface FileClient {
	listRoots(workspaceId: string, signal?: AbortSignal): Promise<FileRoot[]>;
	list(target: FileTarget, cursor?: string, signal?: AbortSignal): Promise<FilePage>;
	readText(target: FileTarget, signal?: AbortSignal): Promise<FileText>;
	saveText(target: FileTarget, text: string, ifMatch: string, signal?: AbortSignal): Promise<FileText>;
	preview(target: FileTarget, signal?: AbortSignal): Promise<FilePreview>;
}
function invalid(): never {
	throw new FileServiceError("INVALID_PATH");
}
function object(raw: unknown, keys: string[]): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !keys.includes(key)))
		invalid();
	return raw as Record<string, unknown>;
}
export function fileIdentifier(raw: unknown): string {
	if (typeof raw !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw)) invalid();
	return raw;
}
function revision(raw: unknown): string {
	if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) invalid();
	return raw;
}
function cursor(raw: unknown): string {
	if (typeof raw !== "string" || !/^[a-f0-9]{64}:[0-9]{1,5}$/.test(raw)) invalid();
	return raw;
}
function text(raw: unknown): string {
	// Unicode mode treats a valid surrogate pair as one code point; only lone surrogates match.
	if (typeof raw !== "string" || /[\ud800-\udfff\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(raw)) invalid();
	if (new TextEncoder().encode(raw).length > FILE_LIMITS.bytes) throw new FileServiceError("LIMIT_EXCEEDED");
	return raw;
}
export function parseFileRequest(raw: unknown): FileRequest {
	const value = object(raw, ["version", "expectedStoreId", "method", "params"]);
	if (value.version !== 1) invalid();
	const base = { version: 1 as const, expectedStoreId: fileIdentifier(value.expectedStoreId) };
	const method = value.method;
	const p = object(
		value.params,
		method === "listRoots"
			? ["workspaceId"]
			: [
					"workspaceId",
					"rootId",
					"path",
					...(method === "list" ? ["cursor"] : method === "saveText" ? ["text", "ifMatch"] : []),
				],
	);
	const workspaceId = fileIdentifier(p.workspaceId);
	if (method === "listRoots") return { ...base, method, params: { workspaceId } };
	const target = {
		workspaceId,
		rootId: fileIdentifier(p.rootId),
		path: validateRelativePath(p.path, method === "list"),
	};
	if (method === "list")
		return {
			...base,
			method,
			params: { ...target, ...(p.cursor === undefined ? {} : { cursor: cursor(p.cursor) }) },
		};
	if (method === "readText" || method === "preview") return { ...base, method, params: target };
	if (method === "saveText")
		return { ...base, method, params: { ...target, text: text(p.text), ifMatch: revision(p.ifMatch) } };
	return invalid();
}
export function fileRequestTarget(request: FileRequest) {
	const p = request.params;
	return request.method === "listRoots"
		? { workspaceId: p.workspaceId }
		: { workspaceId: p.workspaceId, rootId: request.params.rootId, path: request.params.path };
}
export function parseFileRoots(raw: unknown, workspaceId: string): FileRoot[] {
	if (!Array.isArray(raw) || raw.length > FILE_LIMITS.roots) invalid();
	const seen = new Set<string>();
	return raw.map((item) => {
		const value = object(item, ["workspaceId", "rootId", "writable", "displayName"]);
		const rootId = fileIdentifier(value.rootId);
		if (value.workspaceId !== workspaceId || typeof value.writable !== "boolean" || seen.has(rootId)) invalid();
		const displayName = value.displayName;
		if (
			displayName !== undefined &&
			(typeof displayName !== "string" ||
				!displayName ||
				[...displayName].length > 255 ||
				/[\p{Cc}\p{Cf}\p{Cs}/\\]/u.test(displayName))
		)
			invalid();
		seen.add(rootId);
		return { workspaceId, rootId, writable: value.writable, ...(displayName === undefined ? {} : { displayName }) };
	});
}
export function parseFileText(raw: unknown): FileText {
	const value = object(raw, ["text", "revision", "encoding", "bytes"]);
	const content = text(value.text);
	const bytes = new TextEncoder().encode(content).length;
	if (value.encoding !== "utf-8" || value.bytes !== bytes) invalid();
	return { text: content, revision: revision(value.revision), encoding: "utf-8", bytes };
}
export function parseFilePage(raw: unknown, path: string): FilePage {
	const value = object(raw, ["entries", "nextCursor"]);
	if (!Array.isArray(value.entries) || value.entries.length > FILE_LIMITS.page) invalid();
	const seen = new Set<string>();
	const entries = value.entries.map((item): FileEntry => {
		const entry = object(item, ["name", "path", "kind"]);
		// Blocked platform filenames are display-only; never normalize them into a usable target.
		if (
			typeof entry.name !== "string" ||
			!entry.name ||
			entry.name.length > 255 ||
			entry.name.includes("/") ||
			entry.name === "." ||
			entry.name === ".." ||
			seen.has(entry.name)
		)
			invalid();
		const expected = path ? `${path}/${entry.name}` : entry.name;
		if (entry.path !== expected || !["file", "directory", "blocked"].includes(String(entry.kind))) invalid();
		if (entry.kind !== "blocked") validateRelativePath(entry.path);
		seen.add(entry.name);
		const kind = entry.kind;
		if (kind !== "file" && kind !== "directory" && kind !== "blocked") invalid();
		return { name: entry.name, path: expected, kind };
	});
	return { entries, nextCursor: value.nextCursor === null ? null : cursor(value.nextCursor) };
}
export function parseFilePreview(raw: unknown): FilePreview {
	const value = object(raw, ["kind", "content", "rendering", "reason"]);
	if (value.kind === "unsupported") {
		object(raw, ["kind", "reason"]);
		if (value.reason !== "binary-or-encoding") invalid();
		return { kind: "unsupported", reason: "binary-or-encoding" };
	}
	object(raw, ["kind", "content", "rendering"]);
	if (value.kind !== "text" || value.rendering !== "plain-text-only") invalid();
	return { kind: "text", content: parseFileText(value.content), rendering: "plain-text-only" };
}
export function parseFileResponse(raw: unknown, request: FileRequest): FileResponse {
	const v = object(raw, ["version", "storeId", "method", "target", "ok", "result", "error"]);
	const target = object(
		v.target,
		request.method === "listRoots" ? ["workspaceId"] : ["workspaceId", "rootId", "path"],
	);
	const expected = fileRequestTarget(request);
	if (
		v.version !== 1 ||
		v.storeId !== request.expectedStoreId ||
		v.method !== request.method ||
		target.workspaceId !== expected.workspaceId ||
		target.rootId !== expected.rootId ||
		target.path !== expected.path
	)
		invalid();
	const base = { version: 1 as const, storeId: request.expectedStoreId, method: request.method, target: expected };
	if (v.ok === false) {
		object(raw, ["version", "storeId", "method", "target", "ok", "error"]);
		const codes: FileErrorCode[] = [
			"INVALID_PATH",
			"UNAUTHORIZED",
			"NOT_FOUND",
			"BLOCKED_RESOURCE",
			"LIMIT_EXCEEDED",
			"VERSION_CONFLICT",
			"UNSUPPORTED_ENCODING",
			"BUSY",
			"CLOSED",
			"IO_ERROR",
			"WRITE_OUTCOME_UNKNOWN",
		];
		const code = codes.find((code) => code === v.error);
		if (!code) invalid();
		return { ...base, ok: false, error: code };
	}
	object(raw, ["version", "storeId", "method", "target", "ok", "result"]);
	if (v.ok !== true) invalid();
	const result =
		request.method === "listRoots"
			? parseFileRoots(v.result, request.params.workspaceId)
			: request.method === "list"
				? parseFilePage(v.result, request.params.path)
				: request.method === "preview"
					? parseFilePreview(v.result)
					: parseFileText(v.result);
	if (request.method === "saveText" && parseFileText(result).text !== request.params.text) invalid();
	return { ...base, ok: true, result };
}
/** The host supplies a session-bound service. No caller-selected principal is accepted. */
export function createFileRequestHandler(service: FileService, storeId: string): FileRequestHandler {
	fileIdentifier(storeId);
	return {
		async execute(raw) {
			const request = parseFileRequest(raw);
			const base = { version: 1 as const, storeId, method: request.method, target: fileRequestTarget(request) };
			if (request.expectedStoreId !== storeId) throw new FileServiceError("UNAUTHORIZED");
			let completed = false;
			try {
				const p = request.params;
				const result =
					request.method === "listRoots"
						? await service.listRoots(p.workspaceId)
						: request.method === "list"
							? await service.list(request.params, request.params.cursor)
							: request.method === "readText"
								? await service.readText(request.params)
								: request.method === "preview"
									? await service.preview(request.params)
									: await service.saveText(request.params, request.params.text, request.params.ifMatch);
				completed = true;
				return parseFileResponse({ ...base, ok: true, result }, request);
			} catch (error) {
				return {
					...base,
					ok: false,
					error:
						request.method === "saveText" && completed
							? "WRITE_OUTCOME_UNKNOWN"
							: error instanceof FileServiceError
								? error.code
								: "IO_ERROR",
				};
			}
		},
	};
}

/** Cancellation releases the caller, never promises to undo an admitted save. */
export function createFileClient(options: {
	storeId: string;
	request(raw: FileRequest, signal?: AbortSignal): Promise<unknown>;
}): FileClient {
	const storeId = fileIdentifier(options.storeId);
	async function invoke(raw: unknown, signal?: AbortSignal): Promise<FileResult> {
		const request = parseFileRequest(raw);
		if (signal?.aborted) throw new FileServiceError("CLOSED");
		if (new TextEncoder().encode(JSON.stringify(request)).length > FILE_FRAME_BYTES)
			throw new FileServiceError("LIMIT_EXCEEDED");
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, 10000);
		let response: FileResponse;
		try {
			const result = await new Promise<unknown>((resolve, reject) => {
				const stop = () => reject(new FileServiceError("CLOSED"));
				controller.signal.addEventListener("abort", stop, { once: true });
				Promise.resolve()
					.then(() => options.request(request, controller.signal))
					.then(resolve, reject)
					.finally(() => controller.signal.removeEventListener("abort", stop));
			});
			if (new TextEncoder().encode(JSON.stringify(result)).length > FILE_FRAME_BYTES)
				throw new FileServiceError("LIMIT_EXCEEDED");
			response = parseFileResponse(result, request);
		} catch {
			throw new FileServiceError(
				request.method === "saveText" ? "WRITE_OUTCOME_UNKNOWN" : controller.signal.aborted ? "CLOSED" : "IO_ERROR",
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
		if (!response.ok) throw new FileServiceError(response.error);
		return response.result;
	}
	const base = { version: 1, expectedStoreId: storeId };
	return {
		listRoots: async (workspaceId, signal) =>
			parseFileRoots(await invoke({ ...base, method: "listRoots", params: { workspaceId } }, signal), workspaceId),
		list: async (target, cursor, signal) =>
			parseFilePage(
				await invoke(
					{ ...base, method: "list", params: { ...target, ...(cursor === undefined ? {} : { cursor }) } },
					signal,
				),
				target.path,
			),
		readText: async (target, signal) =>
			parseFileText(await invoke({ ...base, method: "readText", params: target }, signal)),
		saveText: async (target, text, ifMatch, signal) =>
			parseFileText(await invoke({ ...base, method: "saveText", params: { ...target, text, ifMatch } }, signal)),
		preview: async (target, signal) =>
			parseFilePreview(await invoke({ ...base, method: "preview", params: target }, signal)),
	};
}
