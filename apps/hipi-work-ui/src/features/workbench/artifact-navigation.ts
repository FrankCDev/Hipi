import type { Scope, ToolActivity } from "@hipi/work-runtime/contracts";
import type { FileWorkspaceSession } from "../files/file-workspace-session.ts";
import type { FilePanelController } from "./file-panel-controller.ts";

/** A stale activity callback cannot open a file in a later conversation's workspace. */
export function artifactNavigation(
	scope: Scope,
	current: () => Scope,
	editor: Pick<FileWorkspaceSession, "openArtifact">,
	panel: Pick<FilePanelController, "setOpen">,
) {
	const captured = { ...scope };
	return (artifact: NonNullable<ToolActivity["artifact"]>) => {
		const reference = { ...artifact };
		const selected = current();
		if (selected.workspaceId !== captured.workspaceId || selected.conversationId !== captured.conversationId) return;
		panel.setOpen(true);
		void editor.openArtifact(
			{ workspaceId: captured.workspaceId, rootId: reference.rootId, path: reference.path },
			{
				operationId: reference.operationId,
				...(reference.expectedRevision ? { expectedRevision: reference.expectedRevision } : {}),
			},
		);
	};
}
