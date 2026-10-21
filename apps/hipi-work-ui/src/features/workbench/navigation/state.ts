import type { Scope } from "@hipi/work-runtime/contracts";
import { createStore } from "zustand/vanilla";
import type { SidebarLocation } from "../sidebar/selection-owner.ts";

type Preferences = { read(key: string): string | null; write(key: string, value: string): boolean };
type NavigationState = Readonly<{
	scope: Readonly<Scope>;
	// Undefined means legacy membership has not been resolved; null is explicitly projectless.
	projectId: string | null | undefined;
	sidebarLocation: SidebarLocation | null;
	revision: number;
	newChatLookup: Readonly<{ revision: number; failed: boolean }> | null;
}>;

/** Created within the connection subtree. Query entities and execution state never enter this store. */
export function createNavigation(preferences: Preferences) {
	const workspaceId = preferences.read("workspace") ?? "";
	const savedProject = preferences.read("project");
	const state = createStore<NavigationState>(() => ({
		scope: { workspaceId, conversationId: preferences.read("conversation") ?? "" },
		projectId: savedProject === null && workspaceId ? undefined : savedProject || null,
		sidebarLocation: null,
		revision: 0,
		newChatLookup: null,
	}));
	const persist = (scope: Scope, projectId: string | null) => {
		preferences.write("workspace", scope.workspaceId);
		preferences.write("conversation", scope.conversationId);
		preferences.write("project", projectId ?? "");
	};
	return {
		store: { getState: state.getState, getInitialState: state.getInitialState, subscribe: state.subscribe },
		selectHome(workspaceId: string, projectId: string | null) {
			const scope = { workspaceId, conversationId: "" };
			persist(scope, projectId);
			state.setState({
				scope,
				projectId,
				sidebarLocation: null,
				newChatLookup: null,
				revision: state.getState().revision + 1,
			});
		},
		selectConversation(scope: Scope, location: SidebarLocation | null): "alias" | "route" {
			const current = state.getState();
			const sidebarLocation = location ? { ...location } : null;
			if (
				location &&
				current.scope.workspaceId === scope.workspaceId &&
				current.scope.conversationId === scope.conversationId
			) {
				// A sidebar alias changes presentation intent without replacing the route or writing preferences.
				state.setState({ sidebarLocation, newChatLookup: null, revision: current.revision + 1 });
				return "alias";
			}
			const selected = { workspaceId: scope.workspaceId, conversationId: scope.conversationId };
			persist(selected, null);
			state.setState({
				scope: selected,
				projectId: null,
				sidebarLocation,
				newChatLookup: null,
				revision: current.revision + 1,
			});
			return "route";
		},
		resolveProject(workspaceId: string, projectId: string) {
			const current = state.getState();
			if (current.scope.workspaceId !== workspaceId || current.scope.conversationId || current.projectId) return;
			preferences.write("project", projectId);
			state.setState({ projectId });
		},
		clearSidebarLocation() {
			if (state.getState().sidebarLocation !== null) state.setState({ sidebarLocation: null });
		},
		beginNewChat() {
			const revision = state.getState().revision + 1;
			state.setState({ revision, newChatLookup: { revision, failed: false } });
			return revision;
		},
		failNewChat(revision: number) {
			if (state.getState().revision === revision) state.setState({ newChatLookup: { revision, failed: true } });
		},
	};
}
export type Navigation = ReturnType<typeof createNavigation>;
