import type { AppClient, Receipt, Submit } from "@hipi/work-runtime/contracts";
import { readCatalogRecovery } from "./catalog/prepared-task.ts";
import type { LocalState } from "./local-state.ts";

function assertPrerequisitesReleased(local: LocalState, input: Submit) {
	const saved = readCatalogRecovery(local.storedValue("command.catalog")?.value ?? null);
	if (
		saved.incompatible ||
		(saved.initialSend?.context &&
			(saved.initialSend.submissionId === input.requestId ||
				(saved.initialSend.conversationCommand.params.workspaceId === input.workspaceId &&
					(saved.initialSend.conversationId === null || saved.initialSend.conversationId === input.conversationId))))
	)
		throw new Error("INITIAL_CONTEXT_PREREQUISITE_REQUIRED");
}

/** Shared submission boundary: preserve exact ownership before dispatch, including explicit retries. */
export async function submitRequest(
	client: AppClient,
	local: LocalState,
	input: Submit,
	signal: AbortSignal,
	onAdmitted?: () => void,
): Promise<Receipt> {
	const captured = { ...input };
	const key = `${captured.workspaceId}.${captured.conversationId}`;
	assertPrerequisitesReleased(local, captured);
	await local.rememberForSubmission(key, captured);
	signal.throwIfAborted();
	onAdmitted?.();
	const stored = local.storedPending(key);
	if (!stored || JSON.stringify(stored.input) !== JSON.stringify(captured)) throw new Error("SUBMISSION_OWNER_CHANGED");
	assertPrerequisitesReleased(local, captured);
	signal.throwIfAborted();
	return client.call("submit", captured, signal);
}
