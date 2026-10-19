import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { auditCursor, auditPosition } from "../agent-tools/authorization-store.ts";
import { AppError } from "../contracts.ts";
import {
	parseToolPackBinding as parseBinding,
	parseToolPackRecord as parseRecord,
	parseToolPackResult as parseResult,
	parseToolPackParams,
	type ToolPackBinding,
	type ToolPackCommandLookup,
	ToolPackContractError,
	type ToolPackMethod,
	type ToolPackMethods,
} from "./contracts.ts";
import { packCommandKey } from "./lifecycle-store.ts";
import { parseToolPack, ToolPackError } from "./pack.ts";

// Malformed persisted records require recovery; they are never an absent command.
function stored<T>(parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		if (error instanceof ToolPackContractError || error instanceof ToolPackError)
			throw new AppError("INDEX_RECOVERY_REQUIRED");
		throw error;
	}
}
function parseToolPackResult<M extends ToolPackMethod>(method: M, value: unknown): ToolPackMethods[M]["result"] {
	return stored(() => parseResult(method, value));
}
export type PackDocumentReader = (kind: string, key?: string) => Promise<unknown>;
export function packDocumentReader(storage: Storage): PackDocumentReader {
	return async (kind, key) => {
		const record = await storage.findDocument(
			{ kind, scope: { kind: "session" }, ...(key === undefined ? {} : { key }) },
			"current",
			BACKGROUND_CONTEXT,
		);
		if (!record) return undefined;
		const doc = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
		if (!doc || doc.version !== 1) throw new AppError("INDEX_RECOVERY_REQUIRED");
		return doc.value;
	};
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INDEX_RECOVERY_REQUIRED");
	return value as Record<string, unknown>;
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	return value;
}
function ids(value: unknown, limit: number): string[] {
	if (
		!Array.isArray(value) ||
		value.length > limit ||
		value.some((id) => typeof id !== "string" || !id) ||
		new Set(value).size !== value.length
	)
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	return value;
}
async function pack(read: PackDocumentReader, workspaceId: string, digest: string) {
	const raw = await read("hipi.tool-pack", digest);
	if (raw === undefined) throw new AppError("NOT_FOUND");
	const doc = object(raw);
	if (doc.interpreterVersion !== 1) throw new AppError("INDEX_RECOVERY_REQUIRED");
	const value = stored(() => parseRecord(doc.value));
	if (value.workspaceId !== workspaceId || value.digest !== digest) throw new AppError("STORE_MISMATCH");
	return { doc, value };
}
async function binding(
	read: PackDocumentReader,
	workspaceId: string,
	conversationId: string,
	durableId: number,
	id: string,
): Promise<ToolPackBinding> {
	const raw = await read("hipi.tool-pack-binding", id);
	if (raw === undefined) throw new AppError("INDEX_RECOVERY_REQUIRED");
	const doc = object(raw);
	const value = stored(() => parseBinding(doc.value));
	if (
		doc.conversationId !== durableId ||
		value.workspaceId !== workspaceId ||
		value.conversationId !== conversationId ||
		value.bindingId !== id
	)
		throw new AppError("STORE_MISMATCH");
	return value;
}
async function conversation(read: PackDocumentReader, publicId: string, durableId: number) {
	const raw = await read("hipi.tool-pack-conversation", String(durableId));
	if (raw === undefined) return { active: [], count: 0 };
	const doc = object(raw);
	if (doc.publicId !== publicId) throw new AppError("STORE_MISMATCH");
	ids(doc.dependencies, 256);
	return { active: ids(doc.active, 32), count: count(doc.count) };
}
async function pageIds(read: PackDocumentReader, prefix: string, total: number, position: number) {
	const result: string[] = [];
	while (position > 0 && result.length < 32) {
		const ordinal = position - 1;
		const base = Math.floor(ordinal / 64) * 64;
		const page = ids(object(await read("hipi.tool-pack-audit", `${prefix}-${Math.floor(ordinal / 64)}`)).ids, 64);
		if (page.length !== Math.min(64, total - base)) throw new AppError("INDEX_RECOVERY_REQUIRED");
		while (position > base && result.length < 32) result.push(page[--position - base]);
	}
	if (new Set(result).size !== result.length) throw new AppError("INDEX_RECOVERY_REQUIRED");
	return { ids: result, position };
}
export async function readToolPacks(
	storage: Storage,
	workspaceId: string,
	generation: string,
	input: ToolPackMethods["listToolPacks"]["params"],
): Promise<ToolPackMethods["listToolPacks"]["result"]> {
	const read = packDocumentReader(storage);
	const raw = await read("hipi.tool-pack-header");
	const header = raw === undefined ? { count: 0, enabled: [], live: [] } : object(raw);
	ids(header.enabled, 32);
	if (!Array.isArray(header.live) || header.live.length > 256 || header.live.some((id) => count(id) < 1))
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	const total = count(header.count);
	const cursor = auditPosition(generation, workspaceId, "", "packs", total, input.cursor);
	const page = await pageIds(read, "packs", total, cursor.position);
	const items = await Promise.all(page.ids.map(async (digest) => (await pack(read, workspaceId, digest)).value));
	return parseToolPackResult("listToolPacks", {
		items,
		nextCursor: auditCursor(generation, workspaceId, "", "packs", cursor.upper, page.position),
	});
}
export async function readToolPackSource(
	storage: Storage,
	workspaceId: string,
	input: ToolPackMethods["getToolPackSource"]["params"],
): Promise<ToolPackMethods["getToolPackSource"]["result"]> {
	const { doc, value } = await pack(packDocumentReader(storage), workspaceId, input.digest);
	const result = parseToolPackResult("getToolPackSource", {
		workspaceId,
		digest: input.digest,
		packageText: doc.packageText,
	});
	const parsed = stored(() => parseToolPack(Buffer.from(result.packageText, "utf8")));
	if (
		parsed.digest !== input.digest ||
		parsed.manifest.id !== value.packageId ||
		parsed.manifest.version !== value.version ||
		parsed.manifest.name !== value.name ||
		parsed.manifest.description !== value.description ||
		parsed.manifest.tools.length !== value.toolCount
	)
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	return result;
}
export async function readToolPackBindings(
	storage: Storage,
	workspaceId: string,
	generation: string,
	input: ToolPackMethods["listToolPackBindings"]["params"],
	durableId: number,
): Promise<ToolPackMethods["listToolPackBindings"]["result"]> {
	const read = packDocumentReader(storage);
	const state = await conversation(read, input.conversationId, durableId);
	const cursor = auditPosition(
		generation,
		workspaceId,
		input.conversationId,
		"pack-bindings",
		state.count,
		input.cursor,
	);
	const page = await pageIds(read, `bindings-${durableId}`, state.count, cursor.position);
	const items = await Promise.all(
		page.ids.map((id) => binding(read, workspaceId, input.conversationId, durableId, id)),
	);
	return parseToolPackResult("listToolPackBindings", {
		items,
		nextCursor: auditCursor(
			generation,
			workspaceId,
			input.conversationId,
			"pack-bindings",
			cursor.upper,
			page.position,
		),
	});
}
export async function readActiveToolPackBindings(
	storage: Storage,
	workspaceId: string,
	input: ToolPackMethods["listActiveToolPackBindings"]["params"],
	durableId: number,
): Promise<ToolPackBinding[]> {
	const read = packDocumentReader(storage);
	const state = await conversation(read, input.conversationId, durableId);
	const values = await Promise.all(
		state.active.map((id) => binding(read, workspaceId, input.conversationId, durableId, id)),
	);
	return parseToolPackResult(
		"listActiveToolPackBindings",
		values.filter((value) => value.status === "active" && value.expiresAt > Date.now()),
	);
}
export async function resolveToolPackCommandResult(
	read: PackDocumentReader,
	input: ToolPackCommandLookup,
	durableId?: number,
): Promise<ToolPackMethods["getToolPackCommandResult"]["result"]> {
	parseToolPackParams("getToolPackCommandResult", input);
	const raw = await read("hipi.tool-pack-command", packCommandKey(input.workspaceId, input.requestId));
	if (raw === undefined) return null;
	const doc = object(raw);
	const previous = parseToolPackResult("getToolPackCommandResult", doc.value);
	if (!previous || typeof doc.resultId !== "string") throw new AppError("INDEX_RECOVERY_REQUIRED");
	if (
		previous.method !== input.method ||
		previous.requestDigest !== input.requestDigest ||
		previous.scope.workspaceId !== input.workspaceId ||
		("conversationId" in previous.scope ? previous.scope.conversationId : undefined) !==
			("conversationId" in input ? input.conversationId : undefined)
	)
		throw new AppError("IDEMPOTENCY_CONFLICT");
	const current =
		"conversationId" in input
			? await binding(read, input.workspaceId, input.conversationId, durableId ?? 0, doc.resultId)
			: (await pack(read, input.workspaceId, doc.resultId)).value;
	if (("bindingId" in previous.result ? previous.result.bindingId : previous.result.digest) !== doc.resultId)
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	return parseToolPackResult("getToolPackCommandResult", { ...previous, result: current });
}
export function readToolPackCommandResult(storage: Storage, input: ToolPackCommandLookup, durableId?: number) {
	return resolveToolPackCommandResult(packDocumentReader(storage), input, durableId);
}
