import type { Conversation, ConversationPresentation, Scope } from "../contracts.ts";
import {
	type ConversationMembership,
	type Project,
	type ProjectId,
	type ProjectPresentation,
	parseConversationMembership,
	parseProject,
	parseProjectPresentation,
} from "../projects/contracts.ts";

export const SIDEBAR_PIN_LIMITS = { page: 50, cursor: 2048 } as const;
/** Typed pin identity never changes a conversation's canonical execution Scope. */
export type PinKey = { kind: "project"; projectId: ProjectId } | ({ kind: "conversation" } & Scope);
export type SidebarPinItem =
	| { kind: "project"; project: Project; presentation: ProjectPresentation }
	| {
			kind: "conversation";
			conversation: Conversation;
			presentation: ConversationPresentation;
			membership: ConversationMembership;
	  };
export type SidebarPinPage = {
	items: SidebarPinItem[];
	previousCursor: string | null;
	nextCursor: string | null;
	/** First verified eligible pin beyond this page, never a renderer-derived boundary. */
	nextPinKey: PinKey | null;
	orderRevision: number;
};
export type ReorderSidebarPin = {
	requestId: string;
	moved: PinKey;
	/** Null means the absolute end of the complete mixed list, including unloaded pins. */
	before: PinKey | null;
	expectedOrderRevision: number;
};
/** An immutable first result. This metadata-only transaction has no pending physical phase. */
export type SidebarPinCommandResult = {
	method: "reorderSidebarPin";
	params: ReorderSidebarPin;
	result: { orderRevision: number };
};
export type SidebarPinMethods = {
	listSidebarPins: { params: { cursor?: string }; result: SidebarPinPage };
	reorderSidebarPin: { params: ReorderSidebarPin; result: { orderRevision: number } };
	getSidebarPinCommandResult: { params: { requestId: string }; result: SidebarPinCommandResult | null };
};
export type SidebarPinMethod = keyof SidebarPinMethods;
export type SidebarPinMutationMethod = "reorderSidebarPin";
export type SidebarPinRequest = {
	[M in SidebarPinMethod]: { method: M; params: SidebarPinMethods[M]["params"] };
}[SidebarPinMethod];
export type SidebarPinResponse = SidebarPinMethods[SidebarPinMethod]["result"];
export const SIDEBAR_PIN_METHODS: readonly SidebarPinMethod[] = [
	"listSidebarPins",
	"reorderSidebarPin",
	"getSidebarPinCommandResult",
];
export function isSidebarPinMethod(value: unknown): value is SidebarPinMethod {
	return typeof value === "string" && SIDEBAR_PIN_METHODS.some((method) => method === value);
}
export function isSidebarPinMutationMethod(value: unknown): value is SidebarPinMutationMethod {
	return value === "reorderSidebarPin";
}
export class SidebarPinContractError extends Error {}
function invalid(): never {
	throw new SidebarPinContractError("INVALID_REQUEST");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	if (Object.keys(value).some((key) => !keys.includes(key))) return invalid();
	return value as Record<string, unknown>;
}
function string(value: unknown, max = 128): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) return invalid();
	return value;
}
function id(value: unknown): string {
	const result = string(value);
	if (!/^[A-Za-z0-9_-]+$(?![\s\S])/u.test(result)) return invalid();
	return result;
}
function integer(value: unknown, min = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) return invalid();
	return value;
}
export function parsePinKey(value: unknown): PinKey {
	const p = object(value, ["kind", "projectId", "workspaceId", "conversationId"]);
	if (p.kind === "project") {
		object(p, ["kind", "projectId"]);
		return { kind: "project", projectId: id(p.projectId) };
	}
	if (p.kind === "conversation") {
		object(p, ["kind", "workspaceId", "conversationId"]);
		return { kind: "conversation", workspaceId: id(p.workspaceId), conversationId: id(p.conversationId) };
	}
	return invalid();
}
export function samePinKey(left: PinKey, right: PinKey): boolean {
	return left.kind === "project"
		? right.kind === "project" && left.projectId === right.projectId
		: right.kind === "conversation" &&
				left.workspaceId === right.workspaceId &&
				left.conversationId === right.conversationId;
}
export function parseSidebarPinParams<M extends SidebarPinMethod>(
	method: M,
	value: unknown,
): SidebarPinMethods[M]["params"] {
	let result: unknown;
	switch (method) {
		case "listSidebarPins": {
			const p = object(value, ["cursor"]);
			result = p.cursor === undefined ? {} : { cursor: string(p.cursor, SIDEBAR_PIN_LIMITS.cursor) };
			break;
		}
		case "reorderSidebarPin": {
			const p = object(value, ["requestId", "moved", "before", "expectedOrderRevision"]);
			const moved = parsePinKey(p.moved),
				before = p.before === null ? null : parsePinKey(p.before);
			if (before !== null && samePinKey(moved, before)) return invalid();
			result = {
				requestId: id(p.requestId),
				moved,
				before,
				expectedOrderRevision: integer(p.expectedOrderRevision),
			};
			break;
		}
		case "getSidebarPinCommandResult": {
			const p = object(value, ["requestId"]);
			result = { requestId: id(p.requestId) };
			break;
		}
		default:
			return invalid();
	}
	return result as SidebarPinMethods[M]["params"];
}
/** Stable normalized serialization for the browser and catalog command digest. */
export function sidebarPinCommandPayload(method: SidebarPinMutationMethod, params: ReorderSidebarPin): string {
	return JSON.stringify({ method, params: parseSidebarPinParams(method, params) });
}
export function parseSidebarPinItem(value: unknown): SidebarPinItem {
	const p = object(value, ["kind", "project", "conversation", "presentation", "membership"]);
	if (p.kind === "project") {
		object(p, ["kind", "project", "presentation"]);
		const project = parseProject(p.project),
			presentation = parseProjectPresentation(p.presentation);
		if (!presentation.pinned || project.projectId !== presentation.projectId) return invalid();
		return { kind: "project", project, presentation };
	}
	if (p.kind !== "conversation") return invalid();
	object(p, ["kind", "conversation", "presentation", "membership"]);
	// Type-only root imports avoid a cycle when root protocol dispatch imports these parsers.
	const c = object(p.conversation, ["workspaceId", "conversationId", "title", "revision", "createdAt", "archivedAt"]);
	if (c.archivedAt !== null) return invalid();
	const conversation: Conversation = {
		workspaceId: id(c.workspaceId),
		conversationId: id(c.conversationId),
		title: string(c.title),
		revision: integer(c.revision, 1),
		createdAt: c.createdAt === null ? null : integer(c.createdAt),
		archivedAt: null,
	};
	const display = object(p.presentation, ["workspaceId", "conversationId", "pinned", "revision"]);
	if (display.pinned !== true) return invalid();
	const presentation: ConversationPresentation = {
		workspaceId: id(display.workspaceId),
		conversationId: id(display.conversationId),
		pinned: true,
		revision: integer(display.revision, 1),
	};
	const membership = parseConversationMembership(p.membership);
	if (
		conversation.workspaceId !== presentation.workspaceId ||
		conversation.conversationId !== presentation.conversationId ||
		conversation.workspaceId !== membership.workspaceId ||
		conversation.conversationId !== membership.conversationId
	)
		return invalid();
	return { kind: "conversation", conversation, presentation, membership };
}
export function parseSidebarPinResult<M extends SidebarPinMethod>(
	method: M,
	value: unknown,
): SidebarPinMethods[M]["result"] {
	let result: unknown;
	switch (method) {
		case "listSidebarPins": {
			const p = object(value, ["items", "previousCursor", "nextCursor", "nextPinKey", "orderRevision"]);
			if (!Array.isArray(p.items) || p.items.length > SIDEBAR_PIN_LIMITS.page) return invalid();
			const items = Array.from(p.items, parseSidebarPinItem);
			const keys = items.map(
				(item): PinKey =>
					item.kind === "project"
						? { kind: item.kind, projectId: item.project.projectId }
						: {
								kind: item.kind,
								workspaceId: item.conversation.workspaceId,
								conversationId: item.conversation.conversationId,
							},
			);
			if (new Set(keys.map((key) => JSON.stringify(key))).size !== keys.length) return invalid();
			const nextCursor = p.nextCursor === null ? null : string(p.nextCursor, SIDEBAR_PIN_LIMITS.cursor);
			const nextPinKey = p.nextPinKey === null ? null : parsePinKey(p.nextPinKey);
			if (
				(nextCursor === null) !== (nextPinKey === null) ||
				(nextPinKey !== null && keys.some((key) => samePinKey(key, nextPinKey)))
			)
				return invalid();
			result = {
				items,
				previousCursor: p.previousCursor === null ? null : string(p.previousCursor, SIDEBAR_PIN_LIMITS.cursor),
				nextCursor,
				nextPinKey,
				orderRevision: integer(p.orderRevision),
			};
			break;
		}
		case "reorderSidebarPin": {
			const p = object(value, ["orderRevision"]);
			result = { orderRevision: integer(p.orderRevision) };
			break;
		}
		case "getSidebarPinCommandResult": {
			if (value === null) result = null;
			else {
				const p = object(value, ["method", "params", "result"]);
				if (p.method !== "reorderSidebarPin") return invalid();
				const params = parseSidebarPinParams(p.method, p.params),
					original = parseSidebarPinResult(p.method, p.result);
				if (
					original.orderRevision !== params.expectedOrderRevision &&
					original.orderRevision !== params.expectedOrderRevision + 1
				)
					return invalid();
				result = { method: p.method, params, result: original };
			}
			break;
		}
		default:
			return invalid();
	}
	return result as SidebarPinMethods[M]["result"];
}
