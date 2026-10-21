import {
	AppError,
	type Conversation,
	type ConversationSearchHit,
	type ModelReference,
	PROTOCOL_VERSION,
	type Project,
	type ProjectListItem,
	type ProjectPage,
	type Workspace,
} from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings, SquarePen } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient, useFiles, useLocalState } from "../../app/client-provider.tsx";
import type { ProjectFolderSelection } from "../../app/file-client.ts";
import { type AppKeybindings, DEFAULT_APP_KEYBINDINGS, matchesBinding } from "../../app/keybindings.ts";
import { usePreferences } from "../../app/preferences.tsx";
import { BrandMark } from "../../components/brand-mark.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { fileLabels } from "../files/file-labels.ts";
import { FileWorkspaceSession } from "../files/file-workspace-session.ts";
import { SettingsDialog } from "../settings/index.ts";
import { ToolPacksDialog } from "../tool-packs/index.ts";
import { CatalogRecovery, ConversationActions } from "./catalog/controls.tsx";
import { CreateDialog } from "./catalog/create-dialog.tsx";
import type { StagedProjectConsent } from "./catalog/initial-context.ts";
import { initialWorkspaceId } from "./catalog/initial-send.ts";
import { catalogLabels } from "./catalog/labels.ts";
import { CatalogPagination } from "./catalog/pagination.tsx";
import { PreparedTaskRecovery } from "./catalog/prepared-task-recovery.tsx";
import { CatalogSession } from "./catalog/session.ts";
import { useCatalogPages } from "./catalog/use-pages.ts";
import { DraftRecovery } from "./composer/draft-recovery.tsx";
import { PreparedTaskEntry } from "./composer/prepared-entry.tsx";
import { useHomeDraft } from "./composer/use-home-draft.ts";
import { ConnectionActions } from "./connection-actions.tsx";
import type { SearchHistoryAnchor } from "./conversation/history-controller.ts";
import { prepareSearchNavigation } from "./conversation/history-reads.ts";
import { ConversationPane } from "./conversation/pane.tsx";
import { artifactNavigation } from "./files/artifact-navigation.ts";
import { FilePanel, useWorkAreaWidth } from "./files/panel.tsx";
import { FILE_PANEL, FilePanelController, panelLayout } from "./files/panel-controller.ts";
import { filePanelLabels } from "./files/panel-labels.ts";
import { ModelSettings } from "./model-settings.tsx";
import type { ProjectPinNotice } from "./projects/action-owner.ts";
import { ProjectFolderDialog, ProjectFolderSummary } from "./projects/folder.tsx";
import { canCreateProjectless, legacyAdoptionInput } from "./projects/identity.ts";
import { invalidateProjectCatalog } from "./projects/invalidation.ts";
import { projectLabels } from "./projects/labels.ts";
import { projectRecoveryLabels } from "./projects/recovery-labels.ts";
import { ConversationSearch } from "./search/search.tsx";
import { SidebarDisclosureSession } from "./sidebar/disclosure-session.ts";
import { SidebarDragProvider, type SidebarOrderAction } from "./sidebar/drag-provider.tsx";
import { SidebarInitialLoading } from "./sidebar/initial-loading.tsx";
import { SidebarItemNavigationCommands } from "./sidebar/item-navigation.tsx";
import { mergeOrder, SidebarLayoutSession, type SidebarSection } from "./sidebar/layout-session.ts";
import { useNavigationRefresh } from "./sidebar/navigation-refresh.ts";
import { sidebarOrderLabels } from "./sidebar/order-labels.ts";
import { PinRecovery, presentationKey } from "./sidebar/pin-conversation.tsx";
import { pinLabels } from "./sidebar/pin-labels.ts";
import { PinnedConversations } from "./sidebar/pinned-conversations.tsx";
import { PresentationSession } from "./sidebar/presentation-session.ts";
import { SidebarPreviewProvider } from "./sidebar/preview-provider.tsx";
import { visibleSidebarProjects } from "./sidebar/project-visibility.ts";
import { SidebarOrderSection, SidebarSectionContent, SidebarSectionHeading } from "./sidebar/section.tsx";
import { sidebarSectionLabels } from "./sidebar/section-labels.ts";
import type { SidebarLocation } from "./sidebar/selection-owner.ts";
import { SidebarSelectionProvider } from "./sidebar/selection-provider.tsx";
import { WorkspaceBranch, WorkspaceTree } from "./sidebar/workspace-tree.tsx";
import { workbenchLabels } from "./workbench-labels.ts";
import { WorkbenchWelcome } from "./workbench-welcome.tsx";

export function Workbench({
	disconnect,
	keybindings = DEFAULT_APP_KEYBINDINGS,
}: {
	disconnect: () => void;
	keybindings?: AppKeybindings;
}) {
	const client = useAppClient();
	const { files, fileAuthority, previews } = useFiles();
	const session = useMemo(() => (files ? new FileWorkspaceSession(files, previews) : undefined), [files, previews]);
	const connectionLease = useMemo(() => ({ client, session, active: true }), [client, session]);
	const currentConnection = useRef(connectionLease);
	currentConnection.current = connectionLease;
	useEffect(() => {
		connectionLease.active = true;
		session?.activate();
		return () => {
			connectionLease.active = false;
			session?.dispose();
		};
	}, [session, connectionLease]);
	const [leave, setLeave] = useState<(() => void) | null>(null);
	const guard = (action: () => void) => {
		if (session?.protected) setLeave(() => action);
		else action();
	};
	const searchTrigger = useRef<HTMLButtonElement>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const searchReturn = useRef<HTMLElement | null>(null);
	const searchActivated = useRef(false);
	const [searchAnchor, setSearchAnchor] = useState<SearchHistoryAnchor>();
	const openSearch = useCallback((opener: HTMLElement | null) => {
		searchReturn.current = opener;
		searchActivated.current = false;
		setSearchOpen(true);
	}, []);
	const local = useLocalState();
	const cache = useQueryClient();
	const projectCatalog = useQuery({
		queryKey: ["project-catalog"],
		queryFn: ({ signal }) => client.call("getProjectCatalogState", {}, signal),
		retry: false,
	});
	const catalog = useMemo(() => new CatalogSession(client, local, fileAuthority), [client, local, fileAuthority]);
	const catalogState = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
	useEffect(() => {
		catalog.activate();
		return () => catalog.dispose();
	}, [catalog]);
	const presentation = useMemo(() => new PresentationSession(client, local), [client, local]);
	const layout = useMemo(() => new SidebarLayoutSession(local), [local]);
	const layoutState = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
	const disclosure = useMemo(() => new SidebarDisclosureSession(local), [local]);
	const disclosureState = useSyncExternalStore(disclosure.subscribe, disclosure.getSnapshot, disclosure.getSnapshot);
	useEffect(() => {
		disclosure.activate();
		void disclosure.refresh();
		const refresh = (event: StorageEvent) => {
			if (event.key === null || event.key.endsWith(".value.sidebar.disclosure")) void disclosure.refresh();
		};
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("storage", refresh);
			disclosure.dispose();
		};
	}, [disclosure]);
	const [pinnedVisible, setPinnedVisible] = useState(false);
	const [orderAnnouncement, setOrderAnnouncement] = useState("");
	useEffect(() => {
		layout.activate();
		void layout.refresh();
		const refresh = (event: StorageEvent) => {
			if (event.key === null || event.key.endsWith(".value.sidebar.layout")) void layout.refresh();
		};
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("storage", refresh);
			layout.dispose();
		};
	}, [layout]);
	const presentationState = useSyncExternalStore(
		presentation.subscribe,
		presentation.getSnapshot,
		presentation.getSnapshot,
	);
	useEffect(() => {
		presentation.activate();
		return () => presentation.dispose();
	}, [presentation]);
	useEffect(() => {
		if (
			presentationState.busy ||
			(!presentationState.result &&
				!presentationState.orderResult &&
				!presentationState.mixedOrderResult &&
				!presentationState.rejected)
		)
			return;
		if (presentationState.orderResult)
			cache.setQueryData(["pinned-conversations", "pages"], {
				pages: [presentationState.orderResult],
				pageParams: [undefined],
			});
		else void cache.invalidateQueries({ queryKey: ["pinned-conversations"] });
		void cache.invalidateQueries({ queryKey: ["conversation-presentation"] });
		void cache.invalidateQueries({ queryKey: ["sidebar-pins"] });
	}, [
		presentationState.busy,
		presentationState.result,
		presentationState.orderResult,
		presentationState.mixedOrderResult,
		presentationState.rejected,
		cache,
	]);
	const panel = useMemo(() => new FilePanelController(local), [local]);
	const panelState = useSyncExternalStore(panel.subscribe, panel.snapshot, panel.snapshot);
	const panelTrigger = useRef<HTMLButtonElement>(null);
	const panelId = useId();
	const area = useRef<HTMLElement>(null);
	const areaWidth = useWorkAreaWidth(area);
	const filePanelFullWidth =
		panelState.open &&
		panelState.fullWidth &&
		areaWidth !== null &&
		!panelLayout(areaWidth, panelState.width, panelState.ratio).overlay;
	const retainedConversationWidth =
		filePanelFullWidth && areaWidth !== null
			? areaWidth - panelLayout(areaWidth, panelState.width, panelState.ratio).width - FILE_PANEL.handle
			: undefined;
	const { t, locale } = usePreferences();
	const [selectedWorkspace, setSelectedWorkspace] = useState(() => local.read("workspace") ?? "");
	const [selectedProjectId, setSelectedProjectId] = useState<string | null | undefined>(() => {
		const saved = local.read("project");
		return saved === null && local.read("workspace") ? undefined : saved || null;
	});
	const [selectedConversation, setSelectedConversation] = useState(() => local.read("conversation") ?? "");
	const [sidebarSelection, setSidebarSelection] = useState<SidebarLocation | null>(null);
	const currentScope = useRef({ workspaceId: selectedWorkspace, conversationId: selectedConversation });
	const navigationRevision = useRef(0);
	const [newChatLookup, setNewChatLookup] = useState<{ revision: number; failed: boolean } | null>(null);
	useEffect(() => {
		let owner: { requestId: string; revision: number; current: boolean; admitted: boolean } | undefined;
		return presentation.subscribePinLifecycle((event) => {
			if (event.phase === "initiated")
				owner = {
					requestId: event.input.requestId,
					revision: navigationRevision.current,
					current:
						currentScope.current.workspaceId === event.input.workspaceId &&
						currentScope.current.conversationId === event.input.conversationId,
					admitted: false,
				};
			else if (event.phase === "admitted" && owner?.requestId === event.input.requestId) owner.admitted = true;
			else if (event.phase === "retired" && owner?.requestId === event.input.requestId) owner = undefined;
			else if (event.phase === "confirmed" && owner?.requestId === event.input.requestId) {
				if (
					owner.admitted &&
					owner.current &&
					owner.revision === navigationRevision.current &&
					currentScope.current.workspaceId === event.result.workspaceId &&
					currentScope.current.conversationId === event.result.conversationId
				)
					setSidebarSelection(null);
				owner = undefined;
			}
		});
	}, [presentation]);
	useEffect(() => {
		currentScope.current = { workspaceId: selectedWorkspace, conversationId: selectedConversation };
		session?.setWorkspace(selectedWorkspace);
	}, [selectedWorkspace, selectedConversation, session]);
	const [navigationOpen, setNavigationOpen] = useState(false);
	const [navigationCollapsed, setNavigationCollapsed] = useState(false);
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const media = window.matchMedia("(max-width: 720px)");
		const update = () => {
			setNarrow(media.matches);
			if (!media.matches) setNavigationOpen(false);
		};
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [projectFilters, setProjectFilters] = useState<Record<string, "active" | "archived">>({});
	const [projectListExpanded, setProjectListExpanded] = useState(false);
	useLayoutEffect(() => {
		if (disclosureState.collapsed.projects) setProjectListExpanded(false);
	}, [disclosureState.collapsed.projects]);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [reopenFailure, setReopenFailure] = useState<"failed" | "limit" | null>(null);
	const [pinLookupFailed, setPinLookupFailed] = useState(false);
	const [projectPinNotice, setProjectPinNotice] = useState<
		(ProjectPinNotice & { connection: typeof connectionLease }) | null
	>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	useNavigationRefresh(
		!settingsOpen && (narrow ? navigationOpen : !navigationCollapsed),
		projectCatalog.data?.state === "ready",
	);
	const [folderProject, setFolderProject] = useState<Workspace>();
	const [folderCreationFailed, setFolderCreationFailed] = useState(false);
	const [folderCreationFailures, setFolderCreationFailures] = useState<Record<string, boolean>>({});
	const folderRestoreFocus = useRef<(() => void) | undefined>(undefined);
	const manageProjectFolder = (value: Workspace, restoreFocus?: () => void) => {
		folderRestoreFocus.current = restoreFocus;
		setFolderCreationFailed(!!folderCreationFailures[value.workspaceId]);
		setFolderProject(value);
	};
	const [settingsCategory, setSettingsCategory] = useState<"general" | "appearance" | "models" | "runtime">("general");
	const [composerFocusRevision, setComposerFocusRevision] = useState(0);
	const settingsTrigger = useRef<HTMLButtonElement>(null);
	const settingsReturn = useRef<HTMLElement | null>(null);
	const detailsTrigger = useRef<HTMLButtonElement>(null);
	const detailsReturn = useRef<HTMLButtonElement | null>(null);
	const initialSubmissionNavigation = useRef("");
	const isExpanded = (id: string) =>
		expanded[id] ??
		(local.read(`workspace-expanded.${id}`) === "true" ||
			(local.read(`workspace-expanded.${id}`) !== "false" && (id === selectedProjectId || id === selectedWorkspace)));
	const setProjectExpanded = (id: string, value: boolean) => {
		setExpanded((current) => ({ ...current, [id]: value }));
		local.write(`workspace-expanded.${id}`, String(value));
	};
	const navigationToggle = useRef<HTMLButtonElement>(null);
	const sidebarCollapse = useRef<HTMLButtonElement>(null);
	const navigationFocus = useRef<"sidebar" | "header" | null>(null);
	const navigationClose = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => {
		if (navigationFocus.current === "header" && navigationCollapsed) navigationToggle.current?.focus();
		if (navigationFocus.current === "sidebar" && !navigationCollapsed) sidebarCollapse.current?.focus();
		navigationFocus.current = null;
	}, [navigationCollapsed]);
	useEffect(() => {
		if (!navigationOpen) return;
		navigationClose.current?.focus();
		const close = (event: KeyboardEvent) => {
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				!event.isComposing &&
				!document.querySelector('[role="dialog"]')
			) {
				setNavigationOpen(false);
				navigationToggle.current?.focus();
			}
		};
		const resize = () => {
			if (window.innerWidth > 720) setNavigationOpen(false);
		};
		window.addEventListener("keydown", close);
		window.addEventListener("resize", resize);
		return () => {
			window.removeEventListener("keydown", close);
			window.removeEventListener("resize", resize);
			navigationToggle.current?.focus();
		};
	}, [navigationOpen]);
	const [recoveredDrafts, setRecoveredDrafts] = useState<Record<string, string>>({});
	const homeDraft = useHomeDraft(local, selectedWorkspace, selectedConversation, composerFocusRevision);
	const navigationList = useRef<HTMLDivElement>(null);
	const navigationRoot = useRef<HTMLElement>(null);
	const cl = catalogLabels(locale);
	const wl = workbenchLabels(locale);
	const catalogBlocked =
		catalogState.busy || !!catalogState.pending || !!catalogState.initialSend || catalogState.incompatible;
	const projects = useCatalogPages<ProjectListItem, ProjectPage>({
		queryKey: ["projects"],
		queryPage: (cursor, signal) => client.call("listProjects", cursor ? { cursor } : {}, signal),
		itemKey: (item) => item.project.projectId,
	});
	const adoptionAttempt = useRef<string | null>(null);
	useEffect(() => {
		const state = projectCatalog.data;
		if (!state || catalogBlocked) return;
		const input = legacyAdoptionInput(local, state);
		if (!input) return;
		const key = JSON.stringify([input.workspaceId, input.expectedCatalogGeneration, input.expectedDefaultWorkspaceId]);
		if (adoptionAttempt.current === key) return;
		adoptionAttempt.current = key;
		void catalog
			.execute({ version: PROTOCOL_VERSION, method: "adoptLegacyDefaultWorkspace", params: input })
			.then(() => {
				if (!connectionLease.active) return;
				const completed = catalog.getSnapshot();
				invalidateProjectCatalog(
					cache,
					!completed.pending && completed.projectResult?.method === "adoptLegacyDefaultWorkspace",
				);
			});
	}, [projectCatalog.data, catalogBlocked, local, catalog, cache, connectionLease]);
	const workspaces = useCatalogPages({
		queryKey: ["workspaces"],
		queryPage: (cursor, signal) => client.call("listWorkspaces", cursor ? { cursor } : {}, signal),
		itemKey: (item: Workspace) => item.workspaceId,
	});
	// Protocol 9 is the identity boundary; a delayed metadata read must never select the old creation model.
	const projectIds = projects.items
		.filter((item) => projectCatalog.data?.state !== "ready" || !item.presentation.pinned)
		.map((item) => item.project.projectId);
	const projectOrder = mergeOrder(layoutState.projects, projectIds);
	const orderedProjects = layout.orderedProjects(projectIds);
	const visibleProjects = visibleSidebarProjects(
		orderedProjects,
		projectListExpanded,
		selectedConversation && sidebarSelection?.kind === "project"
			? sidebarSelection.projectId
			: selectedConversation && sidebarSelection?.kind === "workspace"
				? sidebarSelection.workspaceId
				: "",
		projects.hasMore,
	);
	const projectById = new Map(projects.items.map((item) => [item.project.projectId, item]));
	const workspaceById = new Map(workspaces.items.map((item) => [item.workspaceId, item]));
	const layoutBlocked = layoutState.busy || layoutState.incompatible || !!layoutState.pending;
	const disclosureBlocked = disclosureState.busy || disclosureState.incompatible || !!disclosureState.pending;
	const disclosureProps = (section: SidebarSection) => ({
		collapsed: disclosureState.collapsed[section],
		disabled: disclosureBlocked,
		onCollapsedChange: (collapsed: boolean) => void disclosure.setCollapsed(section, collapsed),
	});
	const visibleSections = layoutState.sections.filter((id) => id !== "pinned" || pinnedVisible);
	const sectionAction = (id: SidebarSection): SidebarOrderAction => {
		const index = visibleSections.indexOf(id);
		const fullIndex = layoutState.sections.indexOf(id);
		const next = visibleSections[index + 1];
		return {
			item: {
				id,
				group: "sections",
				label: id === "pinned" ? pinLabels(locale).pinned : id === "recent" ? cl.recent : t("nav.workspaces"),
				revision: `${layoutState.revision}:${layoutBlocked}:${disclosureState.revisions[id]}`,
				disabled: layoutBlocked,
				after: layoutState.sections[fullIndex + 1] ?? null,
				move: (before) => {
					if (before !== null && before !== "pinned" && before !== "projects" && before !== "recent") return;
					void layout.moveSection(id, before, layoutState.revision).then((saved) => {
						if (saved && connectionLease.active)
							setOrderAnnouncement(
								`${sidebarOrderLabels(locale).movedTo} ${layout.getSnapshot().sections.indexOf(id) + 1}`,
							);
					});
				},
			},
			up: index > 0 ? visibleSections[index - 1] : undefined,
			down: next ? (layoutState.sections[layoutState.sections.indexOf(next) + 1] ?? null) : undefined,
		};
	};
	const projectActionFor = (id: string, name: string): SidebarOrderAction => {
		const index = visibleProjects.indexOf(id);
		const after = (id: string) => projectOrder[projectOrder.indexOf(id) + 1] ?? null;
		const disabled = layoutBlocked || projects.isFetching || projects.isError;
		const next = visibleProjects[index + 1];
		return {
			item: {
				id: id,
				group: "projects",
				label: name,
				revision: `${layoutState.revision}:${disabled}:${projectIds.join(",")}`,
				disabled,
				after: after(id),
				move: (before) => {
					void layout.moveProject(id, before, projectIds, layoutState.revision).then((saved) => {
						if (saved && connectionLease.active)
							setOrderAnnouncement(
								`${name}: ${sidebarOrderLabels(locale).movedTo} ${layout.orderedProjects(projectIds).indexOf(id) + 1}`,
							);
					});
				},
			},
			up: index > 0 ? visibleProjects[index - 1] : undefined,
			down: next ? after(next) : undefined,
		};
	};
	const selectedQuery = useQuery({
		queryKey: ["conversation", selectedWorkspace, selectedConversation],
		queryFn: ({ signal }) =>
			client.call("getConversation", { workspaceId: selectedWorkspace, conversationId: selectedConversation }, signal),
		enabled: !!selectedWorkspace && !!selectedConversation,
	});
	const workspaceQuery = useQuery({
		queryKey: ["workspace", selectedWorkspace],
		queryFn: ({ signal }) => client.call("getWorkspace", { workspaceId: selectedWorkspace }, signal),
		enabled: !!selectedWorkspace,
	});
	const membershipQuery = useQuery({
		queryKey: ["conversation-membership", selectedWorkspace, selectedConversation],
		queryFn: ({ signal }) =>
			client.call(
				"getConversationMembership",
				{ workspaceId: selectedWorkspace, conversationId: selectedConversation },
				signal,
			),
		enabled: !!selectedWorkspace && !!selectedConversation,
		retry: false,
	});
	const currentProjectId = selectedConversation ? membershipQuery.data?.projectId : selectedProjectId;
	const currentProjectQuery = useQuery({
		queryKey: ["project", currentProjectId],
		queryFn: ({ signal }) => {
			if (!currentProjectId) throw new Error("PROJECT_REQUIRED");
			return client.call("getProject", { projectId: currentProjectId }, signal);
		},
		enabled: !!currentProjectId,
		retry: false,
	});
	const currentProject = currentProjectQuery.data;
	useEffect(() => {
		if (selectedConversation || selectedProjectId || !selectedWorkspace) return;
		const project = projects.items.find((item) => item.project.homeWorkspaceId === selectedWorkspace)?.project;
		if (!project) return;
		setSelectedProjectId(project.projectId);
		local.write("project", project.projectId);
	}, [selectedConversation, selectedProjectId, selectedWorkspace, projects.items, local]);
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (local.hasUnsavedWork() || session?.protected) {
				event.preventDefault();
				event.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [local, session]);
	const selected = selectedQuery.data;
	const workspace = workspaceQuery.data;
	useEffect(() => {
		const command = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.repeat ||
				event.isComposing ||
				event.keyCode === 229 ||
				settingsOpen ||
				detailsOpen ||
				folderProject ||
				leave ||
				document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
			)
				return;
			const origin = navigationRevision.current;
			const scope = { ...currentScope.current };
			const current = () =>
				connectionLease.active &&
				currentConnection.current === connectionLease &&
				navigationRevision.current === origin &&
				currentScope.current.workspaceId === scope.workspaceId &&
				currentScope.current.conversationId === scope.conversationId;
			if (matchesBinding(event, keybindings.searchConversations)) {
				event.preventDefault();
				openSearch(document.activeElement instanceof HTMLElement ? document.activeElement : null);
			} else if (matchesBinding(event, keybindings.reopenClosedFile)) {
				if (!session?.canReopen(scope.workspaceId)) return;
				event.preventDefault();
				setReopenFailure(null);
				void session.reopen(scope.workspaceId, current).then(
					(result) => {
						if (!current()) return;
						if (result) panel.setOpen(true);
						else {
							const state = session.snapshot();
							setReopenFailure(state.limitReached ? "limit" : state.reopenError ? "failed" : null);
						}
					},
					() => {
						if (current()) setReopenFailure("failed");
					},
				);
			} else if (matchesBinding(event, keybindings.pinConversation)) {
				const state = presentation.getSnapshot();
				if (!selected || selected.archivedAt !== null || state.busy || state.pending || state.incompatible) return;
				event.preventDefault();
				setPinLookupFailed(false);
				void cache
					.fetchQuery({
						queryKey: presentationKey(scope),
						queryFn: ({ signal }) => client.call("getConversationPresentation", scope, signal),
						staleTime: 0,
					})
					.then(
						(value) => {
							if (
								!current() ||
								value.workspaceId !== scope.workspaceId ||
								value.conversationId !== scope.conversationId
							)
								return;
							void presentation.execute({
								...scope,
								requestId: crypto.randomUUID(),
								expectedPresentationRevision: value.revision,
								pinned: !value.pinned,
							});
						},
						() => {
							if (current()) setPinLookupFailed(true);
						},
					);
			}
		};
		window.addEventListener("keydown", command);
		return () => window.removeEventListener("keydown", command);
	}, [
		client,
		cache,
		connectionLease,
		session,
		presentation,
		panel,
		selected,
		settingsOpen,
		detailsOpen,
		folderProject,
		leave,
		keybindings,
		openSearch,
	]);
	const selectWorkspace = (id: string) => {
		setNewChatLookup(null);
		homeDraft.cancel();
		setComposerFocusRevision((value) => value + 1);
		setSidebarSelection(null);
		navigationRevision.current++;
		session?.setWorkspace(id);
		currentScope.current = { workspaceId: id, conversationId: "" };
		setSelectedWorkspace(id);
		if (id) setProjectExpanded(id, true);
		setDetailsOpen(false);
		setSelectedConversation("");
		setNavigationOpen(false);
		setSearchAnchor(undefined);
		local.write("workspace", id);
		local.write("conversation", "");
		const projectId = projects.items.find((item) => item.project.homeWorkspaceId === id)?.project.projectId ?? null;
		setSelectedProjectId(projectId);
		local.write("project", projectId ?? "");
	};
	const selectKnownProject = (project: Project) => {
		cache.setQueryData(["project", project.projectId], project);
		selectWorkspace(project.homeWorkspaceId);
		setSelectedProjectId(project.projectId);
		setProjectExpanded(project.projectId, true);
		local.write("project", project.projectId);
	};
	const selectProject = (id: string) => {
		const project = projectById.get(id)?.project ?? (currentProject?.projectId === id ? currentProject : undefined);
		if (project) selectKnownProject(project);
	};
	const selectConversation = (item: Conversation, onSelected?: () => void, location: SidebarLocation | null = null) => {
		setNewChatLookup(null);
		homeDraft.cancel();
		if (
			location &&
			currentScope.current.workspaceId === item.workspaceId &&
			currentScope.current.conversationId === item.conversationId
		) {
			// Another visible alias is a presentation choice, not a new route or execution owner.
			navigationRevision.current++;
			setSidebarSelection(location);
			return;
		}
		const select = () => {
			setSidebarSelection(location);
			setSearchAnchor(undefined);
			cache.setQueryData(["conversation", item.workspaceId, item.conversationId], item);
			navigationRevision.current++;
			session?.setWorkspace(item.workspaceId);
			currentScope.current = { workspaceId: item.workspaceId, conversationId: item.conversationId };
			setDetailsOpen(false);
			setProjectExpanded(item.workspaceId, true);
			setSelectedWorkspace(item.workspaceId);
			setSelectedConversation(item.conversationId);
			local.write("workspace", item.workspaceId);
			local.write("conversation", item.conversationId);
			setSelectedProjectId(null);
			local.write("project", "");
			setNavigationOpen(false);
		};
		select();
		onSelected?.();
	};
	const openNewConversation = async (requestedProjectId?: string | null) => {
		homeDraft.cancel();
		const origin = ++navigationRevision.current;
		const scope = { ...currentScope.current };
		const current = () =>
			connectionLease.active &&
			currentConnection.current === connectionLease &&
			navigationRevision.current === origin &&
			currentScope.current.workspaceId === scope.workspaceId &&
			currentScope.current.conversationId === scope.conversationId;
		setNewChatLookup({ revision: origin, failed: false });
		try {
			let projectId = requestedProjectId !== undefined ? requestedProjectId : currentProjectId;
			if (projectId === undefined) {
				if (!scope.workspaceId || !scope.conversationId) throw new Error("PROJECT_DESTINATION_UNVERIFIED");
				// Join the existing scoped query, but retain the click's navigation owner.
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
				selectWorkspace("");
				return;
			}
			const project =
				projectById.get(projectId)?.project ??
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
			if (current()) setNewChatLookup({ revision: origin, failed: true });
		}
	};
	const activateSearch = async (hit: ConversationSearchHit, signal: AbortSignal) => {
		const origin = navigationRevision.current;
		const result = await prepareSearchNavigation(client, hit, signal);
		if (
			signal.aborted ||
			!connectionLease.active ||
			currentConnection.current !== connectionLease ||
			navigationRevision.current !== origin
		)
			return false;
		selectConversation(result.conversation);
		setSearchAnchor(result.anchor);
		panel.restoreSplit();
		searchActivated.current = true;
		return true;
	};
	const applyCatalogResult = (origin?: number) => {
		if (!connectionLease.active || currentConnection.current !== connectionLease) return;
		const state = catalog.getSnapshot();
		if (state.projectResult && !state.pending) {
			if (state.projectResult.method === "renameProject")
				void cache.invalidateQueries({ queryKey: ["project", state.projectResult.result.projectId] });
			invalidateProjectCatalog(cache);
		}
		// A consent-bearing first Send retains its recovery owner until delivery is confirmed.
		if (state.initialSend?.context) return;
		if (state.submission && !state.busy && state.result && "conversationId" in state.result) {
			const result = state.result;
			if (
				state.submission.workspaceId === result.workspaceId &&
				state.submission.conversationId === result.conversationId &&
				initialSubmissionNavigation.current !== state.submission.requestId
			) {
				initialSubmissionNavigation.current = state.submission.requestId;
				if (origin === undefined || navigationRevision.current === origin) void homeDraft.refresh();
				void cache.invalidateQueries({ queryKey: ["workspaces"] });
				void cache.invalidateQueries({ queryKey: ["conversations", result.workspaceId] });
				if (origin === undefined || navigationRevision.current === origin) selectConversation(result);
			}
			return;
		}
		if (state.pending || state.failed || state.incompatible || state.handoffConflict) return;
		if (state.projectResult?.method === "createProject") {
			const project = state.projectResult.result;
			cache.setQueryData(["project", project.projectId], project);
			if (origin === undefined || navigationRevision.current === origin) {
				selectWorkspace(project.homeWorkspaceId);
				setSelectedProjectId(project.projectId);
				setProjectExpanded(project.projectId, true);
				local.write("project", project.projectId);
			}
			return;
		}
		const result = state.result;
		if (!result) return;
		if ("conversationId" in result) {
			cache.setQueryData(["conversation", result.workspaceId, result.conversationId], result);
			void cache.invalidateQueries({ queryKey: ["conversations", result.workspaceId] });
			void cache.invalidateQueries({ queryKey: ["pinned-conversations"] });
			void cache.invalidateQueries({ queryKey: ["sidebar-pins"] });
			void cache.invalidateQueries({ queryKey: presentationKey(result) });
			if (state.resultMethod === "createConversation" || state.resultMethod === "createProjectConversation") {
				if (origin === undefined || navigationRevision.current === origin) void homeDraft.refresh();
				if (origin === undefined || navigationRevision.current === origin) selectConversation(result);
			}
		} else {
			cache.setQueryData(["workspace", result.workspaceId], result);
			void cache.invalidateQueries({ queryKey: ["workspaces"] });
			if (origin === undefined || navigationRevision.current === origin) selectWorkspace(result.workspaceId);
		}
	};
	const resolveCatalog = async (operation: () => Promise<void>) => {
		const origin = navigationRevision.current;
		const initial = catalog.getSnapshot().initialSend;
		await operation();
		if (
			initial &&
			!catalog.getSnapshot().initialSend &&
			connectionLease.active &&
			currentConnection.current === connectionLease
		) {
			if (navigationRevision.current === origin) void homeDraft.refresh();
			if (initial.conversationId && initial.context && !initial.context.submitAttempted) {
				const scope = `${initialWorkspaceId(initial)}.${initial.conversationId}`;
				const revision = local.valueSnapshot(`draft.${scope}`)?.revision;
				if (revision) setRecoveredDrafts((current) => ({ ...current, [scope]: revision }));
			}
		}
		applyCatalogResult(origin);
	};
	const createWorkspace = async (name: string, folder?: ProjectFolderSelection) => {
		const origin = navigationRevision.current;
		await catalog.execute({
			version: PROTOCOL_VERSION,
			method: "createProject",
			params: { requestId: crypto.randomUUID(), name },
		});
		if (catalog.getSnapshot().pending || catalog.getSnapshot().failed || catalog.getSnapshot().incompatible)
			throw new Error("UNCONFIRMED");
		const ownsNavigation = navigationRevision.current === origin;
		applyCatalogResult(origin);
		const created = catalog.getSnapshot().projectResult;
		if (created?.method !== "createProject") throw new Error("UNCONFIRMED");
		const project = created.result;
		cache.setQueryData(["project", project.projectId], project);
		const bindingNavigation = ownsNavigation ? navigationRevision.current : undefined;
		const result = { workspaceId: project.homeWorkspaceId, name: project.name };
		if (folder && fileAuthority?.attachProject) {
			try {
				const binding = await fileAuthority.attachProject(result.workspaceId, folder.selectionId);
				if (connectionLease.active && currentConnection.current === connectionLease) {
					cache.setQueryData(["projectFolder", result.workspaceId], binding);
					await Promise.all([
						cache.invalidateQueries({ queryKey: ["fileRoots", result.workspaceId] }),
						cache.invalidateQueries({ queryKey: ["agent-context-roots", result.workspaceId] }),
					]);
				}
			} catch {
				if (connectionLease.active && currentConnection.current === connectionLease) {
					setFolderCreationFailures((current) => ({ ...current, [result.workspaceId]: true }));
					if (bindingNavigation !== undefined && navigationRevision.current === bindingNavigation) {
						folderRestoreFocus.current = undefined;
						setFolderCreationFailed(true);
						setFolderProject(result);
					}
				}
			}
		}
	};
	const sendInitial = async (text: string, model: ModelReference, context?: StagedProjectConsent) => {
		const origin = navigationRevision.current;
		const active = homeDraft.inventory?.active;
		if (!active || homeDraft.busy || homeDraft.failed) throw new Error("INITIAL_SEND_SOURCE_UNAVAILABLE");
		if (
			currentProjectId === undefined ||
			(currentProjectId === null && !canCreateProjectless(local, projectCatalog.data))
		)
			throw new Error("PROJECT_DESTINATION_UNVERIFIED");
		await catalog.sendInitial({
			workspaceId: currentProject?.homeWorkspaceId ?? null,
			projectId: currentProjectId,
			text,
			title: text.trim().split("\n")[0]?.slice(0, 128) ?? "",
			model,
			sourceKey: active.sourceKey,
			sourceGeneration: active.generation,
			...(context ? { context } : {}),
		});
		applyCatalogResult(origin);
		if (
			!catalog.getSnapshot().submission &&
			(catalog.getSnapshot().initialSend ||
				catalog.getSnapshot().pending ||
				catalog.getSnapshot().failed ||
				catalog.getSnapshot().incompatible)
		)
			throw new Error("UNCONFIRMED");
	};
	const workspaceTreeProps = {
		onProjectPinNotice: (notice: ProjectPinNotice) => {
			if (!connectionLease.active || currentConnection.current !== connectionLease) return;
			setProjectPinNotice((current) =>
				notice.reason
					? { ...notice, connection: connectionLease }
					: current?.connection === connectionLease && current.projectId === notice.projectId
						? null
						: current,
			);
		},
		recentWindow: true,
		navigationVisible: !settingsOpen && (narrow ? navigationOpen : !navigationCollapsed),
		recentLast: visibleSections.at(-1) === "recent",
		scrollRef: navigationList,
		workspaces: workspaces.items,
		catalog,
		presentation,
		guard: (action: () => void) => action(),
		selectedWorkspace,
		selectedConversation,
		projects: orderedProjects.flatMap((id) => {
			const item = projectById.get(id);
			return item ? [item] : [];
		}),
		selectedProjectId: currentProjectId,
		logicalReady: projectCatalog.data?.state === "ready",
		projectPinEnabled: projectCatalog.data?.state === "ready",
		isExpanded,
		onToggle: (id: string) => setProjectExpanded(id, !isExpanded(id)),
		onOpenProject: selectProject,
		onSelect: (item: Conversation, location?: SidebarLocation) => selectConversation(item, undefined, location),
		onNewConversation: openNewConversation,
		defaultWorkspaceId: catalog.defaultWorkspaceId(),
		onManageProjectFolder: manageProjectFolder,
		onManageLogicalProjectFolder: (project: Project, restoreFocus?: () => void) =>
			manageProjectFolder({ workspaceId: project.homeWorkspaceId, name: project.name }, restoreFocus),
		projectOrder: (workspace: Workspace) => projectActionFor(workspace.workspaceId, workspace.name),
		logicalProjectOrder: (item: ProjectListItem) => projectActionFor(item.project.projectId, item.project.name),
		filterFor: (id: string) => projectFilters[id] ?? "active",
		onFilterChange: (id: string, filter: "active" | "archived") =>
			setProjectFilters((current) => ({ ...current, [id]: filter })),
	};

	return (
		<div
			className="work-shell"
			data-navigation-mode={narrow ? "narrow" : "desktop"}
			data-navigation-open={navigationOpen}
			data-navigation-collapsed={navigationCollapsed}
			data-settings-open={settingsOpen}
		>
			<aside
				ref={navigationRoot}
				className="sidebar"
				data-sidebar-navigation-root=""
				id="work-navigation"
				aria-label={t("nav.workspaces")}
				inert={settingsOpen || (narrow ? !navigationOpen : navigationCollapsed)}
			>
				<div className="sidebar-brand-row">
					<SidebarItemNavigationCommands
						rootRef={navigationRoot}
						keybindings={keybindings}
						enabled={
							connectionLease.active &&
							!settingsOpen &&
							!detailsOpen &&
							!searchOpen &&
							!folderProject &&
							!leave &&
							(narrow ? navigationOpen : !navigationCollapsed)
						}
					/>
					<button
						type="button"
						className="brand brand-home"
						aria-label={t("nav.home")}
						onClick={() => selectWorkspace("")}
					>
						<BrandMark size={27} className="shrink-0" />
						<span>
							Hipi <strong>Work</strong>
						</span>
					</button>
					<Button
						ref={searchTrigger}
						className="sidebar-search-trigger"
						variant="ghost"
						size="icon-sm"
						aria-label={t("nav.search")}
						title={t("nav.search")}
						aria-expanded={searchOpen}
						onClick={(event) => openSearch(event.currentTarget)}
					>
						<Icon name="search" size={17} />
					</Button>
					<Button
						ref={sidebarCollapse}
						className="sidebar-collapse"
						variant="ghost"
						size="icon-sm"
						aria-label={wl["workbench.hideNavigation"]}
						title={wl["workbench.hideNavigation"]}
						onClick={() => {
							navigationFocus.current = "header";
							setNavigationCollapsed(true);
						}}
					>
						<Icon name="panel" size={17} />
					</Button>
					<Button
						ref={navigationClose}
						className="mobile-close"
						variant="ghost"
						size="icon"
						aria-label={t("common.close")}
						onClick={() => {
							setNavigationOpen(false);
							navigationToggle.current?.focus();
						}}
					>
						<Icon name="panel" />
					</Button>
				</div>
				<section className="conversation-nav">
					<div className="workspace-create">
						<Button
							variant="ghost"
							className="new-conversation-trigger"
							aria-busy={newChatLookup?.revision === navigationRevision.current && !newChatLookup.failed}
							onClick={() => void openNewConversation()}
						>
							<SquarePen size={16} aria-hidden="true" />
							{t("nav.newConversation")}
						</Button>
					</div>
					{newChatLookup?.revision === navigationRevision.current && newChatLookup.failed && (
						<p className="nav-feedback" role="alert">
							{cl.currentFailed}
						</p>
					)}
					<div className="navigation-list" ref={navigationList} tabIndex={-1}>
						<SidebarInitialLoading>
							<SidebarDragProvider
								scrollRef={navigationList}
								keybindings={keybindings}
								disabled={settingsOpen || searchOpen || (narrow ? !navigationOpen : navigationCollapsed)}
							>
								<SidebarSelectionProvider
									scope={{ workspaceId: selectedWorkspace, conversationId: selectedConversation }}
									preferredLocation={sidebarSelection}
									rootRef={navigationRoot}
								>
									<SidebarPreviewProvider
										disabled={
											settingsOpen || searchOpen || !!folderProject || (narrow ? !navigationOpen : navigationCollapsed)
										}
										navigationKey={JSON.stringify([selectedWorkspace, selectedConversation])}
									>
										{layoutState.sections.map((section) =>
											section === "pinned" ? (
												<PinnedConversations
													key={section}
													catalog={catalog}
													presentation={presentation}
													mixed
													mixedReady={projectCatalog.data?.state === "ready"}
													renderProject={(item, orderAction) => (
														<WorkspaceBranch
															key={item.project.projectId}
															{...workspaceTreeProps}
															projectItem={item}
															pinnedProject
															onOpenProject={() => selectKnownProject(item.project)}
															onNewConversation={() => selectKnownProject(item.project)}
															logicalProjectOrder={() => orderAction}
														/>
													)}
													navigationRevision={navigationRevision.current}
													onSelect={(item) => selectConversation(item, undefined, { kind: "pinned" })}
													sectionAction={sectionAction(section)}
													onVisibleChange={setPinnedVisible}
													collapsed={disclosureState.collapsed.pinned}
													disclosureDisabled={disclosureBlocked}
													onCollapsedChange={(collapsed) => void disclosure.setCollapsed("pinned", collapsed)}
												/>
											) : section === "recent" ? (
												<SidebarOrderSection
													key={section}
													action={sectionAction(section)}
													{...disclosureProps(section)}
												>
													<WorkspaceTree {...workspaceTreeProps} section="recent" />
												</SidebarOrderSection>
											) : (
												<SidebarOrderSection
													key={section}
													action={sectionAction(section)}
													{...disclosureProps(section)}
												>
													<SidebarSectionHeading
														actions={
															<CreateDialog
																disabled={catalogBlocked}
																kind="workspace"
																compact
																onCreate={createWorkspace}
																chooseFolder={fileAuthority?.prepareProject}
																forgetFolder={fileAuthority?.forgetProjectSelection}
															/>
														}
													>
														{t("nav.workspaces")}
													</SidebarSectionHeading>
													<SidebarSectionContent>
														{projects.isPending && !projects.hasData && (
															<output className="nav-feedback">{t("common.loading")}</output>
														)}
														{projects.hasData && projects.isFetching && !projects.isLoadingMore && (
															<output className="catalog-refresh-status">{t("common.loading")}</output>
														)}
														{projects.isError && (
															<div className="nav-feedback" role="alert">
																<p>
																	{projects.error instanceof AppError && projects.error.code === "STORE_MISMATCH"
																		? t("connection.storeMismatch")
																		: projects.staleCursor
																			? cl.staleList
																			: projects.isLoadMoreError
																				? cl.loadMoreFailed
																				: projects.hasData
																					? cl.refreshFailed
																					: t("nav.loadError")}
																</p>
																<Button
																	variant="outline"
																	size="sm"
																	disabled={projects.isFetching}
																	onClick={() => void projects.retry()}
																>
																	<Icon name="refresh" size={14} />
																	{t("nav.refresh")}
																</Button>
															</div>
														)}
														{projects.isSuccess &&
															!projects.isFetching &&
															!projects.isError &&
															!projects.hasMore &&
															projectIds.length === 0 && <p className="nav-feedback">{t("nav.noWorkspaces")}</p>}
														<WorkspaceTree
															{...workspaceTreeProps}
															projects={workspaceTreeProps.projects.filter((item) =>
																visibleProjects.includes(item.project.projectId),
															)}
															section="projects"
															projectDataUpdatedAt={projects.dataUpdatedAt}
														/>
														{!projectListExpanded && orderedProjects.length > visibleProjects.length && (
															<Button
																variant="ghost"
																size="sm"
																className="sidebar-project-show-more"
																onClick={() => setProjectListExpanded(true)}
															>
																{t("work.showMore")}
															</Button>
														)}
														<CatalogPagination pages={projects} listRef={navigationList} />
													</SidebarSectionContent>
												</SidebarOrderSection>
											),
										)}
									</SidebarPreviewProvider>
								</SidebarSelectionProvider>
							</SidebarDragProvider>
						</SidebarInitialLoading>
						<output className="sr-only" aria-live="polite">
							{orderAnnouncement}
						</output>
						{(disclosureState.failed || disclosureState.stale || disclosureState.incompatible) && (
							<section className="nav-feedback" aria-live="polite">
								<p role="alert">
									{
										sidebarSectionLabels(locale)[
											disclosureState.incompatible ? "incompatible" : disclosureState.stale ? "stale" : "failed"
										]
									}
								</p>
								<Button
									variant="ghost"
									size="sm"
									disabled={disclosureState.busy}
									onClick={() => void disclosure.refresh()}
								>
									{sidebarSectionLabels(locale).refresh}
								</Button>
								{disclosureState.pending && (
									<Button
										variant="ghost"
										size="sm"
										disabled={disclosureState.busy}
										onClick={() => void disclosure.retry()}
									>
										{sidebarSectionLabels(locale).retry}
									</Button>
								)}
							</section>
						)}
						{(layoutState.failed || layoutState.stale || layoutState.incompatible) && (
							<section className="nav-feedback" aria-live="polite">
								<p role="alert">
									{
										sidebarOrderLabels(locale)[
											layoutState.incompatible ? "incompatible" : layoutState.stale ? "stale" : "failed"
										]
									}
								</p>
								<Button variant="ghost" size="sm" disabled={layoutState.busy} onClick={() => void layout.refresh()}>
									{sidebarOrderLabels(locale).refresh}
								</Button>
								{layoutState.pending && (
									<Button variant="ghost" size="sm" disabled={layoutState.busy} onClick={() => void layout.retry()}>
										{sidebarOrderLabels(locale).retry}
									</Button>
								)}
							</section>
						)}
						<CatalogRecovery session={catalog} onResolve={resolveCatalog} />
						{projectPinNotice?.connection === connectionLease && projectPinNotice.reason && (
							<section className="nav-feedback" role="alert">
								<p>
									{projectPinNotice.projectName}: {projectLabels(locale)[projectPinNotice.reason]}
								</p>
								<Button variant="ghost" size="sm" onClick={() => setProjectPinNotice(null)}>
									{catalogLabels(locale).close}
								</Button>
							</section>
						)}
						{projectCatalog.data &&
							!canCreateProjectless(local, projectCatalog.data) &&
							!catalogState.pending &&
							!catalogState.busy && (
								<output className="nav-feedback">{projectRecoveryLabels(locale).defaultUnverified}</output>
							)}
						<PinRecovery session={presentation} />
						{pinLookupFailed && (
							<p className="nav-feedback" role="alert">
								{pinLabels(locale).loadError}
							</p>
						)}
					</div>
				</section>
				<div className="sidebar-footer">
					<Button
						ref={settingsTrigger}
						variant="ghost"
						className="sidebar-settings-trigger"
						aria-label={cl.settings}
						onClick={(event) => {
							settingsReturn.current = event.currentTarget;
							setSettingsCategory("general");
							setSettingsOpen(true);
						}}
					>
						<Settings size={17} aria-hidden="true" />
						{wl["workbench.settings"]}
					</Button>
				</div>
			</aside>
			<div className="main-shell" inert={navigationOpen || settingsOpen}>
				<header className="app-toolbar">
					<div className="toolbar-path">
						<Button
							ref={navigationToggle}
							className="navigation-toggle"
							variant="ghost"
							size="icon"
							aria-label={t("nav.toggle")}
							aria-expanded={narrow ? navigationOpen : !navigationCollapsed}
							aria-controls="work-navigation"
							onClick={() => {
								if (narrow) setNavigationOpen((value) => !value);
								else {
									navigationFocus.current = navigationCollapsed ? "sidebar" : "header";
									setNavigationCollapsed((value) => !value);
								}
							}}
						>
							<Icon name="panel" />
						</Button>
						<div className="toolbar-context">
							{selected ? (
								<span className="toolbar-conversation" title={selected.title}>
									{selected.title}
								</span>
							) : (
								<span className="toolbar-project-title">{currentProject?.name ?? "Hipi Work"}</span>
							)}
							{currentProject && selected && (
								<button
									type="button"
									className="toolbar-project-link"
									aria-label={`${wl["workbench.projectHome"]}: ${currentProject.name}`}
									onClick={() => selectProject(currentProject.projectId)}
								>
									<Icon name="folder" size={12} />
									<span>{currentProject.name}</span>
								</button>
							)}
						</div>
					</div>
					<div className="toolbar-actions">
						<Button
							ref={panelTrigger}
							className="file-panel-toggle"
							data-active={panelState.open}
							aria-label={filePanelLabels(locale)[panelState.open ? "filePanel.hide" : "filePanel.show"]}
							variant="ghost"
							size="sm"
							aria-expanded={panelState.open}
							aria-controls={panelState.open ? panelId : undefined}
							onClick={() => panel.setOpen(!panelState.open)}
						>
							<Icon name="folder" size={15} />
							{filePanelLabels(locale)[panelState.open ? "filePanel.hide" : "filePanel.show"]}
						</Button>
						{selected && (
							<ConversationActions
								conversation={selected}
								session={catalog}
								presentation={presentation}
								guard={(action) => action()}
							/>
						)}
						{selected && (
							<Button
								ref={detailsTrigger}
								variant="ghost"
								size="icon"
								aria-label={t("receipt.details")}
								aria-expanded={detailsOpen}
								onClick={() => {
									detailsReturn.current = detailsTrigger.current;
									setDetailsOpen((value) => !value);
								}}
							>
								<Icon name="info" />
							</Button>
						)}
					</div>
				</header>
				<PreparedTaskRecovery session={catalog} onResolve={resolveCatalog} />
				{!selectedConversation && (
					<DraftRecovery
						inventory={homeDraft.inventory}
						busy={homeDraft.busy}
						failed={homeDraft.failed}
						onRecover={(source) => {
							void homeDraft.recover(source);
						}}
						onReload={() => {
							void homeDraft.reload();
						}}
						projectName={(id) => workspaceById.get(id)?.name ?? id}
					/>
				)}
				{reopenFailure && (
					<p className="file-panel-storage" role="alert">
						{fileLabels(locale)[reopenFailure === "limit" ? "tabs.limit" : "tabs.reopenFailed"]}
					</p>
				)}
				{panelState.storageFailed && (
					<output className="file-panel-storage">{filePanelLabels(locale)["filePanel.storageFailed"]}</output>
				)}
				<main className="work-area" ref={area} data-file-panel-full-width={filePanelFullWidth}>
					{(selectedQuery.isError ||
						workspaceQuery.isError ||
						currentProjectQuery.isError ||
						membershipQuery.isError ||
						projectCatalog.isError) && (
						<p role="alert">
							{cl.currentFailed}
							<Button
								variant="ghost"
								onClick={() => {
									void selectedQuery.refetch();
									void workspaceQuery.refetch();
									if (currentProjectId) void currentProjectQuery.refetch();
									if (selectedConversation) void membershipQuery.refetch();
									void projectCatalog.refetch();
								}}
							>
								{t("nav.refresh")}
							</Button>
						</p>
					)}
					<div
						className="work-conversation-frame"
						inert={filePanelFullWidth}
						aria-hidden={filePanelFullWidth || undefined}
						style={{ width: retainedConversationWidth }}
					>
						{selected ? (
							<ConversationPane
								key={`${selected.workspaceId}.${selected.conversationId}`}
								conversation={selected}
								searchAnchor={searchAnchor}
								onExitSearchAnchor={() => setSearchAnchor(undefined)}
								draftRecoveryRevision={recoveredDrafts[`${selected.workspaceId}.${selected.conversationId}`]}
								onOpenModelSettings={(returnFocus) => {
									settingsReturn.current = returnFocus;
									setSettingsCategory("models");
									setSettingsOpen(true);
								}}
								onOpenArtifact={
									session ? artifactNavigation(selected, () => currentScope.current, session, panel) : undefined
								}
								detailsOpen={detailsOpen}
								onDetailsClose={() => {
									setDetailsOpen(false);
									const target = detailsReturn.current;
									if (target?.isConnected && target.getClientRects().length) target.focus();
									else detailsTrigger.current?.focus();
								}}
							/>
						) : (
							<WorkbenchWelcome
								workspaceName={currentProject?.name}
								action={
									<>
										{currentProject && (
											<ProjectFolderSummary
												workspaceId={currentProject.homeWorkspaceId}
												failed={folderCreationFailures[currentProject.homeWorkspaceId]}
												onManage={(trigger) =>
													manageProjectFolder(
														{ workspaceId: currentProject.homeWorkspaceId, name: currentProject.name },
														() => {
															if (trigger.isConnected) trigger.focus({ preventScroll: true });
														},
													)
												}
											/>
										)}
										<PreparedTaskEntry
											key={homeDraft.inventory?.active?.generation ?? "loading-draft"}
											workspaceId={currentProject?.homeWorkspaceId ?? ""}
											draft={homeDraft.text}
											onDraftChange={homeDraft.change}
											readOnly={homeDraft.busy || !homeDraft.inventory?.active}
											disabled={
												catalogBlocked ||
												homeDraft.busy ||
												homeDraft.failed ||
												!homeDraft.inventory?.active ||
												(!!currentProjectId && !currentProject) ||
												(!currentProjectId && !canCreateProjectless(local, projectCatalog.data))
											}
											busy={catalogState.busy}
											onSend={sendInitial}
											focusRevision={composerFocusRevision}
											onManageModels={(returnFocus) => {
												settingsReturn.current = returnFocus;
												setSettingsCategory("models");
												setSettingsOpen(true);
											}}
										/>
									</>
								}
							/>
						)}
					</div>
					<FilePanel
						controller={panel}
						available={areaWidth}
						workspaceId={selectedWorkspace}
						session={session}
						guard={guard}
						trigger={panelTrigger}
						id={panelId}
					/>
				</main>
			</div>
			{folderProject && (
				<ProjectFolderDialog
					key={folderProject.workspaceId}
					workspaceId={folderProject.workspaceId}
					name={folderProject.name}
					session={session}
					initialFailure={folderCreationFailed}
					onConfirmed={() =>
						setFolderCreationFailures((current) => ({ ...current, [folderProject.workspaceId]: false }))
					}
					onClose={() => setFolderProject(undefined)}
					onRestoreFocus={() => {
						if (folderRestoreFocus.current) folderRestoreFocus.current();
						else navigationToggle.current?.focus({ preventScroll: true });
					}}
				/>
			)}
			<ConversationSearch
				open={searchOpen}
				onOpenChange={setSearchOpen}
				onActivate={activateSearch}
				onRestoreFocus={() => {
					if (searchActivated.current) {
						document.querySelector<HTMLElement>(".message-scroll")?.focus({ preventScroll: true });
						return;
					}
					const target = searchReturn.current;
					if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
					else if (searchTrigger.current?.getClientRects().length) searchTrigger.current.focus({ preventScroll: true });
					else navigationToggle.current?.focus({ preventScroll: true });
				}}
			/>

			<SettingsDialog
				open={settingsOpen}
				initialCategory={settingsCategory}
				onOpenChange={setSettingsOpen}
				workspace={workspace}
				conversation={selected}
				onRestoreFocus={() => {
					const target = settingsReturn.current;
					if (target?.isConnected && target.getClientRects().length) target.focus();
					else if (settingsTrigger.current?.getClientRects().length) settingsTrigger.current.focus();
					else navigationToggle.current?.focus();
				}}
				onOpenConversation={() => setSettingsOpen(false)}
				credentialSettings={<ModelSettings />}
				workspaceActions={
					workspace ? <ToolPacksDialog key={workspace.workspaceId} workspaceId={workspace.workspaceId} /> : undefined
				}
				runtimeActions={
					<ConnectionActions
						disconnect={disconnect}
						prepareDisconnect={() => {
							let committed = false;
							const captured = new Map(
								(session?.snapshot().tabs ?? []).flatMap((tab) =>
									tab.kind === "editor" && tab.editor.protected ? [[tab.editor, tab.editor.snapshot()] as const] : [],
								),
							);
							return {
								warning: captured.size ? fileLabels(locale).leaveNote : undefined,
								commit: () => {
									if (committed) return true;
									if (!connectionLease.active || currentConnection.current !== connectionLease) return false;
									for (const tab of session?.snapshot().tabs ?? []) {
										if (
											tab.kind === "editor" &&
											tab.editor.protected &&
											captured.get(tab.editor) !== tab.editor.snapshot()
										)
											return false;
									}
									committed = true;
									disconnect();
									return true;
								},
							};
						}}
						onOpen={(opened, item) => {
							cache.setQueryData(["workspace", opened.workspaceId], opened);
							selectConversation(item, () => setSettingsOpen(false));
						}}
					/>
				}
			/>
			<Dialog
				open={!!leave}
				onOpenChange={(open) => {
					if (!open) setLeave(null);
				}}
			>
				<DialogContent closeLabel={t("common.close")}>
					<DialogTitle>{fileLabels(locale).leave}</DialogTitle>
					<DialogDescription>{fileLabels(locale).leaveNote}</DialogDescription>
					<div className="file-actions">
						<Button variant="outline" onClick={() => setLeave(null)}>
							{fileLabels(locale).stay}
						</Button>
						<Button
							onClick={() => {
								const action = leave;
								setLeave(null);
								action?.();
							}}
						>
							{fileLabels(locale).discard}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
