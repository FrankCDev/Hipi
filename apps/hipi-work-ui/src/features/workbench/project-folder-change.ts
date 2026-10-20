import type { FileWorkspaceSession } from "../files/file-workspace-session.ts";

/** Captures exactly the buffers the user reviewed; a later edit cannot inherit a discard decision. */
export function prepareProjectFolderChange(
	session: FileWorkspaceSession | undefined,
	workspaceId: string,
	rootId: string | undefined,
) {
	const affected = () =>
		(session?.snapshot().tabs ?? []).filter(
			(tab) => tab.target.workspaceId === workspaceId && tab.target.rootId === rootId,
		);
	const reviewed = new Map(
		affected().flatMap((tab) =>
			tab.kind === "editor" && tab.editor.protected ? [[tab.editor, tab.editor.snapshot()] as const] : [],
		),
	);
	const unchanged = () =>
		affected().every(
			(tab) => tab.kind !== "editor" || !tab.editor.protected || reviewed.get(tab.editor) === tab.editor.snapshot(),
		);
	return {
		paths: affected()
			.filter((tab) => tab.kind === "editor" && tab.editor.protected)
			.map((tab) => tab.target.path),
		unchanged,
		/** Call only after a confirmed folder change. Cancellation and unknown results retain buffers. */
		discardReviewed() {
			if (!unchanged()) return false;
			session?.discard(affected().map((tab) => tab.id));
			return true;
		},
	};
}
