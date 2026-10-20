import {
	LIMITS,
	type ModelReference,
	PROTOCOL_VERSION,
	type ProjectCatalogState,
	parseRequest,
	type ReceiptView,
	type Scope,
	type Submit,
} from "@hipi/work-runtime/contracts";
import type { CatalogCommand } from "../command-recovery.ts";
import { ACTIVE_DRAFT_KEY, parseActiveDraft, validHomeDraft } from "../composer/draft-record.ts";
import type { SavedValue } from "../local-persistence.ts";
import type { LocalState } from "../local-state.ts";
import { parseProjectCommand } from "../projects/commands.ts";
import { canCreateProjectless } from "../projects/identity.ts";
import { parseStoredRequest } from "../recovery/stored-request.ts";
import { type InitialContext, parseStagedProjectConsent, type StagedProjectConsent } from "./initial-context.ts";

export type { StagedProjectConsent } from "./initial-context.ts";

type WorkspaceCommand = Extract<CatalogCommand, { method: "createWorkspace" }>;
type ConversationCommand = Extract<CatalogCommand, { method: "createConversation" }>;
type LogicalConversationCommand = Extract<CatalogCommand, { method: "createProjectConversation" }>;
export type InitialSendInput = {
	workspaceId: string | null;
	/** Present only for logical creation. Physical workspace remains a consent destination, not project identity. */
	projectId?: string | null;
	text: string;
	title: string;
	model?: ModelReference;
	sourceKey: string;
	sourceGeneration?: string;
	context?: StagedProjectConsent;
};
/** Authorization to finish one captured Send, not an independently persisted execution status. */
export type InitialSend = {
	workspaceCommand: WorkspaceCommand | null;
	conversationCommand: ConversationCommand | LogicalConversationCommand;
	/** Set only from the exact completed logical creation receipt. */
	workspaceId?: string | null;
	text: string;
	submissionId: string;
	sourceKey: string;
	sourceRevision: string | null;
	sourceGeneration?: string;
	conversationId: string | null;
	context?: InitialContext;
};
export type InitialSendRecovery = { request: CatalogCommand | null; initialSend: InitialSend };
const id = /^[a-zA-Z0-9_-]{1,128}$/;
const recoveryKey = "command.catalog";
const defaultKey = "default-chat-workspace";

export function initialWorkspaceId(task: InitialSend): string {
	if (task.conversationCommand.method === "createConversation") return task.conversationCommand.params.workspaceId;
	if (task.workspaceId) return task.workspaceId;
	throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_INITIAL_SEND");
	return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
	if (typeof value !== "string" || !id.test(value)) throw new Error("INVALID_INITIAL_SEND");
	return value;
}
function nullableIdentifier(value: unknown): string | null {
	return value === null ? null : identifier(value);
}
function workspaceCommand(value: unknown): WorkspaceCommand {
	const command = parseStoredRequest(value);
	if (command.expectedStoreId !== undefined || command.method !== "createWorkspace" || command.params.name !== "Chats")
		throw new Error("INVALID_DEFAULT_WORKSPACE");
	return command;
}
function defaultWorkspaceIdentity(value: unknown): string {
	const marker = object(value);
	if (marker.version === 1) {
		if (
			marker.role !== "default-chat-workspace" ||
			Object.keys(marker).some((key) => !["version", "role", "workspaceId"].includes(key))
		)
			throw new Error("INVALID_DEFAULT_WORKSPACE");
		return identifier(marker.workspaceId);
	}
	return workspaceCommand(marker).params.workspaceId;
}
/** Presentation may hide only this verified store-scoped default identity, never a matching name. */
export function defaultChatWorkspaceId(local: LocalState): string | null {
	try {
		const raw = local.storedValue(defaultKey)?.value;
		return raw ? defaultWorkspaceIdentity(JSON.parse(raw)) : null;
	} catch {
		return null;
	}
}
function conversationCommand(value: unknown): ConversationCommand {
	const command = parseStoredRequest(value);
	if (command.expectedStoreId !== undefined || command.method !== "createConversation")
		throw new Error("INVALID_INITIAL_SEND");
	return command;
}
function sourceKey(value: unknown, workspaceId: string): string {
	if (value !== "chat-draft.global" && value !== `task-draft.${workspaceId}`)
		throw new Error("INVALID_INITIAL_SEND_SOURCE");
	return value;
}
export function readInitialSendRecovery(value: unknown): InitialSendRecovery {
	const saved = object(value);
	const task = object(saved.initialSend);
	if (
		(saved.version !== 3 && saved.version !== 4 && saved.version !== 5 && saved.version !== 6) ||
		(saved.version === 6 && saved.kind !== "logical-initial-send") ||
		Object.keys(saved).some(
			(key) => !["version", "request", "initialSend", ...(saved.version === 6 ? ["kind"] : [])].includes(key),
		) ||
		Object.keys(task).some(
			(key) =>
				![
					"workspaceCommand",
					"conversationCommand",
					"text",
					"submissionId",
					"sourceKey",
					"sourceRevision",
					"conversationId",
					"context",
					...(saved.version === 5 || saved.version === 6 ? ["sourceGeneration"] : []),
					...(saved.version === 6 ? ["workspaceId"] : []),
				].includes(key),
		) ||
		typeof task.text !== "string" ||
		!task.text.trim() ||
		task.text.length > LIMITS.text
	)
		throw new Error("INVALID_INITIAL_SEND");
	const conversation =
		saved.version === 6 ? parseProjectCommand(task.conversationCommand) : conversationCommand(task.conversationCommand);
	if (conversation.method !== "createConversation" && conversation.method !== "createProjectConversation")
		throw new Error("INVALID_INITIAL_SEND");
	const workspace = task.workspaceCommand === null ? null : workspaceCommand(task.workspaceCommand);
	if (saved.version === 6 && (workspace !== null || (task.conversationId === null) !== (task.workspaceId === null)))
		throw new Error("INVALID_INITIAL_SEND");
	if (
		workspace &&
		(conversation.method !== "createConversation" || workspace.params.workspaceId !== conversation.params.workspaceId)
	)
		throw new Error("INITIAL_SEND_SCOPE_MISMATCH");
	const independentSource =
		(saved.version === 5 || saved.version === 6) &&
		typeof task.sourceKey === "string" &&
		validHomeDraft(task.sourceKey, task.text)
			? task.sourceKey
			: null;
	if ((saved.version === 5 || saved.version === 6) && independentSource === null)
		throw new Error("INVALID_INITIAL_SEND_SOURCE");
	const initialSend: InitialSend = {
		workspaceCommand: workspace,
		conversationCommand: conversation,
		text: task.text,
		submissionId: identifier(task.submissionId),
		sourceKey:
			independentSource ??
			sourceKey(task.sourceKey, conversation.method === "createConversation" ? conversation.params.workspaceId : ""),
		sourceRevision: nullableIdentifier(task.sourceRevision),
		conversationId: nullableIdentifier(task.conversationId),
		...(saved.version === 6 ? { workspaceId: nullableIdentifier(task.workspaceId) } : {}),
	};
	if (saved.version === 5 || saved.version === 6) {
		initialSend.sourceGeneration = identifier(task.sourceGeneration);
		if (task.sourceRevision === null) throw new Error("INVALID_INITIAL_SEND_SOURCE");
	}
	if (saved.version === 4 || ((saved.version === 5 || saved.version === 6) && task.context !== undefined)) {
		const context = object(task.context);
		const staged = parseStagedProjectConsent(context.staged);
		const model = conversation.params.model;
		if (
			Object.keys(context).some(
				(key) =>
					![
						"staged",
						"requestId",
						"createAttempted",
						"authorization",
						"submitAttempted",
						"invalidated",
						"draftCombination",
					].includes(key),
			) ||
			typeof context.createAttempted !== "boolean" ||
			typeof context.submitAttempted !== "boolean" ||
			typeof context.invalidated !== "boolean" ||
			(conversation.method === "createConversation"
				? staged.workspaceId !== conversation.params.workspaceId
				: conversation.params.projectId === null ||
					(task.workspaceId !== null && staged.workspaceId !== task.workspaceId)) ||
			workspace !== null ||
			!model ||
			model.provider !== staged.model.provider ||
			model.modelId !== staged.model.modelId
		)
			throw new Error("INVALID_INITIAL_CONTEXT");
		const requestId = identifier(context.requestId);
		const authorization =
			context.authorization === null
				? null
				: parseRequest({ version: PROTOCOL_VERSION, method: "authorizeAgentContext", params: context.authorization });
		if (authorization && authorization.method !== "authorizeAgentContext") throw new Error("INVALID_INITIAL_CONTEXT");
		const expected = initialContextRequest(staged, requestId, initialSend.conversationId ?? "unverified");
		if (
			(authorization &&
				(!initialSend.conversationId || JSON.stringify(authorization.params) !== JSON.stringify(expected))) ||
			(initialSend.conversationId !== null && !context.createAttempted) ||
			(context.submitAttempted && !authorization)
		)
			throw new Error("INVALID_INITIAL_CONTEXT");
		initialSend.context = {
			staged,
			requestId,
			createAttempted: context.createAttempted,
			authorization: authorization?.params ?? null,
			submitAttempted: context.submitAttempted,
			invalidated: context.invalidated,
		};
		if (context.draftCombination !== undefined) {
			const combination = object(context.draftCombination);
			if (
				Object.keys(combination).some((key) => !["beforeRevision", "revision"].includes(key)) ||
				context.submitAttempted ||
				(context.createAttempted && !initialSend.conversationId)
			)
				throw new Error("INVALID_INITIAL_CONTEXT");
			initialSend.context.draftCombination = {
				beforeRevision: nullableIdentifier(combination.beforeRevision),
				revision: identifier(combination.revision),
			};
			if (initialSend.context.draftCombination.beforeRevision === initialSend.context.draftCombination.revision)
				throw new Error("INVALID_INITIAL_CONTEXT");
		}
	} else if (task.context !== undefined) throw new Error("INVALID_INITIAL_CONTEXT");
	const request =
		saved.request === null
			? null
			: saved.version === 6
				? parseProjectCommand(saved.request)
				: parseStoredRequest(saved.request);
	if (
		(request === null && initialSend.conversationId === null) ||
		(request !== null &&
			(request.expectedStoreId !== undefined ||
				(request.method !== "createWorkspace" &&
					request.method !== "createConversation" &&
					!(saved.version === 6 && request.method === "createProjectConversation")) ||
				JSON.stringify(request) !== JSON.stringify(request.method === "createWorkspace" ? workspace : conversation))) ||
		(request !== null && initialSend.conversationId !== null)
	)
		throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
	return { request, initialSend };
}
function save(local: LocalState, record: InitialSendRecovery) {
	local.persistValue({
		kind: "value",
		key: recoveryKey,
		value: JSON.stringify({
			version:
				record.initialSend.conversationCommand.method === "createProjectConversation"
					? 6
					: record.initialSend.sourceGeneration
						? 5
						: record.initialSend.context
							? 4
							: 3,
			...(record.initialSend.conversationCommand.method === "createProjectConversation"
				? { kind: "logical-initial-send" }
				: {}),
			...record,
		}),
	});
}
function initialContextRequest(staged: StagedProjectConsent, requestId: string, conversationId: string) {
	return {
		workspaceId: staged.workspaceId,
		conversationId,
		requestId,
		rootId: staged.rootId,
		pathPrefixes: staged.pathPrefixes,
		model: staged.model,
		expiresAt: staged.expiresAt,
		disclosureVersion: staged.disclosureVersion,
	};
}
/** Persist the exact next prerequisite before issuing its side effect. */
export function advanceInitialContext(
	local: LocalState,
	expected: InitialSendRecovery,
	stage: "create" | "authorize" | "submit" | "invalidate",
	signal: AbortSignal,
) {
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const saved = currentInitialSend(local, expected);
		const task = saved.initialSend;
		const context = task.context;
		if (
			!context ||
			(stage === "create" &&
				((saved.request?.method !== "createConversation" && saved.request?.method !== "createProjectConversation") ||
					task.conversationId)) ||
			((stage === "authorize" || stage === "submit") && (!task.conversationId || saved.request))
		)
			throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
		const next = {
			...saved,
			initialSend: {
				...task,
				context: {
					...context,
					...(stage === "create" ? { createAttempted: true } : {}),
					...(stage === "authorize" && task.conversationId
						? { authorization: initialContextRequest(context.staged, context.requestId, task.conversationId) }
						: {}),
					...(stage === "submit" ? { submitAttempted: true } : {}),
					...(stage === "invalidate" ? { invalidated: true } : {}),
				},
			},
		};
		save(local, next);
		return next;
	});
}
export function currentInitialSend(local: LocalState, expected: InitialSendRecovery): InitialSendRecovery {
	const raw = local.storedValue(recoveryKey)?.value;
	if (!raw) throw new Error("INITIAL_SEND_OWNER_CHANGED");
	const saved = readInitialSendRecovery(JSON.parse(raw));
	if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error("INITIAL_SEND_OWNER_CHANGED");
	return saved;
}
export function admitInitialSend(
	local: LocalState,
	input: InitialSendInput,
	signal: AbortSignal,
	catalogState?: ProjectCatalogState,
) {
	const captured = structuredClone(input);
	// Admission may wait behind another tab. Only the draft present at Send belongs to this request.
	const source = local.valueSnapshot(captured.sourceKey);
	let sourceRevision = source?.value === captured.text ? (source.revision ?? null) : null;
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const previous = local.storedValue(recoveryKey)?.value;
		if (previous && previous !== JSON.stringify({ version: 2, request: null }))
			throw new Error("CATALOG_RECOVERY_EXISTS");
		if (captured.sourceGeneration !== undefined) {
			const owner = parseActiveDraft(local.storedValue(ACTIVE_DRAFT_KEY)?.value ?? "null");
			const stored = local.storedValue(captured.sourceKey);
			const edited = local.valueSnapshot(captured.sourceKey);
			if (
				owner.generation !== captured.sourceGeneration ||
				owner.sourceKey !== captured.sourceKey ||
				!source ||
				source.value !== captured.text ||
				!stored ||
				!edited ||
				(stored.revision ?? null) !== sourceRevision ||
				stored.value !== captured.text ||
				(edited.revision ?? null) !== sourceRevision ||
				edited.value !== captured.text ||
				local.unsavedDraftValues().some((entry) => entry.key === captured.sourceKey)
			)
				throw new Error("INITIAL_SEND_SOURCE_CHANGED");
			if (sourceRevision === null) {
				// Explicit Send establishes revision ownership for a legacy text-only record, without changing its text.
				sourceRevision = crypto.randomUUID();
				local.persistValue({ ...stored, revision: sourceRevision });
			}
		}
		if (captured.projectId !== undefined) {
			if (captured.projectId === null && !canCreateProjectless(local, catalogState))
				throw new Error("PROJECT_DESTINATION_UNVERIFIED");
			if (!captured.sourceGeneration || !sourceRevision) throw new Error("INVALID_INITIAL_SEND_SOURCE");
			const conversation: LogicalConversationCommand = {
				version: PROTOCOL_VERSION,
				method: "createProjectConversation",
				params: {
					requestId: crypto.randomUUID(),
					projectId: captured.projectId,
					title: captured.title,
					...(captured.model ? { model: captured.model } : {}),
				},
			};
			const record = readInitialSendRecovery({
				version: 6,
				kind: "logical-initial-send",
				request: conversation,
				initialSend: {
					workspaceCommand: null,
					conversationCommand: conversation,
					workspaceId: null,
					text: captured.text,
					submissionId: crypto.randomUUID(),
					sourceKey: captured.sourceKey,
					sourceRevision,
					sourceGeneration: captured.sourceGeneration,
					conversationId: null,
					...(captured.context
						? {
								context: {
									staged: captured.context,
									requestId: crypto.randomUUID(),
									createAttempted: false,
									authorization: null,
									submitAttempted: false,
									invalidated: false,
								},
							}
						: {}),
				},
			});
			save(local, record);
			return record;
		}
		let workspace: WorkspaceCommand | null = null;
		let createWorkspace = false;
		if (captured.workspaceId === null) {
			const existing = local.storedValue(defaultKey)?.value;
			if (existing)
				workspace = {
					version: PROTOCOL_VERSION,
					method: "createWorkspace",
					params: { workspaceId: defaultWorkspaceIdentity(JSON.parse(existing)), name: "Chats" },
				};
			else {
				workspace = {
					version: PROTOCOL_VERSION,
					method: "createWorkspace",
					params: { workspaceId: crypto.randomUUID(), name: "Chats" },
				};
				createWorkspace = true;
			}
		}
		const workspaceId = workspace?.params.workspaceId ?? identifier(captured.workspaceId);
		const key =
			captured.sourceGeneration === undefined ? sourceKey(captured.sourceKey, workspaceId) : captured.sourceKey;
		if (captured.sourceGeneration === undefined && captured.workspaceId === null && key !== "chat-draft.global")
			throw new Error("INVALID_INITIAL_SEND_SOURCE");
		const conversation: ConversationCommand = {
			version: PROTOCOL_VERSION,
			method: "createConversation",
			params: {
				workspaceId,
				requestId: crypto.randomUUID(),
				title: captured.title,
				...(captured.model ? { model: captured.model } : {}),
			},
		};
		const record = readInitialSendRecovery({
			version: captured.sourceGeneration !== undefined ? 5 : captured.context ? 4 : 3,
			request: createWorkspace ? workspace : conversation,
			initialSend: {
				workspaceCommand: workspace,
				conversationCommand: conversation,
				text: captured.text,
				submissionId: crypto.randomUUID(),
				sourceKey: key,
				sourceRevision,
				...(captured.sourceGeneration !== undefined ? { sourceGeneration: captured.sourceGeneration } : {}),
				conversationId: null,
				...(captured.context
					? {
							context: {
								staged: captured.context,
								requestId: crypto.randomUUID(),
								createAttempted: false,
								authorization: null,
								submitAttempted: false,
								invalidated: false,
							},
						}
					: {}),
			},
		});
		save(local, record);
		return record;
	});
}
/** Only a verified exact workspace result permits recording the default identity and advancing. */
export function finishInitialWorkspace(local: LocalState, expected: InitialSendRecovery, signal: AbortSignal) {
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const saved = currentInitialSend(local, expected);
		if (!saved.initialSend.workspaceCommand || saved.request?.method !== "createWorkspace")
			throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
		const workspaceId = saved.initialSend.workspaceCommand.params.workspaceId;
		const mapping = JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId });
		const existing = local.storedValue(defaultKey)?.value;
		if (existing && defaultWorkspaceIdentity(JSON.parse(existing)) !== workspaceId)
			throw new Error("DEFAULT_WORKSPACE_CHANGED");
		local.persistValue({ kind: "value", key: defaultKey, value: mapping });
		const next = { ...saved, request: saved.initialSend.conversationCommand };
		save(local, next);
		return next;
	});
}
export function finishInitialConversation(
	local: LocalState,
	expected: InitialSendRecovery,
	conversationId: string,
	signal: AbortSignal,
) {
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const saved = currentInitialSend(local, expected);
		if (saved.request?.method !== "createConversation") throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
		const next = {
			request: null,
			initialSend: { ...saved.initialSend, conversationId: identifier(conversationId) },
		};
		save(local, next);
		return next;
	});
}

/** A logical creation receipt supplies execution identity; it is never reconstructed from ProjectId. */
export function finishLogicalInitialConversation(
	local: LocalState,
	expected: InitialSendRecovery,
	scope: Scope,
	signal: AbortSignal,
) {
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const saved = currentInitialSend(local, expected);
		if (saved.request?.method !== "createProjectConversation") throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
		const next = {
			request: null,
			initialSend: {
				...saved.initialSend,
				workspaceId: identifier(scope.workspaceId),
				conversationId: identifier(scope.conversationId),
			},
		};
		save(local, next);
		return next;
	});
}
/** Explicit pre-submit recovery only. Keeps the project draft and never creates execution recovery. */
export function releaseInitialDraft(
	local: LocalState,
	expected: InitialSendRecovery,
	signal: AbortSignal,
	combination?: { key: string; stored: SavedValue | null; edited: SavedValue | null },
) {
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const saved = currentInitialSend(local, expected);
		const { initialSend: task, request } = saved;
		if (!task.context || task.context.submitAttempted) throw new Error("INITIAL_CONTEXT_PREREQUISITE_REQUIRED");
		if (
			(task.context.createAttempted && (request || !task.conversationId)) ||
			(!task.context.createAttempted &&
				(task.conversationId ||
					(request?.method !== "createConversation" && request?.method !== "createProjectConversation")))
		)
			throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
		const destinationKey = task.conversationId
			? `draft.${initialWorkspaceId(task)}.${task.conversationId}`
			: task.sourceKey;
		if (combination) {
			const stored = local.storedValue(destinationKey);
			const edited = local.valueSnapshot(destinationKey);
			if (
				combination.key !== destinationKey ||
				JSON.stringify(combination.stored) !== JSON.stringify(combination.edited) ||
				JSON.stringify(stored) !== JSON.stringify(combination.stored) ||
				JSON.stringify(edited) !== JSON.stringify(combination.edited)
			)
				return false;
			const journal = task.context.draftCombination;
			if (journal && stored?.revision !== journal.revision && (stored?.revision ?? null) !== journal.beforeRevision)
				return false;
			if (!journal || stored?.revision !== journal.revision) {
				const existing = stored?.value ?? "";
				const text = existing ? `${existing}\n\n---\n\n${task.text}` : task.text;
				if (text.length > LIMITS.text) return false;
				const revision = crypto.randomUUID();
				// The journal makes a successful draft write recognizable if clearing its owner fails.
				save(local, {
					...saved,
					initialSend: {
						...task,
						context: {
							...task.context,
							invalidated: true,
							draftCombination: { beforeRevision: stored?.revision ?? null, revision },
						},
					},
				});
				local.persistValue({
					kind: "value",
					key: destinationKey,
					value: text,
					revision,
					...(task.conversationId ? { handoffRequestId: task.submissionId, handoffRevision: revision } : {}),
				});
			}
			local.persistValue({ kind: "value", key: recoveryKey, value: JSON.stringify({ version: 2, request: null }) });
			return true;
		}
		if (!task.context.createAttempted) {
			if (
				task.conversationId ||
				(request?.method !== "createConversation" && request?.method !== "createProjectConversation")
			)
				throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
			const source = local.storedValue(task.sourceKey);
			const edited = local.valueSnapshot(task.sourceKey);
			if (source?.value !== task.text || edited?.value !== task.text || source?.revision !== edited?.revision) {
				if (source?.value || edited?.value || source?.revision !== edited?.revision) return false;
				local.persistValue({
					kind: "value",
					key: task.sourceKey,
					value: task.text,
					revision: crypto.randomUUID(),
				});
			}
			local.persistValue({ kind: "value", key: recoveryKey, value: JSON.stringify({ version: 2, request: null }) });
			return true;
		}
		if (request || !task.conversationId) throw new Error("INITIAL_CONTEXT_PREREQUISITE_REQUIRED");
		const key = `draft.${initialWorkspaceId(task)}.${task.conversationId}`;
		const stored = local.storedValue(key);
		const edited = local.valueSnapshot(key);
		if (stored?.handoffRequestId !== task.submissionId) {
			if (stored?.value || edited?.value || stored?.revision !== edited?.revision) return false;
			const revision = crypto.randomUUID();
			local.persistValue({
				kind: "value",
				key,
				value: task.text,
				revision,
				handoffRequestId: task.submissionId,
				handoffRevision: revision,
			});
		}
		local.persistValue({ kind: "value", key: recoveryKey, value: JSON.stringify({ version: 2, request: null }) });
		return true;
	});
}
/** The only execution recovery owner is the existing per-conversation pending Submit record. */
export async function transferInitialSubmission(
	local: LocalState,
	expected: InitialSendRecovery,
	signal: AbortSignal,
	onAdmitted: (input: Submit) => void,
	confirmedConsentReceipt?: ReceiptView,
): Promise<{ input: Submit; newlyAdmitted: boolean }> {
	const { input, draftRevision } = await local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const { initialSend: task, request } = currentInitialSend(local, expected);
		if (
			task.context &&
			(!confirmedConsentReceipt ||
				confirmedConsentReceipt.workspaceId !== initialWorkspaceId(task) ||
				confirmedConsentReceipt.conversationId !== task.conversationId ||
				confirmedConsentReceipt.requestId !== task.submissionId)
		)
			throw new Error("INITIAL_CONTEXT_PREREQUISITE_REQUIRED");
		if (request || !task.conversationId) throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
		const input: Submit = {
			workspaceId: initialWorkspaceId(task),
			conversationId: task.conversationId,
			requestId: task.submissionId,
			text: task.text,
		};
		const destinationKey = `draft.${input.workspaceId}.${input.conversationId}`;
		let destination = local.storedValue(destinationKey);
		const localDestination = local.valueSnapshot(destinationKey);
		// Never overwrite another draft, including an identical independently authored one.
		if (
			!destination?.handoffRequestId &&
			!destination?.value &&
			!localDestination?.value &&
			destination?.revision === localDestination?.revision
		) {
			const revision = crypto.randomUUID();
			destination = {
				kind: "value",
				key: destinationKey,
				value: input.text,
				revision,
				handoffRequestId: task.submissionId,
				handoffRevision: revision,
			};
			local.persistValue(destination);
		}
		const draftRevision =
			destination?.handoffRequestId === task.submissionId &&
			destination.revision === destination.handoffRevision &&
			destination.value === task.text
				? (destination.revision ?? null)
				: null;
		return { input, draftRevision };
	});
	signal.throwIfAborted();
	const key = `${input.workspaceId}.${input.conversationId}`;
	const newlyAdmitted = await local.rememberForSubmission(key, input, { onlyIfNew: true, draftRevision });
	signal.throwIfAborted();
	onAdmitted(input);
	await local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const { initialSend: task } = currentInitialSend(local, expected);
		const stored = local.storedPending(key);
		if (!stored || JSON.stringify(stored.input) !== JSON.stringify(input)) throw new Error("SUBMISSION_OWNER_CHANGED");
		const source = local.storedValue(task.sourceKey);
		const localSource = local.valueSnapshot(task.sourceKey);
		if (
			task.sourceRevision &&
			source?.revision === task.sourceRevision &&
			source.value === task.text &&
			localSource?.revision === source.revision &&
			localSource.value === source.value
		)
			local.persistValue({ ...source, value: "", revision: crypto.randomUUID() });
		local.persistValue({ kind: "value", key: recoveryKey, value: JSON.stringify({ version: 2, request: null }) });
	});
	return { input, newlyAdmitted };
}
