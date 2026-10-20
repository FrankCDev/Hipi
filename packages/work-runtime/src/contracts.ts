import {
	ACTIVITY_LIMITS,
	type ToolActivity,
	type ToolActivityPage,
	type ToolActivityTextPage,
} from "./activities/contracts.ts";
import { validateRelativePath } from "./files/contracts.ts";
import { SEARCH_LIMITS, type SearchMethods, searchQuery } from "./search/contracts.ts";

export {
	type ConversationSearchHit,
	type ConversationSearchPage,
	SEARCH_LIMITS,
	type SearchHistoryWindow,
	type SearchIndexStatus,
} from "./search/contracts.ts";

import { type ModelFailure, modelFailureCategory } from "./model-failure.ts";
import {
	isProviderConfigurationMethod,
	type ProviderConfigurationMethods,
	parseProviderConfigurationParams,
	parseProviderConfigurationResult,
} from "./provider-configuration.ts";

export {
	ACTIVITY_LIMITS,
	type ToolActivity,
	type ToolActivityPage,
	type ToolActivityTextPage,
} from "./activities/contracts.ts";
export type { ModelFailure, ModelFailureCategory } from "./model-failure.ts";
export {
	CUSTOM_PROVIDER_LIMITS,
	type CustomProviderConfiguration,
	type CustomProviderProtocol,
	type ProviderModelOption,
} from "./provider-configuration.ts";

import {
	isToolPackMethod,
	parseToolPackParams,
	parseToolPackResult,
	type ToolPackMethods,
} from "./extensions/contracts.ts";

export {
	TOOL_PACK_LIFECYCLE_LIMITS,
	type ToolPackBinding,
	type ToolPackCommandResult,
	type ToolPackMutationMethod,
	type ToolPackPreview,
	type ToolPackRecord,
	toolPackCommandPayload,
} from "./extensions/contracts.ts";

/** Browser-safe protocol; no PI handles, absolute filesystem paths, credentials, or host imports. */
export const PROTOCOL_VERSION = 7;
// JSON uses at most six bytes per UTF-16 code unit. A full page plus partial text costs
// 6 * (32 * 2048 + 16384) = 491520 bytes before bounded metadata, well below one MiB.
export const LIMITS = {
	text: 4096,
	directoryPage: 50,
	workspaces: 16,
	conversations: 16,
	submissions: 64,
	frameBytes: 1048576,
	envelopeBytes: 1024,
	historyMessages: 32,
	messagePreview: 2048,
	partialPreview: 16384,
	textChunk: 32768,
	historyScanEntries: 64,
	historyScanSlots: 256,
	cursor: 2048,
} as const;
export type Scope = { workspaceId: string; conversationId: string };
export type Workspace = { workspaceId: string; name: string };
export type ModelReference = { provider: string; modelId: string };
export type CredentialState = "configured" | "missing" | "locked" | "unavailable";
export type ModelCatalog = {
	models: (ModelReference & { name: string })[];
	providers: { provider: string; name: string; credentialState: CredentialState }[];
};
export type ConversationModel = {
	model: ModelReference;
	credentialState: CredentialState;
	executionState: "ready" | "running" | "paused" | "cancellation_pending";
};
export type Conversation = Scope & {
	title: string;
	revision: number;
	/** Unix epoch milliseconds; legacy records without a known creation time use null. */
	createdAt: number | null;
	archivedAt: number | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type ConversationFilter = "active" | "archived" | "all";
export type ConversationMutation = Scope & { requestId: string; expectedRevision: number };
/** The complete first result is retained permanently; querying never replays the command. */
export type ConversationCommandResult = {
	method: "createConversation" | "renameConversation" | "archiveConversation" | "restoreConversation";
	result: Conversation;
};
/** Catalog-owned presentation, independent of conversation/execution revisions. */
export type ConversationPresentation = Scope & { revision: number; pinned: boolean };
export type PinnedConversation = { conversation: Conversation; presentation: ConversationPresentation };
export type SetConversationPinned = Scope & {
	requestId: string;
	expectedPresentationRevision: number;
	pinned: boolean;
};
/** An immutable first result, not the conversation's current presentation. */
export type PresentationCommandResult = {
	method: "setConversationPinned";
	params: SetConversationPinned;
	result: ConversationPresentation;
};
export const AGENT_LIMITS = {
	contexts: 64,
	activeContexts: 32,
	pathPrefixes: 32,
	approvals: 64,
	approvalPage: 1,
	textBytes: 65536,
	beforeTextBytes: 4096,
} as const;
/** A grant binds disclosure to one conversation, registered root and exact model. */
export type AgentContextRequest = Scope & {
	requestId: string;
	rootId: string;
	pathPrefixes: string[];
	model: ModelReference;
	/** Unix epoch milliseconds. */
	expiresAt: number;
	disclosureVersion: 1;
};
export type RetainedContextRequest = Scope & {
	requestId: string;
	sourceGrantId: string;
	model: ModelReference;
	expiresAt: number;
	disclosureVersion: 1;
};
export type AgentContext = AgentContextRequest & {
	grantId: string;
	revision: number;
	status: "active" | "revoked" | "expired" | "invalidated";
} & ({ purpose: "live-files" } | { purpose: "retained-context"; sourceGrantId: string });
export type ToolApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated" | "consumed";
export type ToolApproval = Scope & {
	approvalId: string;
	taskId: string;
	callId: string;
	submissionIds: string[];
	receiptIds: string[];
	toolName: "hipi_files_save";
	model: ModelReference;
	rootId: string;
	path: string;
	ifMatch: string;
	/** Complete proposed replacement, bounded by AGENT_LIMITS.textBytes in UTF-8. */
	text: string;
	beforeText: string;
	beforeTextTruncated: boolean;
	argumentsDigest: string;
	contentDigest: string;
	grantId: string;
	grantRevision: number;
	expiresAt: number;
	createdAt: number;
	revision: number;
	status: ToolApprovalStatus;
	operationId?: string;
};
/** One full proposal per page keeps escaped JSON within the transport budget. */
export type ToolApprovalPage = Page<ToolApproval>;
export type AgentContextPage = Page<AgentContext>;
/** Reads current authority without repeating an action. Its original snapshot remains in permanent audit storage. */
export type AgentCommandResult =
	| { method: "authorizeAgentContext" | "authorizeRetainedContext" | "revokeAgentContext"; result: AgentContext }
	| { method: "decideToolApproval"; result: ToolApproval };
export type FileOperationStatus = "prepared" | "executing" | "confirmed" | "conflict" | "unknown" | "observed_match";
export type FileOperation = Scope & {
	operationId: string;
	approvalId: string;
	taskId: string;
	callId: string;
	rootId: string;
	path: string;
	argumentsDigest: string;
	contentDigest: string;
	status: FileOperationStatus;
	revision: number;
	/** Observation is evidence of current content, not proof of who wrote it. */
	evidence?: { revision: string; contentDigest: string };
};
export type Submit = Scope & { requestId: string; text: string };
export type Receipt = Scope & {
	requestId: string;
	receiptId: string;
	/** cancelled withdraws local delivery only; it does not roll back external effects. */
	state: "accepted" | "dispatching" | "dispatched" | "reconciliation_required" | "cancelled";
	submissionId?: string;
};
export type ReceiptView = Receipt & {
	execution?: "queued" | "placed" | "done" | "unanswered";
	answer?: string;
	answerLength?: number;
	answerTruncated?: boolean;
	answerEntryId?: string;
	reason?: string;
	reasonLength?: number;
	reasonTruncated?: boolean;
	/** Safe category from the terminal model attempt, not a guarantee about earlier work or charges. */
	modelFailure?: ModelFailure;
};
/** Text lengths and offsets count UTF-16 code units, matching JavaScript string slicing. */
export type TextPreview = { text: string; textLength: number; truncated: boolean };
export type Message = TextPreview & {
	id: string;
	role: "user" | "assistant";
	interrupted?: true;
	/** Observer-local presentation continuity, never a history identifier or command authority. */
	streamId?: string;
};
export type Snapshot = Scope & {
	messages: Message[];
	partial: string;
	partialLength: number;
	partialTruncated: boolean;
	/** Present only while this observer can identify the current generation episode. */
	partialId?: string;
	running: boolean;
	historyCursor: string | null;
};
export type HistoryPage = Scope & { messages: Message[]; nextCursor: string | null };
export type MessageTextChunk = Scope & {
	messageId: string;
	text: string;
	/** May be requested offset minus one when the request bisects a valid surrogate pair. */
	offset: number;
	nextOffset: number | null;
	textLength: number;
};
export type Frame = { kind: "snapshot"; epoch: string; version: number; snapshot: Snapshot };
export type ObservationStatus =
	| { state: "connected" }
	| { state: "closed"; reason: "disposed" | "disconnected" | "expired" | "error"; code?: ErrorCode };
export type Subscription = { dispose(): Promise<void> };
export type Handshake = { protocolVersion: typeof PROTOCOL_VERSION; storeId: string };
export type Methods = ToolPackMethods &
	ProviderConfigurationMethods &
	SearchMethods & {
		getToolActivities: { params: Scope & { cursor?: string }; result: ToolActivityPage };
		getToolActivityText: { params: Scope & { activityId: string; cursor?: string }; result: ToolActivityTextPage };
		handshake: { params: Record<string, never>; result: Handshake };
		listWorkspaces: { params: { cursor?: string }; result: Page<Workspace> };
		listConversations: {
			params: { workspaceId: string; filter?: ConversationFilter; cursor?: string };
			result: Page<Conversation>;
		};
		createWorkspace: { params: { workspaceId: string; name: string }; result: Workspace };
		getWorkspace: { params: { workspaceId: string }; result: Workspace };
		openWorkspace: { params: { workspaceId: string }; result: Workspace };
		createConversation: {
			params: { workspaceId: string; requestId: string; title: string; model?: ModelReference };
			result: Conversation;
		};
		getConversation: { params: Scope; result: Conversation };
		getConversationPresentation: { params: Scope; result: ConversationPresentation };
		listPinnedConversations: { params: { cursor?: string }; result: Page<PinnedConversation> };
		setConversationPinned: { params: SetConversationPinned; result: ConversationPresentation };
		getPresentationCommandResult: {
			params: { requestId: string };
			result: PresentationCommandResult | null;
		};
		renameConversation: { params: ConversationMutation & { title: string }; result: Conversation };
		archiveConversation: { params: ConversationMutation; result: Conversation };
		restoreConversation: { params: ConversationMutation; result: Conversation };
		getConversationCommandResult: {
			params: { workspaceId: string; requestId: string };
			result: ConversationCommandResult | null;
		};
		listModels: { params: Record<string, never>; result: ModelCatalog };
		getConversationModel: { params: Scope; result: ConversationModel };
		continueWorkspace: { params: { workspaceId: string }; result: { workspaceId: string; state: "authorized" } };
		cancelExecution: { params: Scope; result: ConversationModel };
		authorizeAgentContext: { params: AgentContextRequest; result: AgentContext };
		authorizeRetainedContext: { params: RetainedContextRequest; result: AgentContext };
		revokeAgentContext: {
			params: Scope & { requestId: string; grantId: string; expectedRevision: number };
			result: AgentContext;
		};
		listAgentContexts: { params: Scope & { cursor?: string }; result: AgentContextPage };
		listActiveAgentContexts: { params: Scope; result: AgentContext[] };
		getAgentCommandResult: { params: Scope & { requestId: string }; result: AgentCommandResult | null };
		listPendingToolApprovals: { params: Scope & { cursor?: string }; result: ToolApprovalPage };
		listToolApprovals: { params: Scope & { cursor?: string }; result: ToolApprovalPage };
		decideToolApproval: {
			params: Scope & {
				requestId: string;
				approvalId: string;
				expectedRevision: number;
				decision: "approve" | "reject";
				argumentsDigest: string;
				contentDigest: string;
			};
			result: ToolApproval;
		};
		getFileOperation: { params: Scope & { operationId: string; reconcile?: boolean }; result: FileOperation | null };
		submit: { params: Submit; result: Receipt };
		getReceipt: { params: { workspaceId: string; requestId: string }; result: ReceiptView | null };
		snapshot: { params: Scope; result: Snapshot };
		getHistory: { params: Scope & { cursor?: string }; result: HistoryPage };
		getMessageText: { params: Scope & { messageId: string; offset: number }; result: MessageTextChunk };
	};
export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];
export type Request = {
	[M in Method]: { version: typeof PROTOCOL_VERSION; expectedStoreId?: string; method: M; params: Params<M> };
}[Method];
export type Response = Methods[Method]["result"];
export interface AppClient {
	call<M extends Method>(method: M, params: Params<M>, waitSignal?: AbortSignal): Promise<Result<M>>;
	observe(
		scope: Scope,
		listener: (frame: Frame) => void | Promise<void>,
		waitSignal?: AbortSignal,
		onStatus?: (status: ObservationStatus) => void,
	): Promise<Subscription>;
}
export type ErrorCode =
	| "INVALID_REQUEST"
	| "NOT_FOUND"
	| "IDEMPOTENCY_CONFLICT"
	| "CAPACITY_EXCEEDED"
	| "WORKSPACE_BUSY"
	| "CLOSED"
	| "INTERNAL"
	| "UNAUTHORIZED"
	| "STORE_MISMATCH"
	| "MODEL_UNAVAILABLE"
	| "CREDENTIAL_REQUIRED"
	| "CONTEXT_AUTHORIZATION_REQUIRED"
	| "RESUME_REQUIRED"
	| "CONVERSATION_BUSY"
	| "CONVERSATION_ARCHIVED"
	| "RECONCILIATION_REQUIRED"
	| "CURSOR_STALE"
	| "INDEX_RECOVERY_REQUIRED";
export class AppError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode) {
		super(code);
		this.name = "AppError";
		this.code = code;
	}
}
function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("INVALID_REQUEST");
	return value as Record<string, unknown>;
}
function string(value: unknown, max = 128): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AppError("INVALID_REQUEST");
	return value;
}
function id(value: unknown): string {
	const result = string(value);
	if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new AppError("INVALID_REQUEST");
	return result;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("INVALID_REQUEST");
	return value;
}
/** Measure the actual JSON encoding, including UTF-8 and JSON escape expansion. */
export function jsonBytes(value: unknown): number {
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new AppError("INVALID_REQUEST");
		return new TextEncoder().encode(encoded).byteLength;
	} catch {
		throw new AppError("INVALID_REQUEST");
	}
}
/** Leave room for the result/frame wrapper used by both IPC and HTTP. */
export function fitsPayloadBudget(value: unknown): boolean {
	return jsonBytes(value) <= LIMITS.frameBytes - LIMITS.envelopeBytes;
}
export function parseObservationScope(value: unknown): Scope {
	const p = object(value);
	fields(p, ["workspaceId", "conversationId"]);
	return parseScope(p);
}
export function parseScope(value: unknown): Scope {
	const p = object(value);
	return { workspaceId: id(p.workspaceId), conversationId: id(p.conversationId) };
}
/** Reject unknown fields rather than silently ignoring future semantic changes. */
export function parseRequest(value: unknown): Request {
	if (!fitsPayloadBudget(value)) throw new AppError("INVALID_REQUEST");
	const r = object(value);
	if (
		r.version !== PROTOCOL_VERSION ||
		Object.keys(r).some((k) => !["version", "expectedStoreId", "method", "params"].includes(k))
	)
		throw new AppError("INVALID_REQUEST");
	const p = object(r.params);
	if (isProviderConfigurationMethod(r.method)) {
		try {
			return {
				version: PROTOCOL_VERSION,
				...(r.expectedStoreId === undefined ? {} : { expectedStoreId: id(r.expectedStoreId) }),
				method: r.method,
				params: parseProviderConfigurationParams(r.method, p),
			} as Request;
		} catch {
			throw new AppError("INVALID_REQUEST");
		}
	}
	if (isToolPackMethod(r.method)) {
		try {
			return {
				version: PROTOCOL_VERSION,
				...(r.expectedStoreId === undefined ? {} : { expectedStoreId: id(r.expectedStoreId) }),
				method: r.method,
				params: parseToolPackParams(r.method, p),
			} as Request;
		} catch {
			throw new AppError("INVALID_REQUEST");
		}
	}
	let request: Request;
	switch (r.method) {
		case "refreshConversationSearch":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: p.cursor === undefined ? {} : { cursor: string(p.cursor, LIMITS.cursor) },
			};
			break;
		case "searchConversations": {
			let query: string;
			try {
				query = searchQuery(p.query);
			} catch {
				throw new AppError("INVALID_REQUEST");
			}
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: { query, ...(p.cursor === undefined ? {} : { cursor: string(p.cursor, LIMITS.cursor) }) },
			};
			break;
		}
		case "getHistoryAroundMatch":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					locator: string(p.locator, LIMITS.cursor),
					...(p.cursor === undefined ? {} : { cursor: string(p.cursor, LIMITS.cursor) }),
				},
			};
			break;
		case "handshake":
		case "listModels":
			request = { version: PROTOCOL_VERSION, method: r.method, params: {} };
			break;
		case "listWorkspaces":
		case "listPinnedConversations":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...(p.cursor === undefined ? {} : { cursor: string(p.cursor, LIMITS.cursor) }),
				},
			};
			break;
		case "listConversations":
			if (p.filter !== undefined && p.filter !== "active" && p.filter !== "archived" && p.filter !== "all")
				throw new AppError("INVALID_REQUEST");
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					workspaceId: id(p.workspaceId),
					...(p.filter === undefined ? {} : { filter: p.filter }),
					...(p.cursor === undefined ? {} : { cursor: string(p.cursor, LIMITS.cursor) }),
				},
			};
			break;
		case "createWorkspace":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: { workspaceId: id(p.workspaceId), name: string(p.name) },
			};
			break;
		case "getWorkspace":
		case "openWorkspace":
		case "continueWorkspace":
			request = { version: PROTOCOL_VERSION, method: r.method, params: { workspaceId: id(p.workspaceId) } };
			break;
		case "createConversation":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					workspaceId: id(p.workspaceId),
					requestId: id(p.requestId),
					title: string(p.title),
					...(p.model === undefined ? {} : { model: parseModelReference(p.model) }),
				},
			};
			break;
		case "renameConversation":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					requestId: id(p.requestId),
					expectedRevision: positiveInteger(p.expectedRevision),
					title: string(p.title),
				},
			};
			break;
		case "archiveConversation":
		case "restoreConversation":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					requestId: id(p.requestId),
					expectedRevision: positiveInteger(p.expectedRevision),
				},
			};
			break;
		case "getAgentCommandResult":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					requestId: id(p.requestId),
				},
			};
			break;
		case "getPresentationCommandResult":
			request = { version: PROTOCOL_VERSION, method: r.method, params: { requestId: id(p.requestId) } };
			break;
		case "setConversationPinned":
			if (typeof p.pinned !== "boolean") throw new AppError("INVALID_REQUEST");
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					requestId: id(p.requestId),
					expectedPresentationRevision: integer(p.expectedPresentationRevision),
					pinned: p.pinned,
				},
			};
			break;
		case "submit":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: { ...parseScope(p), requestId: id(p.requestId), text: string(p.text, LIMITS.text) },
			};
			break;
		case "getConversationCommandResult":
		case "getReceipt":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: { workspaceId: id(p.workspaceId), requestId: id(p.requestId) },
			};
			break;
		case "snapshot":
		case "getConversationModel":
		case "cancelExecution":
		case "getConversation":
		case "getConversationPresentation":
		case "listActiveAgentContexts":
			request = { version: PROTOCOL_VERSION, method: r.method, params: parseScope(p) };
			break;
		case "getHistory":
		case "getToolActivities":
		case "listAgentContexts":
		case "listPendingToolApprovals":
		case "listToolApprovals":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					...(p.cursor === undefined ? {} : { cursor: string(p.cursor, LIMITS.cursor) }),
				},
			};
			break;
		case "getMessageText":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: { ...parseScope(p), messageId: string(p.messageId, 256), offset: integer(p.offset) },
			};
			break;
		case "getToolActivityText":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					activityId: string(p.activityId, 2048),
					...(p.cursor === undefined ? {} : { cursor: string(p.cursor, LIMITS.cursor) }),
				},
			};
			break;
		case "authorizeAgentContext":
			request = { version: PROTOCOL_VERSION, method: r.method, params: agentContextRequest(p) };
			break;
		case "authorizeRetainedContext":
			if (p.disclosureVersion !== 1) throw new AppError("INVALID_REQUEST");
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					requestId: id(p.requestId),
					sourceGrantId: id(p.sourceGrantId),
					model: parseModelReference(p.model),
					expiresAt: integer(p.expiresAt),
					disclosureVersion: 1,
				},
			};
			break;
		case "revokeAgentContext":
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					requestId: id(p.requestId),
					grantId: id(p.grantId),
					expectedRevision: positiveInteger(p.expectedRevision),
				},
			};
			break;
		case "decideToolApproval":
			if (p.decision !== "approve" && p.decision !== "reject") throw new AppError("INVALID_REQUEST");
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					requestId: id(p.requestId),
					approvalId: id(p.approvalId),
					expectedRevision: positiveInteger(p.expectedRevision),
					decision: p.decision,
					argumentsDigest: digest(p.argumentsDigest),
					contentDigest: digest(p.contentDigest),
				},
			};
			break;
		case "getFileOperation":
			if (p.reconcile !== undefined && typeof p.reconcile !== "boolean") throw new AppError("INVALID_REQUEST");
			request = {
				version: PROTOCOL_VERSION,
				method: r.method,
				params: {
					...parseScope(p),
					operationId: id(p.operationId),
					...(p.reconcile === undefined ? {} : { reconcile: p.reconcile }),
				},
			};
			break;
		default:
			throw new AppError("INVALID_REQUEST");
	}
	if (Object.keys(p).some((k) => !Object.hasOwn(request.params, k))) throw new AppError("INVALID_REQUEST");
	if (r.expectedStoreId !== undefined) request.expectedStoreId = id(r.expectedStoreId);
	return request;
}

export const ERROR_CODES: readonly ErrorCode[] = [
	"INVALID_REQUEST",
	"NOT_FOUND",
	"IDEMPOTENCY_CONFLICT",
	"CAPACITY_EXCEEDED",
	"WORKSPACE_BUSY",
	"CLOSED",
	"INTERNAL",
	"UNAUTHORIZED",
	"STORE_MISMATCH",
	"MODEL_UNAVAILABLE",
	"CREDENTIAL_REQUIRED",
	"CONTEXT_AUTHORIZATION_REQUIRED",
	"RESUME_REQUIRED",
	"CONVERSATION_BUSY",
	"CONVERSATION_ARCHIVED",
	"RECONCILIATION_REQUIRED",
	"CURSOR_STALE",
	"INDEX_RECOVERY_REQUIRED",
];
export function parseError(value: unknown): ErrorCode {
	return ERROR_CODES.find((code) => code === value) ?? "INTERNAL";
}
function fields(value: Record<string, unknown>, keys: string[]) {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new AppError("INVALID_REQUEST");
}
function text(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length > max) throw new AppError("INVALID_REQUEST");
	return value;
}
function preview(value: unknown, length: unknown, truncated: unknown, max: number): TextPreview {
	const result = { text: text(value, max), textLength: integer(length) };
	if (
		typeof truncated !== "boolean" ||
		result.text.length > result.textLength ||
		truncated !== result.text.length < result.textLength
	)
		throw new AppError("INVALID_REQUEST");
	return { ...result, truncated };
}
function parseMessage(value: unknown): Message {
	const m = object(value);
	fields(m, ["id", "role", "text", "textLength", "truncated", "interrupted", "streamId"]);
	if (m.interrupted !== undefined && (m.interrupted !== true || m.role !== "assistant"))
		throw new AppError("INVALID_REQUEST");
	if (m.streamId !== undefined && m.role !== "assistant") throw new AppError("INVALID_REQUEST");
	if (m.role !== "user" && m.role !== "assistant") throw new AppError("INVALID_REQUEST");
	return {
		id: string(m.id, 256),
		role: m.role,
		...preview(m.text, m.textLength, m.truncated, LIMITS.messagePreview),
		...(m.interrupted === true ? { interrupted: true as const } : {}),
		...(m.streamId === undefined ? {} : { streamId: streamIdentity(m.streamId) }),
	};
}
function streamIdentity(value: unknown): string {
	const result = string(value, 36);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result))
		throw new AppError("INVALID_REQUEST");
	return result;
}
function messages(value: unknown): Message[] {
	if (!Array.isArray(value) || value.length > LIMITS.historyMessages) throw new AppError("INVALID_REQUEST");
	const result = value.map(parseMessage);
	const identities = result.flatMap((message) => (message.streamId ? [message.streamId] : []));
	if (new Set(identities).size !== identities.length) throw new AppError("INVALID_REQUEST");
	return result;
}
function cursor(value: unknown): string | null {
	return value === null ? null : string(value, LIMITS.cursor);
}
export function parseSnapshot(value: unknown): Snapshot {
	const p = object(value);
	fields(p, [
		"workspaceId",
		"conversationId",
		"messages",
		"partial",
		"partialLength",
		"partialTruncated",
		"partialId",
		"running",
		"historyCursor",
	]);
	if (typeof p.running !== "boolean") throw new AppError("INVALID_REQUEST");
	const partial = preview(p.partial, p.partialLength, p.partialTruncated, LIMITS.partialPreview);
	const committed = messages(p.messages);
	const partialId = p.partialId === undefined ? undefined : streamIdentity(p.partialId);
	if (partialId && committed.some((message) => message.streamId === partialId)) throw new AppError("INVALID_REQUEST");
	return {
		...parseScope(p),
		partial: partial.text,
		partialLength: partial.textLength,
		partialTruncated: partial.truncated,
		...(partialId === undefined ? {} : { partialId }),
		running: p.running,
		messages: committed,
		historyCursor: cursor(p.historyCursor),
	};
}
export function parseHistoryPage(value: unknown): HistoryPage {
	const p = object(value);
	fields(p, ["workspaceId", "conversationId", "messages", "nextCursor"]);
	return { ...parseScope(p), messages: messages(p.messages), nextCursor: cursor(p.nextCursor) };
}
export function parseMessageTextChunk(value: unknown): MessageTextChunk {
	const p = object(value);
	fields(p, ["workspaceId", "conversationId", "messageId", "text", "offset", "nextOffset", "textLength"]);
	const chunk = {
		...parseScope(p),
		messageId: string(p.messageId, 256),
		text: text(p.text, LIMITS.textChunk),
		offset: integer(p.offset),
		nextOffset: p.nextOffset === null ? null : integer(p.nextOffset),
		textLength: integer(p.textLength),
	};
	const end = chunk.offset + chunk.text.length;
	if (
		end > chunk.textLength ||
		(chunk.nextOffset === null
			? end !== chunk.textLength
			: chunk.nextOffset !== end || end >= chunk.textLength || end <= chunk.offset)
	)
		throw new AppError("INVALID_REQUEST");
	return chunk;
}
export function parseFrame(value: unknown): Frame {
	if (!fitsPayloadBudget(value)) throw new AppError("INVALID_REQUEST");
	const p = object(value);
	fields(p, ["kind", "epoch", "version", "snapshot"]);
	if (p.kind !== "snapshot") throw new AppError("INVALID_REQUEST");
	return {
		kind: "snapshot",
		epoch: string(p.epoch, 256),
		version: integer(p.version),
		snapshot: parseSnapshot(p.snapshot),
	};
}
export function parseModelReference(value: unknown): ModelReference {
	const p = object(value);
	fields(p, ["provider", "modelId"]);
	return { provider: id(p.provider), modelId: string(p.modelId, 256) };
}
function positiveInteger(value: unknown): number {
	const result = integer(value);
	if (result === 0) throw new AppError("INVALID_REQUEST");
	return result;
}
function digest(value: unknown): string {
	const result = string(value, 64);
	if (!/^[a-f0-9]{64}$/.test(result)) throw new AppError("INVALID_REQUEST");
	return result;
}
function agentPath(value: unknown, allowRoot = false): string {
	try {
		return validateRelativePath(value, allowRoot);
	} catch {
		throw new AppError("INVALID_REQUEST");
	}
}
function agentText(value: unknown, bytes: number): string {
	if (
		typeof value !== "string" ||
		/[\ud800-\udfff\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) ||
		new TextEncoder().encode(value).byteLength > bytes
	)
		throw new AppError("INVALID_REQUEST");
	return value;
}
function referenceIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > LIMITS.submissions) throw new AppError("INVALID_REQUEST");
	const result = Array.from(value, (item) => string(item, 256));
	if (new Set(result).size !== result.length) throw new AppError("INVALID_REQUEST");
	return result;
}
function agentContextRequest(p: Record<string, unknown>): AgentContextRequest {
	if (
		p.disclosureVersion !== 1 ||
		!Array.isArray(p.pathPrefixes) ||
		p.pathPrefixes.length === 0 ||
		p.pathPrefixes.length > AGENT_LIMITS.pathPrefixes
	)
		throw new AppError("INVALID_REQUEST");
	const pathPrefixes = Array.from(p.pathPrefixes, (item) => agentPath(item, true));
	if (new Set(pathPrefixes).size !== pathPrefixes.length) throw new AppError("INVALID_REQUEST");
	return {
		...parseScope(p),
		requestId: id(p.requestId),
		rootId: id(p.rootId),
		pathPrefixes,
		model: parseModelReference(p.model),
		expiresAt: integer(p.expiresAt),
		disclosureVersion: 1,
	};
}
export function parseAgentContext(value: unknown): AgentContext {
	const p = object(value);
	if (p.purpose !== "live-files" && p.purpose !== "retained-context") throw new AppError("INVALID_REQUEST");
	fields(p, [
		"workspaceId",
		"conversationId",
		"requestId",
		"rootId",
		"pathPrefixes",
		"model",
		"expiresAt",
		"disclosureVersion",
		"grantId",
		"revision",
		"status",
		"purpose",
		...(p.purpose === "retained-context" ? ["sourceGrantId"] : []),
	]);
	if (p.status !== "active" && p.status !== "revoked" && p.status !== "expired" && p.status !== "invalidated")
		throw new AppError("INVALID_REQUEST");
	return {
		...agentContextRequest(p),
		grantId: id(p.grantId),
		revision: positiveInteger(p.revision),
		status: p.status,
		...(p.purpose === "live-files"
			? { purpose: "live-files" as const }
			: { purpose: "retained-context" as const, sourceGrantId: id(p.sourceGrantId) }),
	};
}
export function parseToolApproval(value: unknown): ToolApproval {
	const p = object(value);
	fields(p, [
		"workspaceId",
		"conversationId",
		"approvalId",
		"taskId",
		"callId",
		"submissionIds",
		"receiptIds",
		"toolName",
		"model",
		"rootId",
		"path",
		"ifMatch",
		"text",
		"beforeText",
		"beforeTextTruncated",
		"argumentsDigest",
		"contentDigest",
		"grantId",
		"grantRevision",
		"expiresAt",
		"createdAt",
		"revision",
		"status",
		"operationId",
	]);
	if (
		p.toolName !== "hipi_files_save" ||
		typeof p.beforeTextTruncated !== "boolean" ||
		(p.status !== "pending" &&
			p.status !== "approved" &&
			p.status !== "rejected" &&
			p.status !== "expired" &&
			p.status !== "invalidated" &&
			p.status !== "consumed")
	)
		throw new AppError("INVALID_REQUEST");
	return {
		...parseScope(p),
		approvalId: id(p.approvalId),
		taskId: string(p.taskId, 256),
		callId: string(p.callId, 256),
		submissionIds: referenceIds(p.submissionIds),
		receiptIds: referenceIds(p.receiptIds),
		toolName: "hipi_files_save",
		model: parseModelReference(p.model),
		rootId: id(p.rootId),
		path: agentPath(p.path),
		ifMatch: digest(p.ifMatch),
		text: agentText(p.text, AGENT_LIMITS.textBytes),
		beforeText: agentText(p.beforeText, AGENT_LIMITS.beforeTextBytes),
		beforeTextTruncated: p.beforeTextTruncated,
		argumentsDigest: digest(p.argumentsDigest),
		contentDigest: digest(p.contentDigest),
		grantId: id(p.grantId),
		grantRevision: positiveInteger(p.grantRevision),
		expiresAt: integer(p.expiresAt),
		createdAt: integer(p.createdAt),
		revision: positiveInteger(p.revision),
		status: p.status,
		...(p.operationId === undefined ? {} : { operationId: id(p.operationId) }),
	};
}
export function parseFileOperation(value: unknown): FileOperation {
	const p = object(value);
	fields(p, [
		"workspaceId",
		"conversationId",
		"operationId",
		"approvalId",
		"taskId",
		"callId",
		"rootId",
		"path",
		"argumentsDigest",
		"contentDigest",
		"status",
		"revision",
		"evidence",
	]);
	if (
		p.status !== "prepared" &&
		p.status !== "executing" &&
		p.status !== "confirmed" &&
		p.status !== "conflict" &&
		p.status !== "unknown" &&
		p.status !== "observed_match"
	)
		throw new AppError("INVALID_REQUEST");
	const result: FileOperation = {
		...parseScope(p),
		operationId: id(p.operationId),
		approvalId: id(p.approvalId),
		taskId: string(p.taskId, 256),
		callId: string(p.callId, 256),
		rootId: id(p.rootId),
		path: agentPath(p.path),
		argumentsDigest: digest(p.argumentsDigest),
		contentDigest: digest(p.contentDigest),
		status: p.status,
		revision: positiveInteger(p.revision),
	};
	if (p.evidence !== undefined) {
		const evidence = object(p.evidence);
		fields(evidence, ["revision", "contentDigest"]);
		result.evidence = { revision: digest(evidence.revision), contentDigest: digest(evidence.contentDigest) };
	}
	return result;
}
function credentialState(value: unknown): CredentialState {
	if (value !== "configured" && value !== "missing" && value !== "locked" && value !== "unavailable")
		throw new AppError("INVALID_REQUEST");
	return value;
}
function parseToolActivity(value: unknown): ToolActivity {
	const p = object(value);
	fields(p, [
		"activityId",
		"taskId",
		"callId",
		"toolName",
		"source",
		"inherited",
		"anchor",
		"phase",
		"outcome",
		"toolResult",
		"abortRequested",
		"parentTaskId",
		"resultEntryId",
		"startedAt",
		"endedAt",
		"receiptIds",
		"approval",
		"effect",
		"artifact",
		"textAvailable",
		"outputTruncated",
	]);
	if (
		(p.source !== "task" && p.source !== "entry") ||
		typeof p.inherited !== "boolean" ||
		typeof p.abortRequested !== "boolean" ||
		typeof p.textAvailable !== "boolean" ||
		typeof p.outputTruncated !== "boolean"
	)
		throw new AppError("INVALID_REQUEST");
	if (
		p.phase !== "pending" &&
		p.phase !== "running" &&
		p.phase !== "waiting" &&
		p.phase !== "sleeping" &&
		p.phase !== "completing" &&
		p.phase !== "terminal" &&
		p.phase !== "unavailable"
	)
		throw new AppError("INVALID_REQUEST");
	if (p.toolResult !== "success" && p.toolResult !== "error" && p.toolResult !== "unavailable")
		throw new AppError("INVALID_REQUEST");
	const result: ToolActivity = {
		activityId: string(p.activityId, 2048),
		callId: string(p.callId, 256),
		toolName: string(p.toolName, 256),
		source: p.source,
		inherited: p.inherited,
		phase: p.phase,
		toolResult: p.toolResult,
		abortRequested: p.abortRequested,
		receiptIds: referenceIds(p.receiptIds),
		textAvailable: p.textAvailable,
		outputTruncated: p.outputTruncated,
	};
	if (p.taskId !== undefined) result.taskId = string(p.taskId, 256);
	if (p.parentTaskId !== undefined) result.parentTaskId = string(p.parentTaskId, 256);
	if (p.resultEntryId !== undefined) result.resultEntryId = string(p.resultEntryId, 256);
	if (p.startedAt !== undefined) result.startedAt = integer(p.startedAt);
	if (p.endedAt !== undefined) result.endedAt = integer(p.endedAt);
	if (p.outcome !== undefined) {
		if (
			p.outcome !== "completed" &&
			p.outcome !== "failed" &&
			p.outcome !== "aborted" &&
			p.outcome !== "orphaned" &&
			p.outcome !== "faulted"
		)
			throw new AppError("INVALID_REQUEST");
		result.outcome = p.outcome;
	}
	if (p.anchor !== undefined) {
		const anchor = object(p.anchor);
		fields(anchor, ["assistantEntryId", "modelIndex", "contentIndex"]);
		result.anchor = {
			assistantEntryId: string(anchor.assistantEntryId, 256),
			modelIndex: integer(anchor.modelIndex),
			contentIndex: integer(anchor.contentIndex),
		};
	}
	if (p.approval !== undefined) {
		const approval = object(p.approval);
		fields(approval, ["approvalId", "status", "grantId", "expired"]);
		if (
			typeof approval.expired !== "boolean" ||
			(approval.status !== "pending" &&
				approval.status !== "approved" &&
				approval.status !== "rejected" &&
				approval.status !== "expired" &&
				approval.status !== "invalidated" &&
				approval.status !== "consumed")
		)
			throw new AppError("INVALID_REQUEST");
		result.approval = {
			approvalId: id(approval.approvalId),
			status: approval.status,
			grantId: id(approval.grantId),
			expired: approval.expired,
		};
	}
	if (p.effect !== undefined) {
		const effect = object(p.effect);
		fields(effect, ["operationId", "status"]);
		if (
			effect.status !== "prepared" &&
			effect.status !== "executing" &&
			effect.status !== "confirmed" &&
			effect.status !== "conflict" &&
			effect.status !== "unknown" &&
			effect.status !== "observed_match"
		)
			throw new AppError("INVALID_REQUEST");
		result.effect = { operationId: id(effect.operationId), status: effect.status };
	}
	if (p.artifact !== undefined) {
		const artifact = object(p.artifact);
		fields(artifact, ["rootId", "path", "operationId", "status", "expectedRevision"]);
		if (
			!result.effect ||
			artifact.operationId !== result.effect.operationId ||
			artifact.status !== result.effect.status
		)
			throw new AppError("INVALID_REQUEST");
		result.artifact = {
			rootId: id(artifact.rootId),
			path: agentPath(artifact.path),
			operationId: result.effect.operationId,
			status: result.effect.status,
			...(artifact.expectedRevision === undefined ? {} : { expectedRevision: digest(artifact.expectedRevision) }),
		};
	}
	return result;
}
function parseConversationModel(value: unknown): ConversationModel {
	const p = object(value);
	fields(p, ["model", "credentialState", "executionState"]);
	if (
		p.executionState !== "ready" &&
		p.executionState !== "running" &&
		p.executionState !== "paused" &&
		p.executionState !== "cancellation_pending"
	)
		throw new AppError("INVALID_REQUEST");
	return {
		model: parseModelReference(p.model),
		credentialState: credentialState(p.credentialState),
		executionState: p.executionState,
	};
}
export function parseConversation(value: unknown): Conversation {
	const p = object(value);
	fields(p, ["workspaceId", "conversationId", "title", "revision", "createdAt", "archivedAt"]);
	return {
		...parseScope(p),
		title: string(p.title),
		revision: positiveInteger(p.revision),
		createdAt: p.createdAt === null ? null : integer(p.createdAt),
		archivedAt: p.archivedAt === null ? null : integer(p.archivedAt),
	};
}
export function parseConversationPresentation(value: unknown): ConversationPresentation {
	const p = object(value);
	fields(p, ["workspaceId", "conversationId", "revision", "pinned"]);
	if (typeof p.pinned !== "boolean" || (p.pinned && p.revision === 0)) throw new AppError("INVALID_REQUEST");
	return { ...parseScope(p), revision: integer(p.revision), pinned: p.pinned };
}
function parsePage<T>(value: unknown, max: number, parse: (value: unknown) => T, key: (item: T) => string): Page<T> {
	const p = object(value);
	fields(p, ["items", "nextCursor"]);
	if (!Array.isArray(p.items) || p.items.length > max) throw new AppError("INVALID_REQUEST");
	const items = Array.from(p.items, parse);
	if (new Set(items.map(key)).size !== items.length) throw new AppError("INVALID_REQUEST");
	return { items, nextCursor: cursor(p.nextCursor) };
}
export function parseResult<M extends Method>(method: M, value: unknown): Result<M> {
	if (!fitsPayloadBudget(value)) throw new AppError("INVALID_REQUEST");
	if (isProviderConfigurationMethod(method)) {
		try {
			return parseProviderConfigurationResult(method, value) as Result<M>;
		} catch {
			throw new AppError("INVALID_REQUEST");
		}
	}
	if (isToolPackMethod(method)) {
		try {
			return parseToolPackResult(method, value) as Result<M>;
		} catch {
			throw new AppError("INVALID_REQUEST");
		}
	}
	let result: Response;
	if (method === "refreshConversationSearch") {
		const p = object(value);
		fields(p, ["generation", "state", "completedAt", "nextCursor"]);
		if (p.state !== "building" && p.state !== "refreshing" && p.state !== "ready")
			throw new AppError("INVALID_REQUEST");
		const completedAt = p.completedAt === null ? null : integer(p.completedAt),
			nextCursor = cursor(p.nextCursor);
		if ((p.state === "building") !== (completedAt === null) || (p.state === "ready") !== (nextCursor === null))
			throw new AppError("INVALID_REQUEST");
		result = { generation: id(p.generation), state: p.state, completedAt, nextCursor };
	} else if (method === "searchConversations") {
		const p = object(value);
		fields(p, ["items", "index", "nextCursor"]);
		if (!Array.isArray(p.items) || p.items.length > SEARCH_LIMITS.results) throw new AppError("INVALID_REQUEST");
		const items = p.items.map((raw) => {
			const hit = object(raw);
			fields(hit, [
				"workspaceId",
				"conversationId",
				"title",
				"workspaceName",
				"snippet",
				"snippetOffset",
				"matchStart",
				"matchEnd",
				"kind",
				...(hit.kind === "message" ? ["messageId", "locator"] : []),
			]);
			const snippet = text(hit.snippet, SEARCH_LIMITS.snippet),
				snippetOffset = integer(hit.snippetOffset),
				matchStart = integer(hit.matchStart),
				matchEnd = integer(hit.matchEnd);
			if (matchStart < snippetOffset || matchEnd <= matchStart || matchEnd > snippetOffset + snippet.length)
				throw new AppError("INVALID_REQUEST");
			const common = {
				...parseScope(hit),
				title: string(hit.title),
				workspaceName: string(hit.workspaceName),
				snippet,
				snippetOffset,
				matchStart,
				matchEnd,
			};
			if (hit.kind === "title") return { ...common, kind: "title" as const };
			if (hit.kind !== "message" || !/^[1-9]\d*_(0|[1-9]\d*)$/.test(string(hit.messageId, 256)))
				throw new AppError("INVALID_REQUEST");
			return {
				...common,
				kind: "message" as const,
				messageId: string(hit.messageId, 256),
				locator: string(hit.locator, LIMITS.cursor),
			};
		});
		if (
			new Set(
				items.map((hit) =>
					JSON.stringify([
						hit.workspaceId,
						hit.conversationId,
						hit.kind,
						hit.kind === "message" ? hit.messageId : "",
					]),
				),
			).size !== items.length
		)
			throw new AppError("INVALID_REQUEST");
		result = { items, index: parseResult("refreshConversationSearch", p.index), nextCursor: cursor(p.nextCursor) };
	} else if (method === "getHistoryAroundMatch") {
		const p = object(value);
		fields(p, [
			"workspaceId",
			"conversationId",
			"messages",
			"target",
			"matchStart",
			"matchEnd",
			"olderCursor",
			"newerCursor",
		]);
		const scope = parseScope(p),
			target = parseMessageTextChunk(p.target),
			matchStart = integer(p.matchStart),
			matchEnd = integer(p.matchEnd);
		if (
			target.workspaceId !== scope.workspaceId ||
			target.conversationId !== scope.conversationId ||
			matchStart < target.offset ||
			matchEnd <= matchStart ||
			matchEnd > target.offset + target.text.length
		)
			throw new AppError("INVALID_REQUEST");
		result = {
			...scope,
			messages: messages(p.messages),
			target,
			matchStart,
			matchEnd,
			olderCursor: cursor(p.olderCursor),
			newerCursor: cursor(p.newerCursor),
		};
	} else if (method === "getToolActivities") {
		const p = object(value);
		fields(p, ["items", "nextCursor", "coverage", "membershipFence"]);
		if (
			!Array.isArray(p.items) ||
			p.items.length > ACTIVITY_LIMITS.page ||
			(p.coverage !== "tasks" && p.coverage !== "entries")
		)
			throw new AppError("INVALID_REQUEST");
		const items = Array.from(p.items, parseToolActivity);
		if (new Set(items.map((item) => item.activityId)).size !== items.length) throw new AppError("INVALID_REQUEST");
		result = {
			items,
			nextCursor: cursor(p.nextCursor),
			coverage: p.coverage,
			membershipFence: string(p.membershipFence, 2048),
		};
	} else if (method === "getToolActivityText") {
		const p = object(value);
		fields(p, ["activityId", "text", "nextCursor", "retainedOutputOnly"]);
		if (p.retainedOutputOnly !== true) throw new AppError("INVALID_REQUEST");
		const output = text(p.text, ACTIVITY_LIMITS.textBytes);
		if (/[\ud800-\udfff]/u.test(output) || new TextEncoder().encode(output).byteLength > ACTIVITY_LIMITS.textBytes)
			throw new AppError("INVALID_REQUEST");
		result = {
			activityId: string(p.activityId, 2048),
			text: output,
			nextCursor: cursor(p.nextCursor),
			retainedOutputOnly: p.retainedOutputOnly,
		};
	} else if (
		method === "authorizeAgentContext" ||
		method === "authorizeRetainedContext" ||
		method === "revokeAgentContext"
	) {
		result = parseAgentContext(value);
		if (
			(method === "authorizeAgentContext" && result.purpose !== "live-files") ||
			(method === "authorizeRetainedContext" && result.purpose !== "retained-context")
		)
			throw new AppError("INVALID_REQUEST");
	} else if (method === "listActiveAgentContexts") {
		if (!Array.isArray(value) || value.length > AGENT_LIMITS.activeContexts) throw new AppError("INVALID_REQUEST");
		const contexts = Array.from(value, parseAgentContext);
		if (new Set(contexts.map((context) => context.grantId)).size !== contexts.length)
			throw new AppError("INVALID_REQUEST");
		if (contexts.some((context) => context.status !== "active")) throw new AppError("INVALID_REQUEST");
		result = contexts;
	} else if (method === "listAgentContexts") {
		result = parsePage(value, AGENT_LIMITS.contexts, parseAgentContext, (item) => item.grantId);
	} else if (method === "listToolApprovals" || method === "listPendingToolApprovals") {
		const p = object(value);
		fields(p, ["items", "nextCursor"]);
		if (!Array.isArray(p.items) || p.items.length > AGENT_LIMITS.approvalPage) throw new AppError("INVALID_REQUEST");
		result = { items: Array.from(p.items, parseToolApproval), nextCursor: cursor(p.nextCursor) };
	} else if (method === "getConversationPresentation" || method === "setConversationPinned") {
		result = parseConversationPresentation(value);
	} else if (method === "getPresentationCommandResult") {
		if (value === null) result = null;
		else {
			const p = object(value);
			fields(p, ["method", "params", "result"]);
			if (p.method !== "setConversationPinned") throw new AppError("INVALID_REQUEST");
			const request = parseRequest({ version: PROTOCOL_VERSION, method: p.method, params: p.params });
			if (request.method !== "setConversationPinned") throw new AppError("INVALID_REQUEST");
			const presentation = parseConversationPresentation(p.result);
			if (
				presentation.workspaceId !== request.params.workspaceId ||
				presentation.conversationId !== request.params.conversationId ||
				presentation.pinned !== request.params.pinned ||
				presentation.revision < request.params.expectedPresentationRevision ||
				presentation.revision > request.params.expectedPresentationRevision + 1
			)
				throw new AppError("INVALID_REQUEST");
			result = { method: p.method, params: request.params, result: presentation };
		}
	} else if (method === "listPinnedConversations") {
		result = parsePage(
			value,
			LIMITS.directoryPage,
			(raw) => {
				const p = object(raw);
				fields(p, ["conversation", "presentation"]);
				const conversation = parseConversation(p.conversation);
				const presentation = parseConversationPresentation(p.presentation);
				if (
					conversation.workspaceId !== presentation.workspaceId ||
					conversation.conversationId !== presentation.conversationId ||
					conversation.archivedAt !== null ||
					!presentation.pinned
				)
					throw new AppError("INVALID_REQUEST");
				return { conversation, presentation };
			},
			(item) => JSON.stringify([item.conversation.workspaceId, item.conversation.conversationId]),
		);
	} else if (method === "getConversationCommandResult") {
		if (value === null) result = null;
		else {
			const p = object(value);
			fields(p, ["method", "result"]);
			if (
				p.method !== "createConversation" &&
				p.method !== "renameConversation" &&
				p.method !== "archiveConversation" &&
				p.method !== "restoreConversation"
			)
				throw new AppError("INVALID_REQUEST");
			result = { method: p.method, result: parseConversation(p.result) };
		}
	} else if (method === "getAgentCommandResult") {
		if (value === null) result = null;
		else {
			const p = object(value);
			fields(p, ["method", "result"]);
			if (p.method === "decideToolApproval") result = { method: p.method, result: parseToolApproval(p.result) };
			else if (
				p.method === "authorizeAgentContext" ||
				p.method === "authorizeRetainedContext" ||
				p.method === "revokeAgentContext"
			)
				result = { method: p.method, result: parseResult(p.method, p.result) };
			else throw new AppError("INVALID_REQUEST");
		}
	} else if (method === "decideToolApproval") result = parseToolApproval(value);
	else if (method === "getFileOperation") result = value === null ? null : parseFileOperation(value);
	else if (method === "listModels") {
		const p = object(value);
		fields(p, ["models", "providers"]);
		if (!Array.isArray(p.models) || p.models.length > 512 || !Array.isArray(p.providers) || p.providers.length > 32)
			throw new AppError("INVALID_REQUEST");
		result = {
			models: p.models.map((item) => {
				const m = object(item);
				fields(m, ["provider", "modelId", "name"]);
				return { ...parseModelReference({ provider: m.provider, modelId: m.modelId }), name: string(m.name, 256) };
			}),
			providers: p.providers.map((item) => {
				const m = object(item);
				fields(m, ["provider", "name", "credentialState"]);
				return {
					provider: id(m.provider),
					name: string(m.name, 256),
					credentialState: credentialState(m.credentialState),
				};
			}),
		};
	} else if (method === "getConversationModel" || method === "cancelExecution") result = parseConversationModel(value);
	else if (method === "continueWorkspace") {
		const p = object(value);
		fields(p, ["workspaceId", "state"]);
		if (p.state !== "authorized") throw new AppError("INVALID_REQUEST");
		result = { workspaceId: id(p.workspaceId), state: "authorized" };
	} else if (method === "handshake") {
		const p = object(value);
		fields(p, ["protocolVersion", "storeId"]);
		if (p.protocolVersion !== PROTOCOL_VERSION) throw new AppError("INVALID_REQUEST");
		result = { protocolVersion: PROTOCOL_VERSION, storeId: id(p.storeId) };
	} else if (method === "listWorkspaces") {
		result = parsePage(
			value,
			LIMITS.directoryPage,
			(item) => parseResult("openWorkspace", item),
			(item) => item.workspaceId,
		);
	} else if (method === "listConversations") {
		result = parsePage(value, LIMITS.directoryPage, parseConversation, (item) => item.conversationId);
	} else if (method === "getReceipt" && value === null) result = null;
	else if (method === "snapshot") result = parseSnapshot(value);
	else if (method === "getHistory") result = parseHistoryPage(value);
	else if (method === "getMessageText") result = parseMessageTextChunk(value);
	else {
		const p = object(value);
		if (method === "createWorkspace" || method === "openWorkspace" || method === "getWorkspace") {
			fields(p, ["workspaceId", "name"]);
			result = { workspaceId: id(p.workspaceId), name: string(p.name) };
		} else if (
			method === "createConversation" ||
			method === "getConversation" ||
			method === "renameConversation" ||
			method === "archiveConversation" ||
			method === "restoreConversation"
		) {
			result = parseConversation(p);
		} else {
			fields(p, [
				"workspaceId",
				"conversationId",
				"requestId",
				"receiptId",
				"state",
				"submissionId",
				...(method === "getReceipt"
					? [
							"execution",
							"answer",
							"answerLength",
							"answerTruncated",
							"answerEntryId",
							"reason",
							"reasonLength",
							"reasonTruncated",
							"modelFailure",
						]
					: []),
			]);
			if (
				p.state !== "accepted" &&
				p.state !== "dispatching" &&
				p.state !== "dispatched" &&
				p.state !== "reconciliation_required" &&
				p.state !== "cancelled"
			)
				throw new AppError("INVALID_REQUEST");
			const receipt: ReceiptView = {
				...parseScope(p),
				requestId: id(p.requestId),
				receiptId: string(p.receiptId, 256),
				state: p.state,
			};
			if (p.submissionId !== undefined) receipt.submissionId = string(p.submissionId, 256);
			if (p.execution !== undefined) {
				if (
					p.execution !== "queued" &&
					p.execution !== "placed" &&
					p.execution !== "done" &&
					p.execution !== "unanswered"
				)
					throw new AppError("INVALID_REQUEST");
				receipt.execution = p.execution;
			}
			if ([p.answer, p.answerLength, p.answerTruncated, p.answerEntryId].some((value) => value !== undefined)) {
				const answer = preview(p.answer, p.answerLength, p.answerTruncated, LIMITS.messagePreview);
				const answerEntryId = string(p.answerEntryId, 256);
				if (!/^(0|[1-9][0-9]*)$/.test(answerEntryId)) throw new AppError("INVALID_REQUEST");
				receipt.answer = answer.text;
				receipt.answerLength = answer.textLength;
				receipt.answerTruncated = answer.truncated;
				receipt.answerEntryId = answerEntryId;
			}
			if ([p.reason, p.reasonLength, p.reasonTruncated].some((value) => value !== undefined)) {
				const reason = preview(p.reason, p.reasonLength, p.reasonTruncated, LIMITS.messagePreview);
				receipt.reason = reason.text;
				receipt.reasonLength = reason.textLength;
				receipt.reasonTruncated = reason.truncated;
			}
			if (p.modelFailure !== undefined) {
				const failure = object(p.modelFailure);
				fields(failure, ["category", "dispatch"]);
				const category = modelFailureCategory(failure.category);
				if (
					receipt.execution !== "unanswered" ||
					receipt.reason !== "model_error" ||
					!category ||
					(failure.dispatch !== "not_sent" && failure.dispatch !== "attempted" && failure.dispatch !== "unknown")
				)
					throw new AppError("INVALID_REQUEST");
				receipt.modelFailure = { category, dispatch: failure.dispatch };
			}
			result = receipt;
		}
	}
	// Each method branch reconstructs and validates its public result shape above.
	return result as Result<M>;
}

export function parseObservationStatus(value: unknown): ObservationStatus {
	const p = object(value);
	if (p.state === "connected") {
		fields(p, ["state"]);
		return { state: "connected" };
	}
	fields(p, ["state", "reason", "code"]);
	if (
		p.state !== "closed" ||
		(p.reason !== "disposed" && p.reason !== "disconnected" && p.reason !== "expired" && p.reason !== "error")
	)
		throw new AppError("INVALID_REQUEST");
	return { state: "closed", reason: p.reason, ...(p.code === undefined ? {} : { code: parseError(p.code) }) };
}
