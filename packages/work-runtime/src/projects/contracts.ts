import type { Conversation, ConversationFilter, ModelReference, Scope } from "../contracts.ts";

/** Browser-safe logical identity. Equality with a workspace ID is only a legacy migration mapping. */
export type ProjectId = string;
export const PROJECT_LIMITS = { name: 128, page: 50, cursor: 2048 } as const;
export type Project = {
	projectId: ProjectId;
	name: string;
	revision: number;
	/** Creation destination, not the execution workspace of every member conversation. */
	homeWorkspaceId: string;
};
export type ConversationMembership = Scope & { projectId: ProjectId | null; revision: number };
export type ProjectPresentation = { projectId: ProjectId; pinned: boolean; revision: number };
/** Current membership against the named published projection, not a live physical snapshot.
 * completedAt is its last verified traversal; complete also requires exhausting the bounded membership read. */
export type ProjectConversationSummary = {
	matchedAtLeast: number;
	complete: boolean;
	coverage: {
		generation: string;
		projectMembershipGeneration: number;
		state: "building" | "refreshing" | "ready";
		completedAt: number | null;
	};
};
export type ProjectListItem = { project: Project; presentation: ProjectPresentation };
export type ProjectPage = {
	items: ProjectListItem[];
	metadataGeneration: number;
	orderGeneration: number;
	nextCursor: string | null;
};
export const PROJECT_RECOVERY_REASONS = [
	"legacy_default_unknown",
	"legacy_default_conflict",
	"workspace_unavailable",
	"adoption_incomplete",
] as const;
export type ProjectRecoveryReason = (typeof PROJECT_RECOVERY_REASONS)[number];
export type ProjectCatalogState = {
	state: "ready" | "adopting" | "recovery_required";
	generation: number;
	/** Null is valid for a pristine catalog before its first projectless conversation. */
	defaultWorkspaceId: string | null;
	reason?: ProjectRecoveryReason;
};
/** Declaration from the trusted startup owner, not runtime attestation of renderer storage. */
export type LegacyDefaultWorkspaceProvenance = {
	storeId: string;
	markerVersion: 1;
	role: "default-chat-workspace";
	workspaceId: string;
};
export type AdoptLegacyDefaultWorkspace = {
	requestId: string;
	workspaceId: string;
	expectedCatalogGeneration: number;
	expectedDefaultWorkspaceId: string | null;
	provenance: LegacyDefaultWorkspaceProvenance;
};
export type CreateProjectConversation = {
	requestId: string;
	projectId: ProjectId | null;
	title: string;
	model?: ModelReference;
};
export type ProjectConversation = { conversation: Conversation; membership: ConversationMembership };
export type ProjectMutations = {
	adoptLegacyDefaultWorkspace: { params: AdoptLegacyDefaultWorkspace; result: ProjectCatalogState };
	createProject: { params: { requestId: string; name: string }; result: Project };
	createProjectConversation: { params: CreateProjectConversation; result: ProjectConversation };
	renameProject: {
		params: { requestId: string; projectId: ProjectId; expectedRevision: number; name: string };
		result: Project;
	};
	setProjectPinned: {
		params: { requestId: string; projectId: ProjectId; expectedPresentationRevision: number; pinned: boolean };
		result: ProjectPresentation;
	};
	reorderPinnedProject: {
		params: {
			requestId: string;
			movedProjectId: ProjectId;
			/** Null means the end of the complete pinned list, including unloaded projects. */
			beforeProjectId: ProjectId | null;
			expectedOrderGeneration: number;
		};
		result: { orderGeneration: number };
	};
};
export type ProjectMutationMethod = keyof ProjectMutations;
/** Original normalized input and reserved identities survive interruption without a second scheduler. */
export type ProjectPendingCommand =
	| {
			status: "pending";
			method: "adoptLegacyDefaultWorkspace";
			params: AdoptLegacyDefaultWorkspace;
			stage: "backfilling";
			reserved: { workspaceId: string };
	  }
	| {
			status: "pending";
			method: "createProject";
			params: ProjectMutations["createProject"]["params"];
			stage: "reserved" | "physical_created";
			reserved: { projectId: ProjectId; workspaceId: string };
	  }
	| {
			status: "pending";
			method: "createProjectConversation";
			params: CreateProjectConversation;
			stage: "reserved" | "workspace_created" | "physical_created";
			/** Conversation identity comes from the physical owner's immutable command receipt. */
			reserved: { workspaceId: string; innerRequestId: string; createDefault: boolean };
	  };
/** The original terminal result is immutable even when current metadata subsequently changes. */
export type ProjectCompletedCommand = {
	[M in ProjectMutationMethod]: {
		status: "completed";
		method: M;
		params: ProjectMutations[M]["params"];
		result: ProjectMutations[M]["result"];
	};
}[ProjectMutationMethod];
export type ProjectCommandResult = ProjectPendingCommand | ProjectCompletedCommand;
export type ProjectMethods = ProjectMutations & {
	getProjectCatalogState: { params: Record<string, never>; result: ProjectCatalogState };
	listProjects: { params: { cursor?: string }; result: ProjectPage };
	getProject: { params: { projectId: ProjectId }; result: Project };
	getProjectPresentation: { params: { projectId: ProjectId }; result: ProjectPresentation };
	getProjectConversationSummary: {
		params: { projectId: ProjectId; filter: ConversationFilter };
		result: ProjectConversationSummary;
	};
	getConversationMembership: { params: Scope; result: ConversationMembership };
	/** Null means no admission; pending never means it is safe to create a different command. */
	getProjectCommandResult: { params: { requestId: string }; result: ProjectCommandResult | null };
};
export type ProjectMethod = keyof ProjectMethods;
export type ProjectRequest = {
	[M in ProjectMethod]: { method: M; params: ProjectMethods[M]["params"] };
}[ProjectMethod];
export type ProjectResponse = ProjectMethods[ProjectMethod]["result"];
export const PROJECT_MUTATION_METHODS: readonly ProjectMutationMethod[] = [
	"adoptLegacyDefaultWorkspace",
	"createProject",
	"createProjectConversation",
	"renameProject",
	"setProjectPinned",
	"reorderPinnedProject",
];
export const PROJECT_METHODS: readonly ProjectMethod[] = [
	"getProjectCatalogState",
	"listProjects",
	"getProject",
	"getProjectPresentation",
	"getProjectConversationSummary",
	"getConversationMembership",
	"getProjectCommandResult",
	...PROJECT_MUTATION_METHODS,
];
export function isProjectMethod(value: unknown): value is ProjectMethod {
	return typeof value === "string" && PROJECT_METHODS.some((method) => method === value);
}
export function isProjectMutationMethod(value: unknown): value is ProjectMutationMethod {
	return typeof value === "string" && PROJECT_MUTATION_METHODS.some((method) => method === value);
}
export class ProjectContractError extends Error {}
function invalid(): never {
	throw new ProjectContractError("INVALID_REQUEST");
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
	if (!/^[a-zA-Z0-9_-]+$(?![\s\S])/u.test(result)) return invalid();
	return result;
}
function nullableId(value: unknown): string | null {
	return value === null ? null : id(value);
}
function integer(value: unknown, min = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) return invalid();
	return value;
}
function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") return invalid();
	return value;
}
function followsRevision(value: number, expected: number): boolean {
	return value === expected || value === expected + 1;
}
export function parseProjectId(value: unknown): ProjectId {
	return id(value);
}
export function parseProjectParams<M extends ProjectMethod>(method: M, value: unknown): ProjectMethods[M]["params"] {
	let result: unknown;
	switch (method) {
		case "getProjectConversationSummary": {
			const p = object(value, ["projectId", "filter"]);
			if (p.filter !== "active" && p.filter !== "archived" && p.filter !== "all") return invalid();
			result = { projectId: id(p.projectId), filter: p.filter };
			break;
		}
		case "getProjectCatalogState":
			object(value, []);
			result = {};
			break;
		case "listProjects": {
			const p = object(value, ["cursor"]);
			result = p.cursor === undefined ? {} : { cursor: string(p.cursor, PROJECT_LIMITS.cursor) };
			break;
		}
		case "getProject":
		case "getProjectPresentation": {
			const p = object(value, ["projectId"]);
			result = { projectId: id(p.projectId) };
			break;
		}
		case "getConversationMembership": {
			const p = object(value, ["workspaceId", "conversationId"]);
			result = { workspaceId: id(p.workspaceId), conversationId: id(p.conversationId) };
			break;
		}
		case "getProjectCommandResult": {
			const p = object(value, ["requestId"]);
			result = { requestId: id(p.requestId) };
			break;
		}
		case "adoptLegacyDefaultWorkspace": {
			const p = object(value, [
				"requestId",
				"workspaceId",
				"expectedCatalogGeneration",
				"expectedDefaultWorkspaceId",
				"provenance",
			]);
			const provenance = object(p.provenance, ["storeId", "markerVersion", "role", "workspaceId"]);
			const workspaceId = id(p.workspaceId);
			if (
				provenance.markerVersion !== 1 ||
				provenance.role !== "default-chat-workspace" ||
				provenance.workspaceId !== workspaceId
			)
				return invalid();
			result = {
				requestId: id(p.requestId),
				workspaceId,
				expectedCatalogGeneration: integer(p.expectedCatalogGeneration),
				expectedDefaultWorkspaceId: nullableId(p.expectedDefaultWorkspaceId),
				provenance: {
					storeId: id(provenance.storeId),
					markerVersion: 1,
					role: "default-chat-workspace",
					workspaceId,
				},
			};
			break;
		}
		case "createProject": {
			const p = object(value, ["requestId", "name"]);
			result = { requestId: id(p.requestId), name: string(p.name, PROJECT_LIMITS.name) };
			break;
		}
		case "createProjectConversation": {
			const p = object(value, ["requestId", "projectId", "title", "model"]);
			let model: ModelReference | undefined;
			if (p.model !== undefined) {
				const m = object(p.model, ["provider", "modelId"]);
				model = { provider: id(m.provider), modelId: string(m.modelId, 256) };
			}
			result = {
				requestId: id(p.requestId),
				projectId: nullableId(p.projectId),
				title: string(p.title),
				...(model === undefined ? {} : { model }),
			};
			break;
		}
		case "renameProject": {
			const p = object(value, ["requestId", "projectId", "expectedRevision", "name"]);
			result = {
				requestId: id(p.requestId),
				projectId: id(p.projectId),
				expectedRevision: integer(p.expectedRevision, 1),
				name: string(p.name, PROJECT_LIMITS.name),
			};
			break;
		}
		case "setProjectPinned": {
			const p = object(value, ["requestId", "projectId", "expectedPresentationRevision", "pinned"]);
			result = {
				requestId: id(p.requestId),
				projectId: id(p.projectId),
				expectedPresentationRevision: integer(p.expectedPresentationRevision),
				pinned: boolean(p.pinned),
			};
			break;
		}
		case "reorderPinnedProject": {
			const p = object(value, ["requestId", "movedProjectId", "beforeProjectId", "expectedOrderGeneration"]);
			const movedProjectId = id(p.movedProjectId);
			const beforeProjectId = nullableId(p.beforeProjectId);
			if (movedProjectId === beforeProjectId) return invalid();
			result = {
				requestId: id(p.requestId),
				movedProjectId,
				beforeProjectId,
				expectedOrderGeneration: integer(p.expectedOrderGeneration),
			};
			break;
		}
		default:
			return invalid();
	}
	return result as ProjectMethods[M]["params"];
}
/** Stable normalization shared by the browser and the catalog command journal. */
export function projectCommandPayload<M extends ProjectMutationMethod>(
	method: M,
	params: ProjectMutations[M]["params"],
): string {
	return JSON.stringify({ method, params: parseProjectParams(method, params) });
}
export function parseProject(value: unknown): Project {
	const p = object(value, ["projectId", "name", "revision", "homeWorkspaceId"]);
	return {
		projectId: id(p.projectId),
		name: string(p.name, PROJECT_LIMITS.name),
		revision: integer(p.revision, 1),
		homeWorkspaceId: id(p.homeWorkspaceId),
	};
}
export function parseConversationMembership(value: unknown): ConversationMembership {
	const p = object(value, ["workspaceId", "conversationId", "projectId", "revision"]);
	return {
		workspaceId: id(p.workspaceId),
		conversationId: id(p.conversationId),
		projectId: nullableId(p.projectId),
		revision: integer(p.revision, 1),
	};
}
export function parseProjectPresentation(value: unknown): ProjectPresentation {
	const p = object(value, ["projectId", "pinned", "revision"]);
	const pinned = boolean(p.pinned);
	return { projectId: id(p.projectId), pinned, revision: integer(p.revision, pinned ? 1 : 0) };
}
export function parseProjectCatalogState(value: unknown): ProjectCatalogState {
	const p = object(value, ["state", "generation", "defaultWorkspaceId", "reason"]);
	if (p.state !== "ready" && p.state !== "adopting" && p.state !== "recovery_required") return invalid();
	const reason = PROJECT_RECOVERY_REASONS.find((candidate) => candidate === p.reason);
	if (p.reason !== undefined && (reason === undefined || p.state === "ready")) return invalid();
	return {
		state: p.state,
		generation: integer(p.generation),
		defaultWorkspaceId: nullableId(p.defaultWorkspaceId),
		...(reason === undefined ? {} : { reason }),
	};
}
function projectConversation(value: unknown): ProjectConversation {
	const p = object(value, ["conversation", "membership"]);
	const c = object(p.conversation, ["workspaceId", "conversationId", "title", "revision", "createdAt", "archivedAt"]);
	const conversation: Conversation = {
		workspaceId: id(c.workspaceId),
		conversationId: id(c.conversationId),
		title: string(c.title),
		revision: integer(c.revision, 1),
		createdAt: c.createdAt === null ? null : integer(c.createdAt),
		archivedAt: c.archivedAt === null ? null : integer(c.archivedAt),
	};
	const membership = parseConversationMembership(p.membership);
	if (
		conversation.workspaceId !== membership.workspaceId ||
		conversation.conversationId !== membership.conversationId ||
		conversation.revision !== 1 ||
		membership.revision !== 1
	)
		return invalid();
	return { conversation, membership };
}
function pendingCommand(value: unknown): ProjectPendingCommand {
	const p = object(value, ["status", "method", "params", "stage", "reserved"]);
	if (p.status !== "pending") return invalid();
	if (p.method === "adoptLegacyDefaultWorkspace") {
		const params = parseProjectParams(p.method, p.params);
		const reserved = object(p.reserved, ["workspaceId"]);
		if (p.stage !== "backfilling" || reserved.workspaceId !== params.workspaceId) return invalid();
		return {
			status: "pending",
			method: p.method,
			params,
			stage: p.stage,
			reserved: { workspaceId: params.workspaceId },
		};
	}
	if (p.method === "createProject") {
		const params = parseProjectParams(p.method, p.params);
		const reserved = object(p.reserved, ["projectId", "workspaceId"]);
		if (p.stage !== "reserved" && p.stage !== "physical_created") return invalid();
		return {
			status: "pending",
			method: p.method,
			params,
			stage: p.stage,
			reserved: { projectId: id(reserved.projectId), workspaceId: id(reserved.workspaceId) },
		};
	}
	if (p.method === "createProjectConversation") {
		const params = parseProjectParams(p.method, p.params);
		const reserved = object(p.reserved, ["workspaceId", "innerRequestId", "createDefault"]);
		if (p.stage !== "reserved" && p.stage !== "workspace_created" && p.stage !== "physical_created") return invalid();
		const createDefault = boolean(reserved.createDefault);
		if (createDefault && params.projectId !== null) return invalid();
		return {
			status: "pending",
			method: p.method,
			params,
			stage: p.stage,
			reserved: {
				workspaceId: id(reserved.workspaceId),
				innerRequestId: id(reserved.innerRequestId),
				createDefault,
			},
		};
	}
	return invalid();
}
function completedCommand(value: unknown): ProjectCompletedCommand {
	const p = object(value, ["status", "method", "params", "result"]);
	if (p.status !== "completed" || !isProjectMutationMethod(p.method)) return invalid();
	switch (p.method) {
		case "adoptLegacyDefaultWorkspace": {
			const params = parseProjectParams(p.method, p.params);
			const result = parseProjectResult(p.method, p.result);
			if (result.state !== "ready" || result.defaultWorkspaceId !== params.workspaceId) return invalid();
			return { status: "completed", method: p.method, params, result };
		}
		case "createProject": {
			const params = parseProjectParams(p.method, p.params);
			const result = parseProject(p.result);
			if (result.name !== params.name || result.revision !== 1) return invalid();
			return { status: "completed", method: p.method, params, result };
		}
		case "createProjectConversation": {
			const params = parseProjectParams(p.method, p.params);
			const result = projectConversation(p.result);
			if (result.membership.projectId !== params.projectId || result.conversation.title !== params.title)
				return invalid();
			return { status: "completed", method: p.method, params, result };
		}
		case "renameProject": {
			const params = parseProjectParams(p.method, p.params);
			const result = parseProject(p.result);
			if (
				result.projectId !== params.projectId ||
				result.name !== params.name ||
				!followsRevision(result.revision, params.expectedRevision)
			)
				return invalid();
			return { status: "completed", method: p.method, params, result };
		}
		case "setProjectPinned": {
			const params = parseProjectParams(p.method, p.params);
			const result = parseProjectPresentation(p.result);
			if (
				result.projectId !== params.projectId ||
				result.pinned !== params.pinned ||
				!followsRevision(result.revision, params.expectedPresentationRevision)
			)
				return invalid();
			return { status: "completed", method: p.method, params, result };
		}
		case "reorderPinnedProject": {
			const params = parseProjectParams(p.method, p.params);
			const result = parseProjectResult(p.method, p.result);
			if (!followsRevision(result.orderGeneration, params.expectedOrderGeneration)) return invalid();
			return { status: "completed", method: p.method, params, result };
		}
	}
}
export function parseProjectResult<M extends ProjectMethod>(method: M, value: unknown): ProjectMethods[M]["result"] {
	let result: unknown;
	switch (method) {
		case "getProjectConversationSummary": {
			const p = object(value, ["matchedAtLeast", "complete", "coverage"]),
				c = object(p.coverage, ["generation", "projectMembershipGeneration", "state", "completedAt"]);
			const matchedAtLeast = integer(p.matchedAtLeast),
				complete = boolean(p.complete);
			if (matchedAtLeast > 128 || (c.state !== "building" && c.state !== "refreshing" && c.state !== "ready"))
				return invalid();
			const completedAt = c.completedAt === null ? null : integer(c.completedAt);
			if (
				(c.state === "building" && (completedAt !== null || matchedAtLeast !== 0)) ||
				(c.state !== "building" && completedAt === null) ||
				(complete && c.state !== "ready")
			)
				return invalid();
			result = {
				matchedAtLeast,
				complete,
				coverage: {
					generation: id(c.generation),
					projectMembershipGeneration: integer(c.projectMembershipGeneration),
					state: c.state,
					completedAt,
				},
			};
			break;
		}
		case "getProjectPresentation":
			result = parseProjectPresentation(value);
			break;
		case "getProjectCatalogState":
			result = parseProjectCatalogState(value);
			break;
		case "adoptLegacyDefaultWorkspace": {
			const state = parseProjectCatalogState(value);
			if (state.state !== "ready") return invalid();
			result = state;
			break;
		}
		case "createProject": {
			const project = parseProject(value);
			if (project.revision !== 1) return invalid();
			result = project;
			break;
		}
		case "renameProject":
		case "getProject":
			result = parseProject(value);
			break;
		case "getConversationMembership":
			result = parseConversationMembership(value);
			break;
		case "createProjectConversation":
			result = projectConversation(value);
			break;
		case "setProjectPinned":
			result = parseProjectPresentation(value);
			break;
		case "reorderPinnedProject": {
			const p = object(value, ["orderGeneration"]);
			result = { orderGeneration: integer(p.orderGeneration) };
			break;
		}
		case "listProjects": {
			const p = object(value, ["items", "metadataGeneration", "orderGeneration", "nextCursor"]);
			if (!Array.isArray(p.items) || p.items.length > PROJECT_LIMITS.page) return invalid();
			const items = Array.from(p.items, (value): ProjectListItem => {
				const item = object(value, ["project", "presentation"]);
				const project = parseProject(item.project);
				const presentation = parseProjectPresentation(item.presentation);
				if (project.projectId !== presentation.projectId) return invalid();
				return { project, presentation };
			});
			if (new Set(items.map((item) => item.project.projectId)).size !== items.length) return invalid();
			result = {
				items,
				metadataGeneration: integer(p.metadataGeneration),
				orderGeneration: integer(p.orderGeneration),
				nextCursor: p.nextCursor === null ? null : string(p.nextCursor, PROJECT_LIMITS.cursor),
			};
			break;
		}
		case "getProjectCommandResult": {
			if (value === null) result = null;
			else {
				const p = object(value, ["status", "method", "params", "stage", "reserved", "result"]);
				if (p.status === "pending") result = pendingCommand(p);
				else if (p.status === "completed") result = completedCommand(p);
				else return invalid();
			}
			break;
		}
		default:
			return invalid();
	}
	return result as ProjectMethods[M]["result"];
}
