import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CheckpointInfo, defineDocFamily, type Storage, type Tx } from "@earendil-works/pi-durable";
import {
	type AgentContext,
	AppError,
	type FileOperation,
	parseResult,
	type Result,
	type ToolApproval,
} from "../contracts.ts";

// Bound current-only replay; independent audit records retain the business history.
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) => info.deltasSinceBase >= 31;

export async function readAgentCommandResult(
	storage: Storage,
	workspaceId: string,
	publicId: string,
	durableId: number,
	requestId: string,
): Promise<Result<"getAgentCommandResult">> {
	return resolveAgentCommandResult(
		async (kind, key) => {
			const record = await storage.findDocument(
				{ kind, scope: { kind: "session" }, key },
				"current",
				BACKGROUND_CONTEXT,
			);
			const doc = record ? await storage.document(record.id, "current", BACKGROUND_CONTEXT) : undefined;
			if (doc && doc.version !== 1) throw new AppError("INDEX_RECOVERY_REQUIRED");
			return doc?.value;
		},
		workspaceId,
		publicId,
		durableId,
		requestId,
	);
}

export async function resolveAgentCommandResult(
	read: (kind: string, key: string) => Promise<unknown>,
	workspaceId: string,
	publicId: string,
	durableId: number,
	requestId: string,
): Promise<Result<"getAgentCommandResult">> {
	const object = (value: unknown): Record<string, unknown> => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("UNAUTHORIZED");
		return value as Record<string, unknown>;
	};
	const context = await read("hipi.agent-context.v2", String(durableId));
	if (!context) throw new AppError("INDEX_RECOVERY_REQUIRED");
	const state = object(context);
	if (state.publicId !== publicId || typeof state.sessionId !== "string" || !state.sessionId)
		throw new AppError("UNAUTHORIZED");
	const raw = await read("hipi.agent-command", commandKey(durableId, requestId));
	if (raw === undefined) return null;
	const record = object(raw);
	const command = object(record.value);
	if (
		record.conversationId !== durableId ||
		record.publicId !== publicId ||
		command.requestId !== requestId ||
		typeof command.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(command.digest) ||
		typeof command.resultId !== "string" ||
		!command.resultId
	)
		throw new AppError("UNAUTHORIZED");
	const method =
		command.kind === "decide"
			? "decideToolApproval"
			: command.kind === "authorize"
				? "authorizeAgentContext"
				: command.kind === "authorize-retained"
					? "authorizeRetainedContext"
					: command.kind === "revoke"
						? "revokeAgentContext"
						: undefined;
	if (!method) throw new AppError("UNAUTHORIZED");
	const target = object(
		await read(method === "decideToolApproval" ? "hipi.tool-approval" : "hipi.agent-grant", command.resultId),
	);
	if (method !== "decideToolApproval" && target.conversationId !== durableId) throw new AppError("UNAUTHORIZED");
	const result = parseResult("getAgentCommandResult", { method, result: target.value });
	if (
		!result ||
		result.result.workspaceId !== workspaceId ||
		result.result.conversationId !== publicId ||
		(result.method === "decideToolApproval" ? result.result.approvalId : result.result.grantId) !== command.resultId
	)
		throw new AppError("UNAUTHORIZED");
	return result;
}

export type Dependency = { rootId: string; path: string };
export type AuthorizationState = {
	publicId: string;
	sessionId: string;
	initialized: boolean;
	grantIds: string[];
	pendingIds: string[];
	operationIds: string[];
	dependencies: Dependency[];
	cancelled: boolean;
	grantCount: number;
	approvalCount: number;
	operationCount: number;
};
export const ContextDoc = defineDocFamily<AuthorizationState, null>({
	kind: "hipi.agent-context.v2",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({
		publicId: "",
		sessionId: "",
		initialized: false,
		grantIds: [],
		pendingIds: [],
		operationIds: [],
		dependencies: [],
		cancelled: false,
		grantCount: 0,
		approvalCount: 0,
		operationCount: 0,
	}),
});
export const GrantDoc = defineDocFamily<{ conversationId: number; value?: AgentContext }, null>({
	kind: "hipi.agent-grant",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({ conversationId: 0 }),
});
export type Command = {
	requestId: string;
	digest: string;
	resultId: string;
	kind: string;
	firstResult?: AgentContext | ToolApproval;
};
export const CommandDoc = defineDocFamily<{ conversationId: number; publicId: string; value?: Command }, null>({
	kind: "hipi.agent-command",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({ conversationId: 0, publicId: "" }),
});
export const BindingDoc = defineDocFamily<{ sessionId: string; conversationId: number }, null>({
	kind: "hipi.agent-session-binding",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({ sessionId: "", conversationId: 0 }),
});
export type AuditKind = "grant" | "approval" | "operation";
const AuditPageDoc = defineDocFamily<{ ids: string[] }, null>({
	kind: "hipi.agent-audit-page",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({ ids: [] }),
});
export const LegacyContextDoc = defineDocFamily<
	{
		publicId: string;
		grants: AgentContext[];
		dependencies: Dependency[];
		approvals: string[];
		commands: Command[];
		cancelled: boolean;
	},
	null
>({
	kind: "hipi.agent-context",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({ publicId: "", grants: [], dependencies: [], approvals: [], commands: [], cancelled: false }),
});
export const commandKey = (id: number, requestId: string) =>
	createHash("sha256")
		.update(JSON.stringify([1, id, requestId]))
		.digest("hex");
export const bindingKey = (sessionId: string) =>
	createHash("sha256")
		.update(JSON.stringify([1, sessionId]))
		.digest("hex");
export async function appendAudit(
	tx: Tx,
	id: number,
	state: AuthorizationState,
	kind: AuditKind,
	valueId: string,
): Promise<void> {
	const count = `${kind}Count` as const;
	const ordinal = state[count];
	if (!Number.isSafeInteger(ordinal + 1)) throw new AppError("CAPACITY_EXCEEDED");
	const page = await tx.doc(AuditPageDoc, `${id}-${kind}-${Math.floor(ordinal / 64)}`, null);
	if (page.ids.length !== ordinal % 64) throw new AppError("INTERNAL");
	page.ids.push(valueId);
	state[count]++;
}
export async function auditId(tx: Tx, id: number, kind: AuditKind, ordinal: number): Promise<string> {
	const page = await tx.doc(AuditPageDoc, `${id}-${kind}-${Math.floor(ordinal / 64)}`, null);
	const key = page.ids[ordinal % 64];
	if (!key) throw new AppError("INTERNAL");
	return key;
}
export function auditPosition(
	generation: string,
	workspaceId: string,
	publicId: string,
	kind: string,
	count: number,
	cursor?: string,
): { upper: number; position: number } {
	if (cursor === undefined) return { upper: count, position: count };
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new AppError("INVALID_REQUEST");
	}
	if (
		!Array.isArray(value) ||
		value.length !== 7 ||
		value[0] !== 1 ||
		value[1] !== generation ||
		value[2] !== workspaceId ||
		value[3] !== publicId ||
		typeof value[4] !== "string" ||
		!Number.isSafeInteger(value[5]) ||
		!Number.isSafeInteger(value[6]) ||
		value[5] < 0 ||
		value[6] < 0 ||
		value[6] > value[5]
	)
		throw new AppError("INVALID_REQUEST");
	if (/^pending-[a-f0-9]{64}$/.test(kind)) {
		if (!/^pending-[a-f0-9]{64}$/.test(value[4]) || value[5] > 64) throw new AppError("INVALID_REQUEST");
		// A valid cursor for the previous bounded live set is stale, even when
		// its upper position now exceeds the smaller current set.
		if (value[4] !== kind) throw new AppError("CURSOR_STALE");
	}
	if (value[4] !== kind || value[5] > count) throw new AppError("INVALID_REQUEST");
	return { upper: value[5], position: value[6] };
}
export function auditCursor(
	generation: string,
	workspaceId: string,
	publicId: string,
	kind: string,
	upper: number,
	position: number,
): string | null {
	return position
		? Buffer.from(JSON.stringify([1, generation, workspaceId, publicId, kind, upper, position])).toString("base64url")
		: null;
}

export const ApprovalDoc = defineDocFamily<{ value?: ToolApproval }, null>({
	kind: "hipi.tool-approval",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({}),
});
export const OperationDoc = defineDocFamily<{ value?: FileOperation }, null>({
	kind: "hipi.file-operation",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({}),
});
