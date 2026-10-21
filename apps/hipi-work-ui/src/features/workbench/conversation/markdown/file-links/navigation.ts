import { FILE_LIMITS, FileServiceError, type ProjectFolder } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type { FileAuthority } from "../../../../../app/file-client.ts";
import type { FileWorkspaceSession } from "../../../../files/file-workspace-session.ts";
import type { FilePanelController } from "../../../files/panel-controller.ts";
import { projectFilePath } from "./path.ts";

type AvailableFolder = Extract<ProjectFolder, { status: "available" }>;
export type ProjectFileNavigation = {
	folder: AvailableFolder;
	files: FileClient;
	getProject: NonNullable<FileAuthority["getProject"]>;
	session: Pick<FileWorkspaceSession, "open" | "openPreview">;
	panel: Pick<FilePanelController, "setOpen">;
	previews: boolean;
	isCurrent: () => boolean;
};

function sameBinding(expected: AvailableFolder, current: ProjectFolder) {
	return (
		current.status === "available" &&
		current.workspaceId === expected.workspaceId &&
		current.bindingId === expected.bindingId &&
		current.revision === expected.revision &&
		current.root.workspaceId === expected.workspaceId &&
		current.root.rootId === expected.root.rootId
	);
}

/** No picker, grants, Agent context, absolute-path inference or external URL opener lives here. */
export async function openProjectFile(owner: ProjectFileNavigation, destination: string, signal: AbortSignal) {
	const path = projectFilePath(destination);
	if (!path) throw new FileServiceError("INVALID_PATH");
	const current = () => owner.isCurrent() && !signal.aborted;
	const check = () => {
		if (!current()) throw new FileServiceError("CLOSED");
	};
	check();
	const { folder, files } = owner;
	if (!sameBinding(folder, await owner.getProject(folder.workspaceId))) throw new FileServiceError("UNAUTHORIZED");
	check();
	const roots = await files.listRoots(folder.workspaceId, signal);
	check();
	if (!roots.some((root) => root.workspaceId === folder.workspaceId && root.rootId === folder.root.rootId))
		throw new FileServiceError("UNAUTHORIZED");
	const target = { workspaceId: folder.workspaceId, rootId: folder.root.rootId, path };
	// Validate existence and reject blocked/symlink entries even when an editor tab
	// already exists. This reads only the bounded parent directory's metadata.
	const parent = { ...target, path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
	let cursor: string | undefined;
	let found = false;
	let exhausted = false;
	for (let page = 0; page < Math.ceil(FILE_LIMITS.directoryEntries / FILE_LIMITS.page); page++) {
		const entries = await files.list(parent, cursor, signal);
		check();
		const entry = entries.entries.find((entry) => entry.path === path);
		if (entry) {
			if (entry.kind !== "file") throw new FileServiceError("BLOCKED_RESOURCE");
			found = true;
			break;
		}
		if (!entries.nextCursor) {
			exhausted = true;
			break;
		}
		cursor = entries.nextCursor;
	}
	if (!found) throw new FileServiceError(exhausted ? "NOT_FOUND" : "LIMIT_EXCEEDED");
	// A rebind while listing must not redirect this click to a different root.
	if (!sameBinding(folder, await owner.getProject(folder.workspaceId))) throw new FileServiceError("UNAUTHORIZED");
	check();
	owner.panel.setOpen(true);
	// Filename selects only presentation. The preview service still validates the
	// file's kind, size and current authority; bytes never become a browser URL.
	if (owner.previews && /\.(?:docx|xlsx|csv|pdf|png|jpe?g)$/iu.test(path)) await owner.session.openPreview(target);
	else await owner.session.open(target);
}
