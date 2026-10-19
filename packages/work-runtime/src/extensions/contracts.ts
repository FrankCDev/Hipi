import type { ModelReference, Page, Scope } from "../contracts.ts";
import { PACK_ID_PATTERN, PACK_VERSION_PATTERN, TOOL_ID_PATTERN, TOOL_PACK_LIMITS } from "./pack-schema.ts";

export const TOOL_PACK_LIFECYCLE_LIMITS = { page: 32, active: 32, activeLive: 4 } as const;
export type ToolPackPreview = {
	digest: string;
	packageId: string;
	version: string;
	name: string;
	description: string;
	toolCount: number;
	tools: { id: string; name: string; description: string; stepCount: number }[];
};
export type ToolPackRecord = Omit<ToolPackPreview, "tools"> & {
	workspaceId: string;
	formatVersion: 1;
	status: "disabled" | "enabled" | "uninstalled";
	revision: number;
	installedAt: number;
};
export type ToolPackBinding = Scope & {
	bindingId: string;
	digest: string;
	model: ModelReference;
	expiresAt: number;
	status: "active" | "revoked" | "expired" | "invalidated";
	revision: number;
	createdAt: number;
	disclosureVersion: 1;
	/** Persisted before dispatch: content may have reached the model, even if the request failed. */
	disclosed: boolean;
} & ({ purpose: "live-package" } | { purpose: "retained-package"; sourceBindingId: string });
type WorkspaceRequest = { workspaceId: string; requestId: string };
type PackMutation = WorkspaceRequest & { digest: string; expectedRevision: number };
type Disclosure = Scope & { requestId: string; model: ModelReference; expiresAt: number; disclosureVersion: 1 };
export type ToolPackMutations = {
	installToolPack: {
		params: WorkspaceRequest & { packageText: string; expectedDigest: string; disclosureVersion: 1 };
		result: ToolPackRecord;
	};
	setToolPackEnabled: { params: PackMutation & { enabled: boolean }; result: ToolPackRecord };
	uninstallToolPack: { params: PackMutation; result: ToolPackRecord };
	bindToolPack: { params: Disclosure & { digest: string; expectedPackRevision: number }; result: ToolPackBinding };
	revokeToolPackBinding: {
		params: Scope & { requestId: string; bindingId: string; expectedRevision: number };
		result: ToolPackBinding;
	};
	authorizeRetainedToolPack: { params: Disclosure & { sourceBindingId: string }; result: ToolPackBinding };
};
export type ToolPackMutationMethod = keyof ToolPackMutations;
export type ToolPackCommandLookup = {
	[M in ToolPackMutationMethod]: { method: M; requestId: string; requestDigest: string } & (M extends
		| "installToolPack"
		| "setToolPackEnabled"
		| "uninstallToolPack"
		? { workspaceId: string }
		: Scope);
}[ToolPackMutationMethod];
export type ToolPackCommandResult = {
	[M in ToolPackMutationMethod]: {
		method: M;
		requestDigest: string;
		result: ToolPackMutations[M]["result"];
		scope: M extends "installToolPack" | "setToolPackEnabled" | "uninstallToolPack" ? { workspaceId: string } : Scope;
	};
}[ToolPackMutationMethod];
export type ToolPackMethods = ToolPackMutations & {
	previewToolPack: { params: { workspaceId: string; packageText: string }; result: ToolPackPreview };
	listToolPacks: { params: { workspaceId: string; cursor?: string }; result: Page<ToolPackRecord> };
	getToolPackSource: {
		params: { workspaceId: string; digest: string };
		result: { workspaceId: string; digest: string; packageText: string };
	};
	listToolPackBindings: { params: Scope & { cursor?: string }; result: Page<ToolPackBinding> };
	listActiveToolPackBindings: { params: Scope; result: ToolPackBinding[] };
	getToolPackCommandResult: { params: ToolPackCommandLookup; result: ToolPackCommandResult | null };
};
export type ToolPackMethod = keyof ToolPackMethods;
export const TOOL_PACK_METHODS: readonly ToolPackMethod[] = [
	"previewToolPack",
	"installToolPack",
	"listToolPacks",
	"getToolPackSource",
	"setToolPackEnabled",
	"uninstallToolPack",
	"bindToolPack",
	"revokeToolPackBinding",
	"authorizeRetainedToolPack",
	"listToolPackBindings",
	"listActiveToolPackBindings",
	"getToolPackCommandResult",
];
export function isToolPackMethod(value: unknown): value is ToolPackMethod {
	return typeof value === "string" && TOOL_PACK_METHODS.some((method) => method === value);
}
export class ToolPackContractError extends Error {}
function invalid(): never {
	throw new ToolPackContractError("INVALID_REQUEST");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	if (Object.keys(value).some((key) => !keys.includes(key))) return invalid();
	return value as Record<string, unknown>;
}
function string(value: unknown, max = 128, min = 1): string {
	if (
		typeof value !== "string" ||
		/[\ud800-\udfff]/u.test(value) ||
		[...value].length < min ||
		[...value].length > max
	)
		return invalid();
	return value;
}
function pattern(value: unknown, regex: string, max = 128): string {
	const result = string(value, max);
	if (!new RegExp(regex, "u").test(result)) return invalid();
	return result;
}
function id(value: unknown): string {
	return pattern(value, "^[a-zA-Z0-9_-]+$(?![\\s\\S])");
}
function digest(value: unknown): string {
	return pattern(value, "^[a-f0-9]{64}$(?![\\s\\S])", 64);
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
	return value;
}
function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") return invalid();
	return value;
}
function model(value: unknown): ModelReference {
	const p = object(value, ["provider", "modelId"]);
	return { provider: id(p.provider), modelId: string(p.modelId, 256) };
}
function packageText(value: unknown): string {
	const result = string(value, TOOL_PACK_LIMITS.packageBytes);
	if (result.startsWith("\ufeff") || new TextEncoder().encode(result).byteLength > TOOL_PACK_LIMITS.packageBytes)
		return invalid();
	return result;
}
function mutation(value: unknown): ToolPackMutationMethod {
	if (
		value !== "installToolPack" &&
		value !== "setToolPackEnabled" &&
		value !== "uninstallToolPack" &&
		value !== "bindToolPack" &&
		value !== "revokeToolPackBinding" &&
		value !== "authorizeRetainedToolPack"
	)
		return invalid();
	return value;
}
function conversationMutation(method: ToolPackMutationMethod): boolean {
	return method === "bindToolPack" || method === "revokeToolPackBinding" || method === "authorizeRetainedToolPack";
}
export function parseToolPackParams<M extends ToolPackMethod>(method: M, value: unknown): ToolPackMethods[M]["params"] {
	const p = object(value, [
		"workspaceId",
		"conversationId",
		"requestId",
		"packageText",
		"expectedDigest",
		"disclosureVersion",
		"digest",
		"expectedRevision",
		"enabled",
		"expectedPackRevision",
		"model",
		"expiresAt",
		"bindingId",
		"sourceBindingId",
		"cursor",
		"method",
		"requestDigest",
	]);
	const result: Record<string, unknown> = { workspaceId: id(p.workspaceId) };
	if (
		[
			"bindToolPack",
			"revokeToolPackBinding",
			"authorizeRetainedToolPack",
			"listToolPackBindings",
			"listActiveToolPackBindings",
		].includes(method)
	)
		result.conversationId = id(p.conversationId);
	if (
		[
			"installToolPack",
			"setToolPackEnabled",
			"uninstallToolPack",
			"bindToolPack",
			"revokeToolPackBinding",
			"authorizeRetainedToolPack",
		].includes(method)
	)
		result.requestId = id(p.requestId);
	if (method === "previewToolPack" || method === "installToolPack") result.packageText = packageText(p.packageText);
	if (method === "installToolPack") result.expectedDigest = digest(p.expectedDigest);
	if (["getToolPackSource", "setToolPackEnabled", "uninstallToolPack", "bindToolPack"].includes(method))
		result.digest = digest(p.digest);
	if (["setToolPackEnabled", "uninstallToolPack", "revokeToolPackBinding"].includes(method))
		result.expectedRevision = integer(p.expectedRevision, 1);
	if (method === "setToolPackEnabled") result.enabled = boolean(p.enabled);
	if (method === "bindToolPack") result.expectedPackRevision = integer(p.expectedPackRevision, 1);
	if (method === "revokeToolPackBinding") result.bindingId = id(p.bindingId);
	if (method === "authorizeRetainedToolPack") result.sourceBindingId = id(p.sourceBindingId);
	if (method === "bindToolPack" || method === "authorizeRetainedToolPack") {
		result.model = model(p.model);
		result.expiresAt = integer(p.expiresAt);
	}
	if (["installToolPack", "bindToolPack", "authorizeRetainedToolPack"].includes(method)) {
		if (p.disclosureVersion !== 1) return invalid();
		result.disclosureVersion = 1;
	}
	if ((method === "listToolPacks" || method === "listToolPackBindings") && p.cursor !== undefined)
		result.cursor = string(p.cursor, 2048);
	if (method === "getToolPackCommandResult") {
		const original = mutation(p.method);
		result.method = original;
		result.requestId = id(p.requestId);
		result.requestDigest = digest(p.requestDigest);
		if (conversationMutation(original)) result.conversationId = id(p.conversationId);
	}
	if (Object.keys(p).some((key) => !Object.hasOwn(result, key))) return invalid();
	return result as ToolPackMethods[M]["params"];
}
/** Stable serialization shared by browser WebCrypto and the host's SHA-256 implementation. */
export function toolPackCommandPayload<M extends ToolPackMutationMethod>(
	method: M,
	params: ToolPackMutations[M]["params"],
): string {
	return JSON.stringify({ method, params: parseToolPackParams(method, params) });
}
function summary(p: Record<string, unknown>): Omit<ToolPackPreview, "tools"> {
	return {
		digest: digest(p.digest),
		packageId: pattern(p.packageId, PACK_ID_PATTERN, 64),
		version: pattern(p.version, PACK_VERSION_PATTERN, 32),
		name: string(p.name, 80),
		description: string(p.description, 512),
		toolCount: integer(p.toolCount, 1, TOOL_PACK_LIMITS.tools),
	};
}
export function parseToolPackRecord(value: unknown): ToolPackRecord {
	const p = object(value, [
		"workspaceId",
		"digest",
		"packageId",
		"version",
		"name",
		"description",
		"toolCount",
		"status",
		"revision",
		"installedAt",
		"formatVersion",
	]);
	if (p.formatVersion !== 1 || (p.status !== "disabled" && p.status !== "enabled" && p.status !== "uninstalled"))
		return invalid();
	return {
		...summary(p),
		workspaceId: id(p.workspaceId),
		formatVersion: 1,
		status: p.status,
		revision: integer(p.revision, 1),
		installedAt: integer(p.installedAt),
	};
}
export function parseToolPackBinding(value: unknown): ToolPackBinding {
	const p = object(value, [
		"workspaceId",
		"conversationId",
		"bindingId",
		"digest",
		"model",
		"expiresAt",
		"status",
		"revision",
		"createdAt",
		"disclosureVersion",
		"disclosed",
		"purpose",
		"sourceBindingId",
	]);
	if (
		p.disclosureVersion !== 1 ||
		(p.status !== "active" && p.status !== "revoked" && p.status !== "expired" && p.status !== "invalidated")
	)
		return invalid();
	if (p.purpose !== "live-package" && p.purpose !== "retained-package") return invalid();
	if (p.purpose === "live-package" && Object.hasOwn(p, "sourceBindingId")) return invalid();
	return {
		workspaceId: id(p.workspaceId),
		conversationId: id(p.conversationId),
		bindingId: id(p.bindingId),
		digest: digest(p.digest),
		model: model(p.model),
		expiresAt: integer(p.expiresAt),
		status: p.status,
		revision: integer(p.revision, 1),
		createdAt: integer(p.createdAt),
		disclosureVersion: 1,
		disclosed: boolean(p.disclosed),
		...(p.purpose === "live-package"
			? { purpose: "live-package" as const }
			: { purpose: "retained-package" as const, sourceBindingId: id(p.sourceBindingId) }),
	};
}
function bindings(value: unknown): ToolPackBinding[] {
	if (!Array.isArray(value) || value.length > TOOL_PACK_LIFECYCLE_LIMITS.page) return invalid();
	const result = Array.from(value, parseToolPackBinding);
	if (new Set(result.map((item) => item.bindingId)).size !== result.length) return invalid();
	return result;
}
export function parseToolPackResult<M extends ToolPackMethod>(method: M, value: unknown): ToolPackMethods[M]["result"] {
	let result: unknown;
	if (method === "installToolPack" || method === "setToolPackEnabled" || method === "uninstallToolPack")
		result = parseToolPackRecord(value);
	else if (method === "bindToolPack" || method === "authorizeRetainedToolPack" || method === "revokeToolPackBinding") {
		const binding = parseToolPackBinding(value);
		if (
			(method === "bindToolPack" && binding.purpose !== "live-package") ||
			(method === "authorizeRetainedToolPack" && binding.purpose !== "retained-package")
		)
			return invalid();
		result = binding;
	} else if (method === "getToolPackCommandResult") {
		if (value === null) result = null;
		else {
			const p = object(value, ["method", "scope", "requestDigest", "result"]);
			const original = mutation(p.method);
			const scoped = object(
				p.scope,
				conversationMutation(original) ? ["workspaceId", "conversationId"] : ["workspaceId"],
			);
			const scope = {
				workspaceId: id(scoped.workspaceId),
				...(conversationMutation(original) ? { conversationId: id(scoped.conversationId) } : {}),
			};
			const current = parseToolPackResult(original, p.result);
			if (
				current.workspaceId !== scope.workspaceId ||
				("conversationId" in current && current.conversationId !== scope.conversationId)
			)
				return invalid();
			result = { method: original, scope, requestDigest: digest(p.requestDigest), result: current };
		}
	} else if (method === "getToolPackSource") {
		const p = object(value, ["workspaceId", "digest", "packageText"]);
		result = { workspaceId: id(p.workspaceId), digest: digest(p.digest), packageText: packageText(p.packageText) };
	} else if (method === "previewToolPack") {
		const p = object(value, ["digest", "packageId", "version", "name", "description", "toolCount", "tools"]);
		const base = summary(p);
		if (!Array.isArray(p.tools) || p.tools.length !== base.toolCount) return invalid();
		const tools = Array.from(p.tools, (value) => {
			const tool = object(value, ["id", "name", "description", "stepCount"]);
			return {
				id: pattern(tool.id, TOOL_ID_PATTERN, 24),
				name: string(tool.name, 80),
				description: string(tool.description, 512),
				stepCount: integer(tool.stepCount, 1, TOOL_PACK_LIMITS.steps),
			};
		});
		if (new Set(tools.map((tool) => tool.id)).size !== tools.length) return invalid();
		result = { ...base, tools };
	} else if (method === "listActiveToolPackBindings") {
		const active = bindings(value);
		if (
			active.some((binding) => binding.status !== "active") ||
			active.filter((binding) => binding.purpose === "live-package").length > TOOL_PACK_LIFECYCLE_LIMITS.activeLive
		)
			return invalid();
		result = active;
	} else {
		const p = object(value, ["items", "nextCursor"]);
		let items: ToolPackRecord[] | ToolPackBinding[];
		if (method === "listToolPackBindings") items = bindings(p.items);
		else {
			if (!Array.isArray(p.items) || p.items.length > TOOL_PACK_LIFECYCLE_LIMITS.page) return invalid();
			items = Array.from(p.items, parseToolPackRecord);
			if (new Set(items.map((item) => item.digest)).size !== items.length) return invalid();
		}
		result = { items, nextCursor: p.nextCursor === null ? null : string(p.nextCursor, 2048) };
	}
	return result as ToolPackMethods[M]["result"];
}
