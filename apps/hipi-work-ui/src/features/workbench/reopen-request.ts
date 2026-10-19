import type { AppClient, Conversation, Scope, Workspace } from "@hipi/work-runtime/contracts";

/** Owns one dialog's read-only lookup, including transports that settle after abort. */
export class ReopenRequest {
	private active: AbortController | undefined;

	cancel() {
		const active = this.active;
		this.active = undefined;
		active?.abort();
	}

	begin(client: AppClient, scope: Scope, onOpen: (workspace: Workspace, conversation: Conversation) => void) {
		if (this.active) return undefined;
		const workspaceId = scope.workspaceId.trim();
		const conversationId = scope.conversationId.trim();
		if (!workspaceId || !conversationId) return undefined;
		const controller = new AbortController();
		this.active = controller;
		const current = () => this.active === controller && !controller.signal.aborted;
		return async () => {
			try {
				if (!current()) return;
				const workspace = await client.call("getWorkspace", { workspaceId }, controller.signal);
				if (!current()) return;
				const conversation = await client.call(
					"getConversation",
					{ workspaceId: workspace.workspaceId, conversationId },
					controller.signal,
				);
				if (!current()) return;
				if (
					workspace.workspaceId !== workspaceId ||
					conversation.workspaceId !== workspaceId ||
					conversation.conversationId !== conversationId
				)
					throw new Error("Scope mismatch");
				onOpen(workspace, conversation);
			} catch (error) {
				if (current()) throw error;
			} finally {
				if (this.active === controller) this.active = undefined;
			}
		};
	}
}
