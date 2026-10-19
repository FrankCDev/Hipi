import type { Scope, ToolActivity } from "@hipi/work-runtime/contracts";
import type { EditorSession } from "../files/editor-session.ts";
import type { FilePanelController } from "./file-panel-controller.ts";

/** Guard callbacks can outlive selection. Recheck scope after the user decides to leave dirty input. */
export function artifactNavigation(
	scope: Scope,
	current: () => Scope,
	guard: (action: () => void) => void,
	editor: Pick<EditorSession, "clear" | "openArtifact">,
	panel: Pick<FilePanelController, "setOpen">,
) {
	const captured = { ...scope };
	return (artifact: NonNullable<ToolActivity["artifact"]>) => {
		const reference = { ...artifact };
		guard(() => {
			const selected = current();
			if (selected.workspaceId !== captured.workspaceId || selected.conversationId !== captured.conversationId) return;
			editor.clear();
			panel.setOpen(true);
			void editor.openArtifact(
				{ workspaceId: captured.workspaceId, rootId: reference.rootId, path: reference.path },
				{
					operationId: reference.operationId,
					...(reference.expectedRevision ? { expectedRevision: reference.expectedRevision } : {}),
				},
			);
		});
	};
}
