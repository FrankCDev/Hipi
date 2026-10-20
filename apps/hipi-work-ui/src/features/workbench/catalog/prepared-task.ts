import { LIMITS } from "@hipi/work-runtime/contracts";
import type { CatalogCommand, LegacyCatalogCommand } from "../command-recovery.ts";
import type { SavedValue } from "../local-persistence.ts";
import type { LocalState } from "../local-state.ts";
import { parseProjectCommand } from "../projects/commands.ts";
import { parseStoredRequest } from "../recovery/stored-request.ts";
import { type InitialSend, readInitialSendRecovery } from "./initial-send.ts";

export type PreparedTask = {
	workspaceId: string;
	requestId: string;
	text: string;
	sourceRevision: string | null;
	conversationId: string | null;
};
export type CatalogRecoveryRecord = {
	request: CatalogCommand | null;
	preparedTask: PreparedTask | null;
	initialSend: InitialSend | null;
	incompatible: boolean;
};
const id = /^[a-zA-Z0-9_-]{1,128}$/;
const recoveryKey = "command.catalog";

function catalogCommand(value: unknown): LegacyCatalogCommand {
	const command = parseStoredRequest(value);
	if (
		command.expectedStoreId !== undefined ||
		(command.method !== "createWorkspace" &&
			command.method !== "createConversation" &&
			command.method !== "renameConversation" &&
			command.method !== "archiveConversation" &&
			command.method !== "restoreConversation")
	)
		throw new Error("INVALID_CATALOG_RECOVERY");
	return command;
}

/** Prepared input belongs to the same immutable catalog recovery record, never to a UI lifetime. */
export function readCatalogRecovery(raw: string | null): CatalogRecoveryRecord {
	if (raw === null) return { request: null, preparedTask: null, initialSend: null, incompatible: false };
	try {
		if (raw.length > 30000) throw new Error("INVALID_CATALOG_RECOVERY");
		const saved: unknown = JSON.parse(raw);
		if (
			saved &&
			typeof saved === "object" &&
			"version" in saved &&
			saved.version === 6 &&
			"kind" in saved &&
			saved.kind === "project-command"
		) {
			if (Object.keys(saved).some((key) => !["version", "kind", "request"].includes(key)) || !("request" in saved))
				throw new Error("INVALID_CATALOG_RECOVERY");
			return {
				request: parseProjectCommand(saved.request),
				preparedTask: null,
				initialSend: null,
				incompatible: false,
			};
		}
		if (
			saved &&
			typeof saved === "object" &&
			"version" in saved &&
			(saved.version === 3 || saved.version === 4 || saved.version === 5 || saved.version === 6)
		)
			return { ...readInitialSendRecovery(saved), preparedTask: null, incompatible: false };
		if (
			!saved ||
			typeof saved !== "object" ||
			!("version" in saved) ||
			saved.version !== 2 ||
			!("request" in saved) ||
			Object.keys(saved).some((key) => !["version", "request", "preparedTask"].includes(key))
		)
			throw new Error("INVALID_CATALOG_RECOVERY");
		const request = saved.request === null ? null : catalogCommand(saved.request);
		if (!("preparedTask" in saved)) return { request, preparedTask: null, initialSend: null, incompatible: false };
		const task = saved.preparedTask;
		if (
			request?.method !== "createConversation" ||
			!task ||
			typeof task !== "object" ||
			Object.keys(task).some(
				(key) => !["workspaceId", "requestId", "text", "sourceRevision", "conversationId"].includes(key),
			) ||
			!("workspaceId" in task) ||
			task.workspaceId !== request.params.workspaceId ||
			!("requestId" in task) ||
			task.requestId !== request.params.requestId ||
			!("text" in task) ||
			typeof task.text !== "string" ||
			task.text.length > LIMITS.text ||
			!("sourceRevision" in task) ||
			(task.sourceRevision !== null && (typeof task.sourceRevision !== "string" || !id.test(task.sourceRevision))) ||
			!("conversationId" in task) ||
			(task.conversationId !== null && (typeof task.conversationId !== "string" || !id.test(task.conversationId)))
		)
			throw new Error("INVALID_PREPARED_TASK");
		return {
			request,
			preparedTask: {
				workspaceId: request.params.workspaceId,
				requestId: request.params.requestId,
				text: task.text,
				sourceRevision: task.sourceRevision,
				conversationId: task.conversationId,
			},
			initialSend: null,
			incompatible: false,
		};
	} catch {
		return { request: null, preparedTask: null, initialSend: null, incompatible: true };
	}
}

function saveRecovery(local: LocalState, request: CatalogCommand | null, preparedTask: PreparedTask | null) {
	local.persistValue({
		kind: "value",
		key: recoveryKey,
		value: JSON.stringify({ version: 2, request, ...(preparedTask ? { preparedTask } : {}) }),
	});
}

export function currentCatalogRecovery(local: LocalState, command: CatalogCommand): CatalogRecoveryRecord {
	const saved = readCatalogRecovery(local.storedValue(recoveryKey)?.value ?? null);
	if (saved.incompatible || !saved.request || JSON.stringify(saved.request) !== JSON.stringify(command))
		throw new Error("CATALOG_RECOVERY_MISMATCH");
	return saved;
}

export function admitCatalog(
	local: LocalState,
	input: LegacyCatalogCommand,
	text: string | undefined,
	signal: AbortSignal,
): Promise<CatalogRecoveryRecord> {
	const command = catalogCommand(input);
	if (
		text !== undefined &&
		(command.method !== "createConversation" || typeof text !== "string" || text.length > LIMITS.text)
	)
		return Promise.reject(new Error("INVALID_PREPARED_TASK"));
	const source = local.valueSnapshot(`task-draft.${command.params.workspaceId}`);
	const preparedTask: PreparedTask | null =
		command.method === "createConversation" && text !== undefined
			? {
					workspaceId: command.params.workspaceId,
					requestId: command.params.requestId,
					text,
					sourceRevision: source?.value === text ? (source.revision ?? null) : null,
					conversationId: null,
				}
			: null;
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const previous = readCatalogRecovery(local.storedValue(recoveryKey)?.value ?? null);
		if (previous.incompatible || previous.request || previous.initialSend) throw new Error("CATALOG_RECOVERY_EXISTS");
		// One atomic storage write must contain both command and captured prompt before any dispatch.
		saveRecovery(local, command, preparedTask);
		return { request: command, preparedTask, initialSend: null, incompatible: false };
	});
}

function sameValue(left: SavedValue | null, right: SavedValue | null): boolean {
	return (left?.value ?? "") === (right?.value ?? "") && left?.revision === right?.revision;
}

/** Called only after CatalogSession verifies the exact command receipt and current target. */
export function finishCatalog(
	local: LocalState,
	command: LegacyCatalogCommand,
	conversationId: string | null,
	signal: AbortSignal,
	discardPreparedTask = false,
): Promise<{ preparedTask: PreparedTask | null; handoffConflict: boolean }> {
	return local.withAdmission(recoveryKey, () => {
		signal.throwIfAborted();
		const saved = currentCatalogRecovery(local, command);
		if (saved.initialSend) throw new Error("INITIAL_SEND_REQUIRES_OWNERSHIP_TRANSFER");
		let task = saved.preparedTask;
		if (task) {
			if (!conversationId || (task.conversationId !== null && task.conversationId !== conversationId))
				throw new Error("PREPARED_TARGET_MISMATCH");
			if (task.conversationId === null) {
				task = { ...task, conversationId };
				saveRecovery(local, command, task);
			}
			if (!discardPreparedTask) {
				const destinationKey = `draft.${task.workspaceId}.${conversationId}`;
				const storedDestination = local.storedValue(destinationKey);
				const localDestination = local.valueSnapshot(destinationKey);
				// The provenance marker survives edits, so a crash after transfer never re-inserts input.
				if (storedDestination?.handoffRequestId !== task.requestId) {
					if (storedDestination?.value || localDestination?.value || !sameValue(storedDestination, localDestination))
						return { preparedTask: task, handoffConflict: true };
					local.persistValue({
						kind: "value",
						key: destinationKey,
						value: task.text,
						revision: crypto.randomUUID(),
						handoffRequestId: task.requestId,
					});
				}
				const sourceKey = `task-draft.${task.workspaceId}`;
				const storedSource = local.storedValue(sourceKey);
				const localSource = local.valueSnapshot(sourceKey);
				if (
					task.sourceRevision &&
					storedSource?.revision === task.sourceRevision &&
					storedSource.value === task.text &&
					sameValue(storedSource, localSource)
				) {
					local.persistValue({ ...storedSource, value: "", revision: crypto.randomUUID() });
				}
			}
		}
		// No clear before the destination and any unchanged source clear are durable.
		saveRecovery(local, null, null);
		return { preparedTask: null, handoffConflict: false };
	});
}
