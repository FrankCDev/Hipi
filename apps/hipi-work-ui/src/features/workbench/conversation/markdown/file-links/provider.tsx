import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { useFiles } from "../../../../../app/client-provider.tsx";
import type { FileWorkspaceSession } from "../../../../files/file-workspace-session.ts";
import type { FilePanelController } from "../../../files/panel-controller.ts";
import type { Navigation } from "../../../navigation/state.ts";
import { useProjectFolder } from "../../../projects/use-folder.ts";
import { openProjectFile } from "./navigation.ts";

export type ProjectFileLinks = { open: (path: string, signal: AbortSignal) => Promise<void> };
const Context = createContext<ProjectFileLinks | undefined>(undefined);
export const ProjectFileLinkCapability = Context.Provider;
export const useProjectFileLinks = () => useContext(Context);

/** Only conversation composition injects this authority; IDE Markdown previews stay inert. */
export function ProjectFileLinksProvider({
	workspaceId,
	session,
	panel,
	navigation,
	connected,
	children,
}: {
	workspaceId: string;
	session: FileWorkspaceSession | undefined;
	panel: FilePanelController;
	navigation: Navigation;
	connected: () => boolean;
	children: ReactNode;
}) {
	const { files, fileAuthority, previews } = useFiles();
	const project = useProjectFolder(workspaceId, !!session);
	const folder = project.data;
	const revision = navigation.store.getState().revision;
	const alive = useRef(false);
	const current = useRef({ folder, session, files, fileAuthority, revision, connected });
	current.current = { folder, session, files, fileAuthority, revision, connected };
	useLayoutEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const capability = useMemo(() => {
		const getProject = fileAuthority?.getProject;
		if (!files || !session || !getProject || folder?.status !== "available" || folder.workspaceId !== workspaceId)
			return undefined;
		const owner = {
			folder,
			files,
			getProject,
			session,
			panel,
			previews: !!previews,
			isCurrent: () =>
				alive.current &&
				current.current.connected() &&
				current.current.folder === folder &&
				current.current.session === session &&
				current.current.files === files &&
				current.current.fileAuthority === fileAuthority &&
				current.current.revision === revision &&
				navigation.store.getState().revision === revision &&
				navigation.store.getState().scope.workspaceId === workspaceId,
		};
		return { open: (path: string, signal: AbortSignal) => openProjectFile(owner, path, signal) };
	}, [folder, files, fileAuthority, session, panel, previews, navigation, revision, workspaceId]);
	return <Context.Provider value={capability}>{children}</Context.Provider>;
}
