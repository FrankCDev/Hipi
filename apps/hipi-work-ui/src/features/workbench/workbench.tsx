import {
	AppError,
	type Conversation,
	type ModelReference,
	PROTOCOL_VERSION,
	type Workspace,
} from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings, SquarePen, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient, useFiles, useLocalState } from "../../app/client-provider.tsx";
import type { ProjectFolderSelection } from "../../app/file-client.ts";
import { type AppKeybindings, DEFAULT_APP_KEYBINDINGS, matchesBinding } from "../../app/keybindings.ts";
import { usePreferences } from "../../app/preferences.tsx";
import { BrandMark } from "../../components/brand-mark.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group.tsx";
import { fileLabels } from "../files/file-labels.ts";
import { FileWorkspaceSession } from "../files/file-workspace-session.ts";
import { SettingsDialog } from "../settings/index.ts";
import { ToolPacksDialog } from "../tool-packs/index.ts";
import { artifactNavigation } from "./artifact-navigation.ts";
import { CatalogRecovery, ConversationActions } from "./catalog-controls.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import { CatalogPagination } from "./catalog-pagination.tsx";
import { CatalogSession } from "./catalog-session.ts";
import { ConnectionActions } from "./connection-actions.tsx";
import { ConversationPane } from "./conversation-pane.tsx";
import { CreateDialog } from "./create-dialog.tsx";
import { FilePanel, useWorkAreaWidth } from "./file-panel.tsx";
import { FILE_PANEL, FilePanelController, panelLayout } from "./file-panel-controller.ts";
import { filePanelLabels } from "./file-panel-labels.ts";
import type { StagedProjectConsent } from "./initial-context.ts";
import { ModelSettings } from "./model-settings.tsx";
import { PinRecovery, presentationKey } from "./pin-conversation.tsx";
import { pinLabels } from "./pin-labels.ts";
import { PinnedConversations } from "./pinned-conversations.tsx";
import { PreparedTaskEntry } from "./prepared-task-entry.tsx";
import { PreparedTaskRecovery } from "./prepared-task-recovery.tsx";
import { PresentationSession } from "./presentation-session.ts";
import { ProjectFolderDialog, ProjectFolderSummary } from "./project-folder.tsx";
import { useCatalogPages } from "./use-catalog-pages.ts";
import { workbenchLabels } from "./workbench-labels.ts";
import { WorkbenchWelcome } from "./workbench-welcome.tsx";
import { WorkspaceTree } from "./workspace-tree.tsx";

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
	const searchInputId = useId();
	const searchInput = useRef<HTMLInputElement>(null);
	const searchTrigger = useRef<HTMLButtonElement>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	useEffect(() => {
		if (searchOpen) searchInput.current?.focus();
	}, [searchOpen]);
	const local = useLocalState();
	const cache = useQueryClient();
	const catalog = useMemo(() => new CatalogSession(client, local, fileAuthority), [client, local, fileAuthority]);
	const catalogState = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
	useEffect(() => {
		catalog.activate();
		return () => catalog.dispose();
	}, [catalog]);
	const presentation = useMemo(() => new PresentationSession(client, local), [client, local]);
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
		if (presentationState.busy || (!presentationState.result && !presentationState.rejected)) return;
		void cache.invalidateQueries({ queryKey: ["pinned-conversations"] });
		void cache.invalidateQueries({ queryKey: ["conversation-presentation"] });
	}, [presentationState.busy, presentationState.result, presentationState.rejected, cache]);
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
	const [selectedConversation, setSelectedConversation] = useState(() => local.read("conversation") ?? "");
	const currentScope = useRef({ workspaceId: selectedWorkspace, conversationId: selectedConversation });
	const navigationRevision = useRef(0);
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
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [reopenFailure, setReopenFailure] = useState<"failed" | "limit" | null>(null);
	const [pinLookupFailed, setPinLookupFailed] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
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
			(local.read(`workspace-expanded.${id}`) !== "false" && id === selectedWorkspace));
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
			if (event.key === "Escape" && !event.defaultPrevented) {
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
	const [search, setSearch] = useState("");
	const closeSearch = () => {
		setSearch("");
		setSearchOpen(false);
		searchTrigger.current?.focus();
	};
	const [preparedDrafts, setPreparedDrafts] = useState<Record<string, string>>({});
	const [recoveredDrafts, setRecoveredDrafts] = useState<Record<string, string>>({});
	const preparedKey = (workspaceId: string) => (workspaceId ? `task-draft.${workspaceId}` : "chat-draft.global");
	const preparedDraft = (workspaceId: string) =>
		preparedDrafts[preparedKey(workspaceId)] ?? local.read(preparedKey(workspaceId)) ?? "";
	const changePreparedDraft = (workspaceId: string, value: string) => {
		local.write(preparedKey(workspaceId), value);
		setPreparedDrafts((current) => ({ ...current, [preparedKey(workspaceId)]: value }));
	};
	const navigationList = useRef<HTMLDivElement>(null);
	const cl = catalogLabels(locale);
	const wl = workbenchLabels(locale);
	const catalogBlocked =
		catalogState.busy || !!catalogState.pending || !!catalogState.initialSend || catalogState.incompatible;
	const workspaces = useCatalogPages({
		queryKey: ["workspaces"],
		queryPage: (cursor, signal) => client.call("listWorkspaces", cursor ? { cursor } : {}, signal),
		itemKey: (item) => item.workspaceId,
	});
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
			if (matchesBinding(event, keybindings.reopenClosedFile)) {
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
	]);
	const selectWorkspace = (id: string) => {
		navigationRevision.current++;
		session?.setWorkspace(id);
		currentScope.current = { workspaceId: id, conversationId: "" };
		setSelectedWorkspace(id);
		if (id) setProjectExpanded(id, true);
		setDetailsOpen(false);
		setSelectedConversation("");
		setNavigationOpen(false);
		setSearch("");
		local.write("workspace", id);
		local.write("conversation", "");
	};
	const selectConversation = (item: Conversation, onSelected?: () => void) => {
		const select = () => {
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
			setNavigationOpen(false);
		};
		select();
		onSelected?.();
	};
	const openNewConversation = (requestedWorkspaceId: string) => {
		const workspaceId = requestedWorkspaceId === catalog.defaultWorkspaceId() ? "" : requestedWorkspaceId;
		const open = () => {
			navigationRevision.current++;
			session?.setWorkspace(workspaceId);
			currentScope.current = { workspaceId, conversationId: "" };
			setSelectedWorkspace(workspaceId);
			setSelectedConversation("");
			setDetailsOpen(false);
			setNavigationOpen(false);
			setComposerFocusRevision((value) => value + 1);
			if (workspaceId) setProjectExpanded(workspaceId, true);
			local.write("workspace", workspaceId);
			local.write("conversation", "");
		};
		open();
	};
	const applyCatalogResult = (origin?: number) => {
		if (!connectionLease.active || currentConnection.current !== connectionLease) return;
		const state = catalog.getSnapshot();
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
				setPreparedDrafts((current) => ({
					...current,
					[preparedKey(result.workspaceId)]: local.read(preparedKey(result.workspaceId)) ?? "",
					"chat-draft.global": local.read("chat-draft.global") ?? "",
				}));
				void cache.invalidateQueries({ queryKey: ["workspaces"] });
				void cache.invalidateQueries({ queryKey: ["conversations", result.workspaceId] });
				if (origin === undefined || navigationRevision.current === origin) selectConversation(result);
			}
			return;
		}
		if (state.pending || state.failed || state.incompatible || state.handoffConflict) return;
		const result = state.result;
		if (!result) return;
		if ("conversationId" in result) {
			cache.setQueryData(["conversation", result.workspaceId, result.conversationId], result);
			void cache.invalidateQueries({ queryKey: ["conversations", result.workspaceId] });
			void cache.invalidateQueries({ queryKey: ["pinned-conversations"] });
			void cache.invalidateQueries({ queryKey: presentationKey(result) });
			if (state.resultMethod === "createConversation") {
				setPreparedDrafts((current) => ({
					...current,
					[preparedKey(result.workspaceId)]: local.read(preparedKey(result.workspaceId)) ?? "",
					"chat-draft.global": local.read("chat-draft.global") ?? "",
				}));
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
			setPreparedDrafts((current) => ({ ...current, [initial.sourceKey]: local.read(initial.sourceKey) ?? "" }));
			if (initial.conversationId && initial.context && !initial.context.submitAttempted) {
				const scope = `${initial.conversationCommand.params.workspaceId}.${initial.conversationId}`;
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
			method: "createWorkspace",
			params: { workspaceId: crypto.randomUUID(), name },
		});
		if (catalog.getSnapshot().pending || catalog.getSnapshot().failed || catalog.getSnapshot().incompatible)
			throw new Error("UNCONFIRMED");
		const ownsNavigation = navigationRevision.current === origin;
		applyCatalogResult(origin);
		const bindingNavigation = ownsNavigation ? navigationRevision.current : undefined;
		const result = catalog.getSnapshot().result;
		if (folder && result && !("conversationId" in result) && fileAuthority?.attachProject) {
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
		await catalog.sendInitial({
			workspaceId: selectedWorkspace || null,
			text,
			title: text.trim().split("\n")[0]?.slice(0, 128) ?? "",
			model,
			sourceKey: preparedKey(selectedWorkspace),
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

	return (
		<div
			className="work-shell"
			data-navigation-mode={narrow ? "narrow" : "desktop"}
			data-navigation-open={navigationOpen}
			data-navigation-collapsed={navigationCollapsed}
			data-settings-open={settingsOpen}
		>
			<aside
				className="sidebar"
				id="work-navigation"
				aria-label={t("nav.workspaces")}
				inert={settingsOpen || (narrow ? !navigationOpen : navigationCollapsed)}
			>
				<div className="sidebar-brand-row">
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
						aria-controls={`${searchInputId}-panel`}
						onClick={() => {
							if (searchOpen) closeSearch();
							else setSearchOpen(true);
						}}
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
							onClick={() =>
								openNewConversation(selectedWorkspace === catalog.defaultWorkspaceId() ? "" : selectedWorkspace)
							}
						>
							<SquarePen size={16} aria-hidden="true" />
							{t("nav.newConversation")}
						</Button>
					</div>
					<div className="sidebar-search-panel" id={`${searchInputId}-panel`} hidden={!searchOpen}>
						<label className="sr-only" htmlFor={searchInputId}>
							{t("nav.search")}
						</label>
						<InputGroup className="nav-search">
							<InputGroupInput
								ref={searchInput}
								id={searchInputId}
								type="search"
								placeholder={t("nav.search")}
								aria-describedby={`${searchInputId}-scope`}
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape" && !event.nativeEvent.isComposing) {
										event.preventDefault();
										event.stopPropagation();
										closeSearch();
									}
								}}
							/>
							<InputGroupAddon>
								<Icon name="search" size={16} />
							</InputGroupAddon>
							<InputGroupAddon align="inline-end">
								<Button
									variant="ghost"
									size="icon-sm"
									className="sidebar-search-clear"
									aria-label={t(search ? "nav.clearSearch" : "nav.closeSearch")}
									onClick={() => {
										if (!search) closeSearch();
										else {
											setSearch("");
											searchInput.current?.focus();
										}
									}}
								>
									<X size={14} aria-hidden="true" />
								</Button>
							</InputGroupAddon>
						</InputGroup>
						<p className="search-scope" id={`${searchInputId}-scope`}>
							{cl.searchScope}
						</p>
					</div>
					<div className="navigation-list" ref={navigationList} tabIndex={-1}>
						<PinnedConversations
							catalog={catalog}
							presentation={presentation}
							selectedWorkspace={selectedWorkspace}
							selectedConversation={selectedConversation}
							search={search}
							onSelect={selectConversation}
						/>
						<div className="nav-section-heading">
							<span>{t("nav.workspaces")}</span>
							<CreateDialog
								disabled={catalogBlocked}
								kind="workspace"
								compact
								onCreate={createWorkspace}
								chooseFolder={fileAuthority?.prepareProject}
								forgetFolder={fileAuthority?.forgetProjectSelection}
							/>
						</div>
						{workspaces.isPending && !workspaces.hasData && (
							<output className="nav-feedback">{t("common.loading")}</output>
						)}
						{workspaces.hasData && workspaces.isFetching && !workspaces.isLoadingMore && (
							<output className="catalog-refresh-status">{t("common.loading")}</output>
						)}
						{workspaces.isError && (
							<div className="nav-feedback" role="alert">
								<p>
									{workspaces.error instanceof AppError && workspaces.error.code === "STORE_MISMATCH"
										? t("connection.storeMismatch")
										: workspaces.staleCursor
											? cl.staleList
											: workspaces.isLoadMoreError
												? cl.loadMoreFailed
												: workspaces.hasData
													? cl.refreshFailed
													: t("nav.loadError")}
								</p>
								<Button
									variant="outline"
									size="sm"
									disabled={workspaces.isFetching}
									onClick={() => void workspaces.retry()}
								>
									<Icon name="refresh" size={14} />
									{t("nav.refresh")}
								</Button>
							</div>
						)}
						{workspaces.isSuccess && workspaces.items.length === 0 && (
							<p className="nav-feedback">{t("nav.noWorkspaces")}</p>
						)}
						<WorkspaceTree
							workspaces={workspaces.items}
							catalog={catalog}
							presentation={presentation}
							guard={(action) => action()}
							selectedWorkspace={selectedWorkspace}
							selectedConversation={selectedConversation}
							search={search}
							isExpanded={isExpanded}
							onToggle={(id) => setProjectExpanded(id, !isExpanded(id))}
							onOpenProject={selectWorkspace}
							onSelect={selectConversation}
							onNewConversation={openNewConversation}
							defaultWorkspaceId={catalog.defaultWorkspaceId()}
							onManageProjectFolder={manageProjectFolder}
						/>
						<CatalogPagination pages={workspaces} listRef={navigationList} />
						<CatalogRecovery session={catalog} onResolve={resolveCatalog} />
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
								<span className="toolbar-project-title">{workspace?.name ?? "Hipi Work"}</span>
							)}
							{workspace && selected && workspace.workspaceId !== catalog.defaultWorkspaceId() && (
								<button
									type="button"
									className="toolbar-project-link"
									aria-label={`${wl["workbench.projectHome"]}: ${workspace.name}`}
									onClick={() => selectWorkspace(workspace.workspaceId)}
								>
									<Icon name="folder" size={12} />
									<span>{workspace.name}</span>
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
				{reopenFailure && (
					<p className="file-panel-storage" role="alert">
						{fileLabels(locale)[reopenFailure === "limit" ? "tabs.limit" : "tabs.reopenFailed"]}
					</p>
				)}
				{panelState.storageFailed && (
					<output className="file-panel-storage">{filePanelLabels(locale)["filePanel.storageFailed"]}</output>
				)}
				<main className="work-area" ref={area} data-file-panel-full-width={filePanelFullWidth}>
					{(selectedQuery.isError || workspaceQuery.isError) && (
						<p role="alert">
							{cl.currentFailed}
							<Button
								variant="ghost"
								onClick={() => {
									void selectedQuery.refetch();
									void workspaceQuery.refetch();
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
								workspaceName={workspace?.name}
								action={
									<>
										{workspace && workspace.workspaceId !== catalog.defaultWorkspaceId() && (
											<ProjectFolderSummary
												workspaceId={workspace.workspaceId}
												failed={folderCreationFailures[workspace.workspaceId]}
												onManage={(trigger) =>
													manageProjectFolder(workspace, () => {
														if (trigger.isConnected) trigger.focus({ preventScroll: true });
													})
												}
											/>
										)}
										<PreparedTaskEntry
											key={selectedWorkspace || "global"}
											workspaceId={selectedWorkspace}
											draft={preparedDraft(selectedWorkspace)}
											onDraftChange={(value) => changePreparedDraft(selectedWorkspace, value)}
											disabled={catalogBlocked}
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
