import type {
	AppClient,
	Conversation,
	ConversationSearchHit,
	Project,
	ProjectListItem,
} from "@hipi/work-runtime/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { FileWorkspaceSession } from "../../files/file-workspace-session.ts";
import type { SearchHistoryAnchor } from "../conversation/history-controller.ts";
import { prepareSearchNavigation } from "../conversation/history-reads.ts";
import type { SidebarLocation } from "../sidebar/selection-owner.ts";
import type { Navigation } from "./state.ts";

type Options = {
	navigation: Navigation;
	client: AppClient;
	cache: QueryClient;
	isConnected: () => boolean;
	cancelDraft: () => void;
	session?: Pick<FileWorkspaceSession, "setWorkspace">;
	projects: readonly ProjectListItem[];
	currentProjectId: string | null | undefined;
	currentProject?: Project;
	onHome: (workspaceId: string, projectId: string | null) => void;
	onConversation: (workspaceId: string) => void;
	onSearch: (anchor: SearchHistoryAnchor | undefined) => void;
};

/** Navigation I/O stays outside the store; every delayed result retains its original connection and intent. */
export function useNavigationActions({
	navigation,
	client,
	cache,
	isConnected,
	cancelDraft,
	session,
	projects,
	currentProjectId,
	currentProject,
	onHome,
	onConversation,
	onSearch,
}: Options) {
	const selectHome = useCallback(
		(workspaceId: string, projectId: string | null) => {
			if (!isConnected()) return;
			cancelDraft();
			session?.setWorkspace(workspaceId);
			navigation.selectHome(workspaceId, projectId);
			onHome(workspaceId, projectId);
		},
		[navigation, isConnected, cancelDraft, session, onHome],
	);
	const selectWorkspace = (workspaceId: string) =>
		selectHome(
			workspaceId,
			projects.find((item) => item.project.homeWorkspaceId === workspaceId)?.project.projectId ?? null,
		);
	const selectKnownProject = (project: Project) => {
		if (!isConnected()) return;
		cache.setQueryData(["project", project.projectId], project);
		selectHome(project.homeWorkspaceId, project.projectId);
	};
	const selectProject = (id: string) => {
		const project =
			projects.find((item) => item.project.projectId === id)?.project ??
			(currentProject?.projectId === id ? currentProject : undefined);
		if (project) selectKnownProject(project);
	};
	const selectConversation = (item: Conversation, onSelected?: () => void, location: SidebarLocation | null = null) => {
		if (!isConnected()) return;
		cancelDraft();
		if (navigation.selectConversation(item, location) === "alias") return;
		cache.setQueryData(["conversation", item.workspaceId, item.conversationId], item);
		session?.setWorkspace(item.workspaceId);
		onConversation(item.workspaceId);
		onSelected?.();
	};
	const openNewConversation = async (requestedProjectId?: string | null) => {
		if (!isConnected()) return;
		cancelDraft();
		const origin = navigation.beginNewChat();
		const scope = navigation.store.getState().scope;
		const current = () => isConnected() && navigation.store.getState().revision === origin;
		try {
			let projectId = requestedProjectId !== undefined ? requestedProjectId : currentProjectId;
			if (projectId === undefined) {
				if (!scope.workspaceId || !scope.conversationId) throw new Error("PROJECT_DESTINATION_UNVERIFIED");
				const membership = await cache.fetchQuery({
					queryKey: ["conversation-membership", scope.workspaceId, scope.conversationId],
					queryFn: ({ signal }) => client.call("getConversationMembership", scope, signal),
					retry: false,
				});
				if (!current()) return;
				if (membership.workspaceId !== scope.workspaceId || membership.conversationId !== scope.conversationId)
					throw new Error("PROJECT_DESTINATION_UNVERIFIED");
				projectId = membership.projectId;
			}
			if (projectId === null) {
				selectHome("", null);
				return;
			}
			const project =
				projects.find((item) => item.project.projectId === projectId)?.project ??
				(currentProject?.projectId === projectId ? currentProject : undefined) ??
				(await cache.fetchQuery({
					queryKey: ["project", projectId],
					queryFn: ({ signal }) => client.call("getProject", { projectId }, signal),
					retry: false,
				}));
			if (!current()) return;
			if (!project || project.projectId !== projectId) throw new Error("PROJECT_DESTINATION_UNVERIFIED");
			selectKnownProject(project);
		} catch {
			if (current()) navigation.failNewChat(origin);
		}
	};
	const activateSearch = async (hit: ConversationSearchHit, signal: AbortSignal) => {
		if (!isConnected()) return false;
		const origin = navigation.store.getState().revision;
		const result = await prepareSearchNavigation(client, hit, signal);
		if (signal.aborted || !isConnected() || navigation.store.getState().revision !== origin) return false;
		selectConversation(result.conversation);
		onSearch(result.anchor);
		return true;
	};
	return {
		selectWorkspace,
		selectKnownProject,
		selectProject,
		selectConversation,
		openNewConversation,
		activateSearch,
	};
}
