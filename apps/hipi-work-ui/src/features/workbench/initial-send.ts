import { LIMITS, type ModelReference, PROTOCOL_VERSION, parseRequest, type Submit } from "@hipi/work-runtime/contracts";
import type { CatalogCommand } from "./command-recovery.ts";
import type { LocalState } from "./local-state.ts";

type WorkspaceCommand = Extract<CatalogCommand, { method: "createWorkspace" }>;
type ConversationCommand = Extract<CatalogCommand, { method: "createConversation" }>;
export type InitialSendInput = {
	workspaceId: string | null;
	text: string;
	title: string;
	model?: ModelReference;
	sourceKey: string;
};
/** Authorization to finish one captured Send, not an independently persisted execution status. */
export type InitialSend = {
	workspaceCommand: WorkspaceCommand | null;
	conversationCommand: ConversationCommand;
	text: string;
	submissionId: string;
	sourceKey: string;
	sourceRevision: string | null;
	conversationId: string | null;
};
export type InitialSendRecovery = { request: CatalogCommand | null; initialSend: InitialSend };
const id = /^[a-zA-Z0-9_-]{1,128}$/;
const recoveryKey = "command.catalog";
const defaultKey = "default-chat-workspace";

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
	const command = parseRequest(value);
	if (command.expectedStoreId !== undefined || command.method !== "createWorkspace" || command.params.name !== "Chats")
		throw new Error("INVALID_DEFAULT_WORKSPACE");
	return command;
}
/** Presentation may hide only this verified store-scoped default identity, never a matching name. */
export function defaultChatWorkspaceId(local: LocalState): string | null {
	try {
		const raw = local.read(defaultKey);
		return raw ? workspaceCommand(JSON.parse(raw)).params.workspaceId : null;
	} catch {
		return null;
	}
}
function conversationCommand(value: unknown): ConversationCommand {
	const command = parseRequest(value);
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
		saved.version !== 3 ||
		Object.keys(saved).some((key) => !["version", "request", "initialSend"].includes(key)) ||
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
				].includes(key),
		) ||
		typeof task.text !== "string" ||
		!task.text.trim() ||
		task.text.length > LIMITS.text
	)
		throw new Error("INVALID_INITIAL_SEND");
	const conversation = conversationCommand(task.conversationCommand);
	const workspace = task.workspaceCommand === null ? null : workspaceCommand(task.workspaceCommand);
	if (workspace && workspace.params.workspaceId !== conversation.params.workspaceId)
		throw new Error("INITIAL_SEND_SCOPE_MISMATCH");
	const initialSend: InitialSend = {
		workspaceCommand: workspace,
		conversationCommand: conversation,
		text: task.text,
		submissionId: identifier(task.submissionId),
		sourceKey: sourceKey(task.sourceKey, conversation.params.workspaceId),
		sourceRevision: nullableIdentifier(task.sourceRevision),
		conversationId: nullableIdentifier(task.conversationId),
	};
	const request = saved.request === null ? null : parseRequest(saved.request);
	if (
		(request === null && initialSend.conversationId === null) ||
		(request !== null &&
			(request.expectedStoreId !== undefined ||
				(request.method !== "createWorkspace" && request.method !== "createConversation") ||
				JSON.stringify(request) !== JSON.stringify(request.method === "createWorkspace" ? workspace : conversation))) ||
		(request !== null && initialSend.conversationId !== null)
	)
		throw new Error("INITIAL_SEND_COMMAND_MISMATCH");
	return { request, initialSend };
}
function save(local: LocalState, record: InitialSendRecovery) {
	local.persistValue({ kind: "value", key: recoveryKey, value: JSON.stringify({ version: 3, ...record }) });
}
export function currentInitialSend(local: LocalState, expected: InitialSendRecovery): InitialSendRecovery {
	const raw = local.storedValue(recoveryKey)?.value;
	if (!raw) throw new Error("INITIAL_SEND_OWNER_CHANGED");
	const saved = readInitialSendRecovery(JSON.parse(raw));
	if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error("INITIAL_SEND_OWNER_CHANGED");
	return saved;
}
export function admitInitialSend(local: LocalState, input: InitialSendInput, signal: AbortSignal) {
	const captured = structuredClone(input);
	// Admission may wait behind another tab. Only the draft present at Send belongs to this request.
	const source = local.valueSnapshot(captured.sourceKey);
	const sourceRevision = source?.value === captured.text ? (source.revision ?? null) : null;
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const previous = local.storedValue(recoveryKey)?.value;
		if (previous && previous !== JSON.stringify({ version: 2, request: null }))
			throw new Error("CATALOG_RECOVERY_EXISTS");
		let workspace: WorkspaceCommand | null = null;
		let createWorkspace = false;
		if (captured.workspaceId === null) {
			const existing = local.storedValue(defaultKey)?.value;
			if (existing) workspace = workspaceCommand(JSON.parse(existing));
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
		const key = sourceKey(captured.sourceKey, workspaceId);
		if (captured.workspaceId === null && key !== "chat-draft.global") throw new Error("INVALID_INITIAL_SEND_SOURCE");
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
			version: 3,
			request: createWorkspace ? workspace : conversation,
			initialSend: {
				workspaceCommand: workspace,
				conversationCommand: conversation,
				text: captured.text,
				submissionId: crypto.randomUUID(),
				sourceKey: key,
				sourceRevision,
				conversationId: null,
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
		const mapping = JSON.stringify(saved.initialSend.workspaceCommand);
		const existing = local.storedValue(defaultKey)?.value;
		if (existing && existing !== mapping) throw new Error("DEFAULT_WORKSPACE_CHANGED");
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
/** The only execution recovery owner is the existing per-conversation pending Submit record. */
export async function transferInitialSubmission(
	local: LocalState,
	expected: InitialSendRecovery,
	signal: AbortSignal,
	onAdmitted: (input: Submit) => void,
): Promise<{ input: Submit; newlyAdmitted: boolean }> {
	const { input, draftRevision } = await local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const { initialSend: task, request } = currentInitialSend(local, expected);
		if (request || !task.conversationId) throw new Error("INITIAL_SEND_TARGET_UNVERIFIED");
		const input: Submit = {
			workspaceId: task.conversationCommand.params.workspaceId,
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
