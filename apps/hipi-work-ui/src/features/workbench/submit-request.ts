import type { AppClient, Receipt, Submit } from "@hipi/work-runtime/contracts";
import type { LocalState } from "./local-state.ts";

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
	await local.rememberForSubmission(key, captured);
	signal.throwIfAborted();
	onAdmitted?.();
	const stored = local.storedPending(key);
	if (!stored || JSON.stringify(stored.input) !== JSON.stringify(captured)) throw new Error("SUBMISSION_OWNER_CHANGED");
	signal.throwIfAborted();
	return client.call("submit", captured, signal);
}
