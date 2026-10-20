import {
	type AgentContext,
	type AgentContextRequest,
	type ModelReference,
	PROTOCOL_VERSION,
	parseRequest,
} from "@hipi/work-runtime/contracts";

/** A memory-only choice until Send captures it. A project binding is never itself a grant. */
export type StagedProjectConsent = {
	workspaceId: string;
	bindingId: string;
	bindingRevision: number;
	rootId: string;
	model: ModelReference;
	pathPrefixes: string[];
	expiresAt: number;
	disclosureVersion: 1;
};

/** Immutable consent recovery, not evidence of current runtime authority. */
export type InitialContext = {
	staged: StagedProjectConsent;
	requestId: string;
	createAttempted: boolean;
	authorization: AgentContextRequest | null;
	submitAttempted: boolean;
	invalidated: boolean;
	/** Write-ahead provenance for explicit draft combination, never an execution or grant receipt. */
	draftCombination?: { beforeRevision: string | null; revision: string };
};

export function parseStagedProjectConsent(value: unknown): StagedProjectConsent {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_INITIAL_CONTEXT");
	const p = value as Record<string, unknown>;
	if (
		Object.keys(p).some(
			(key) =>
				![
					"workspaceId",
					"bindingId",
					"bindingRevision",
					"rootId",
					"model",
					"pathPrefixes",
					"expiresAt",
					"disclosureVersion",
				].includes(key),
		) ||
		typeof p.bindingId !== "string" ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(p.bindingId) ||
		typeof p.bindingRevision !== "number" ||
		!Number.isSafeInteger(p.bindingRevision) ||
		p.bindingRevision < 1
	)
		throw new Error("INVALID_INITIAL_CONTEXT");
	const request = parseRequest({
		version: PROTOCOL_VERSION,
		method: "authorizeAgentContext",
		params: {
			workspaceId: p.workspaceId,
			conversationId: "staged",
			requestId: "staged",
			rootId: p.rootId,
			pathPrefixes: p.pathPrefixes,
			model: p.model,
			expiresAt: p.expiresAt,
			disclosureVersion: p.disclosureVersion,
		},
	});
	if (request.method !== "authorizeAgentContext") throw new Error("INVALID_INITIAL_CONTEXT");
	const { conversationId: _conversationId, requestId: _requestId, ...context } = request.params;
	return { ...context, bindingId: p.bindingId, bindingRevision: p.bindingRevision };
}

export function matchesInitialGrant(request: AgentContextRequest, grant: AgentContext): boolean {
	return (
		grant.purpose === "live-files" &&
		grant.workspaceId === request.workspaceId &&
		grant.conversationId === request.conversationId &&
		grant.requestId === request.requestId &&
		grant.rootId === request.rootId &&
		grant.model.provider === request.model.provider &&
		grant.model.modelId === request.model.modelId &&
		grant.expiresAt === request.expiresAt &&
		grant.disclosureVersion === request.disclosureVersion &&
		JSON.stringify(grant.pathPrefixes) === JSON.stringify(request.pathPrefixes)
	);
}
