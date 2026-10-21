import type { Conversation } from "@hipi/work-runtime/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { LegacyCatalogCommand } from "../command-recovery.ts";
import type { CatalogSession } from "./session.ts";

/** The catalog owns persistence/reconciliation. Both title surfaces only publish confirmed current reads. */
export async function executeConversationCommand(
	session: CatalogSession,
	cache: QueryClient,
	command: LegacyCatalogCommand,
	presentation: boolean,
): Promise<Conversation | undefined> {
	const previous = session.getSnapshot();
	if (previous.busy || previous.pending || previous.initialSend || previous.incompatible) return;
	await session.execute(command);
	const state = session.getSnapshot();
	if (state === previous || state.pending || state.failed || state.resultMethod !== command.method) return;
	const result = state.result;
	if (
		!result ||
		!("conversationId" in result) ||
		result.workspaceId !== command.params.workspaceId ||
		!("conversationId" in command.params) ||
		result.conversationId !== command.params.conversationId
	)
		return;
	cache.setQueryData(["conversation", result.workspaceId, result.conversationId], result);
	void cache.invalidateQueries({ queryKey: ["conversations", result.workspaceId] });
	if (presentation) {
		void cache.invalidateQueries({ queryKey: ["pinned-conversations"] });
		void cache.invalidateQueries({
			queryKey: ["conversation-presentation", result.workspaceId, result.conversationId],
		});
	}
	return result;
}
