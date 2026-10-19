import type { ReceiptView, Submit } from "@hipi/work-runtime/contracts";
import { type LocalState, reconciledDraft } from "./local-state.ts";

/** A foreign receipt must not clear a draft or mark its pending request as confirmed. */
export function reconcileReceipt(
	local: LocalState,
	localKey: string,
	draft: string,
	pending: Submit,
	receipt: ReceiptView,
): string | null {
	if (
		receipt.state === "reconciliation_required" ||
		receipt.requestId !== pending.requestId ||
		receipt.workspaceId !== pending.workspaceId ||
		receipt.conversationId !== pending.conversationId
	)
		return null;
	const next = reconciledDraft(draft, pending, receipt);
	if (next !== draft) local.clearDraft(`draft.${localKey}`, pending.text);
	local.confirmed(receipt.requestId);
	return next;
}
