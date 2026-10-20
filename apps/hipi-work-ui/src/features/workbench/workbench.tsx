import { AppError, type Conversation, type ModelReference, PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronUp, Settings } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient, useFiles, useLocalState } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { BrandMark } from "../../components/brand-mark.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.tsx";
import { EditorSession } from "../files/editor-session.ts";
import { fileLabels } from "../files/file-labels.ts";
import { AppearanceSettings } from "../settings/index.ts";
import { ToolPacksDialog } from "../tool-packs/index.ts";
import { artifactNavigation } from "./artifact-navigation.ts";
import { CatalogRecovery, ConversationActions } from "./catalog-controls.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import { CatalogSession } from "./catalog-session.ts";
import { ConnectionActions } from "./connection-actions.tsx";
import { navigateConversation } from "./conversation-navigation.ts";
import { ConversationPane } from "./conversation-pane.tsx";
import { CreateDialog } from "./create-dialog.tsx";
import { FilePanel, useWorkAreaWidth } from "./file-panel.tsx";
import { FilePanelController } from "./file-panel-controller.ts";
import { filePanelLabels } from "./file-panel-labels.ts";
import { ModelSettings } from "./model-settings.tsx";
import { workbenchLabels } from "./workbench-labels.ts";
import { WorkbenchWelcome } from "./workbench-welcome.tsx";
import { WorkspaceTree } from "./workspace-tree.tsx";

export function Workbench({ disconnect }: { disconnect: () => void }) {
	const client = useAppClient();
	const { files } = useFiles();
	const session = useMemo(() => (files ? new EditorSession(files) : undefined), [files]);
	useEffect(() => {
		session?.activate();
		return () => session?.dispose();
	}, [session]);
	const [leave, setLeave] = useState<(() => void) | null>(null);
	const guard = (action: () => void) => {
		if (session?.protected) setLeave(() => action);
		else action();
	};
	const searchInputId = useId();
	const local = useLocalState();
	const cache = useQueryClient();
	const catalog = useMemo(() => new CatalogSession(client, local), [client, local]);
	const catalogState = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
	useEffect(() => {
		catalog.activate();
		return () => catalog.dispose();
	}, [catalog]);
	const panel = useMemo(() => new FilePanelController(local), [local]);
	const panelState = useSyncExternalStore(panel.subscribe, panel.snapshot, panel.snapshot);
	const panelTrigger = useRef<HTMLButtonElement>(null);
	const panelId = useId();
	const area = useRef<HTMLElement>(null);
	const areaWidth = useWorkAreaWidth(area);
	const { t, locale, toggleLocale, toggleTheme } = usePreferences();
	const [selectedWorkspace, setSelectedWorkspace] = useState(() => local.read("workspace") ?? "");
	const [selectedConversation, setSelectedConversation] = useState(() => local.read("conversation") ?? "");
	const currentScope = useRef({ workspaceId: selectedWorkspace, conversationId: selectedConversation });
	useEffect(() => {
		currentScope.current = { workspaceId: selectedWorkspace, conversationId: selectedConversation };
	}, [selectedWorkspace, selectedConversation]);
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
	const detailsTrigger = useRef<HTMLButtonElement>(null);
	const detailsReturn = useRef<HTMLButtonElement | null>(null);
	const isExpanded = (id: string) =>
		expanded[id] ??
		(local.read(`workspace-expanded.${id}`) === "true" ||
			(local.read(`workspace-expanded.${id}`) !== "false" && id === selectedWorkspace));
	const setProjectExpanded = (id: string, value: boolean) => {
		setExpanded((current) => ({ ...current, [id]: value }));
		local.write(`workspace-expanded.${id}`, String(value));
	};
	const navigationToggle = useRef<HTMLButtonElement>(null);
	const navigationClose = useRef<HTMLButtonElement>(null);
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
	const [workspaceCursor, setWorkspaceCursor] = useState<string | undefined>();
	const cl = catalogLabels(locale);
	const wl = workbenchLabels(locale);
	const catalogBlocked = catalogState.busy || !!catalogState.pending || catalogState.incompatible;
	const workspaces = useQuery({
		queryKey: ["workspaces", workspaceCursor],
		queryFn: ({ signal }) => client.call("listWorkspaces", workspaceCursor ? { cursor: workspaceCursor } : {}, signal),
		retry: false,
	});
	useEffect(() => {
		if (workspaceCursor && workspaces.error instanceof AppError && workspaces.error.code === "CURSOR_STALE")
			setWorkspaceCursor(undefined);
	}, [workspaceCursor, workspaces.error]);
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
	const selectWorkspace = (id: string) =>
		guard(() => {
			session?.clear();
			setSelectedWorkspace(id);
			if (id) setProjectExpanded(id, true);
			setDetailsOpen(false);
			setSelectedConversation("");
			setNavigationOpen(false);
			setSearch("");
			local.write("workspace", id);
			local.write("conversation", "");
		});
	const selectConversation = (item: Conversation, onSelected?: () => void) => {
		const select = () => {
			cache.setQueryData(["conversation", item.workspaceId, item.conversationId], item);
			if (item.workspaceId !== selectedWorkspace) session?.clear();
			setDetailsOpen(false);
			setProjectExpanded(item.workspaceId, true);
			setSelectedWorkspace(item.workspaceId);
			setSelectedConversation(item.conversationId);
			local.write("workspace", item.workspaceId);
			local.write("conversation", item.conversationId);
			setNavigationOpen(false);
		};
		navigateConversation({ changesWorkspace: item.workspaceId !== selectedWorkspace, guard, select, onSelected });
	};
	const applyCatalogResult = () => {
		const result = catalog.getSnapshot().result;
		if (!result) return;
		if ("conversationId" in result) {
			cache.setQueryData(["conversation", result.workspaceId, result.conversationId], result);
			void cache.invalidateQueries({ queryKey: ["conversations", result.workspaceId] });
			if (catalog.getSnapshot().resultMethod === "createConversation") selectConversation(result);
		} else {
			cache.setQueryData(["workspace", result.workspaceId], result);
			void cache.invalidateQueries({ queryKey: ["workspaces"] });
			selectWorkspace(result.workspaceId);
		}
	};
	const createWorkspace = async (name: string) => {
		await catalog.execute({
			version: PROTOCOL_VERSION,
			method: "createWorkspace",
			params: { workspaceId: crypto.randomUUID(), name },
		});
		if (catalog.getSnapshot().pending || catalog.getSnapshot().failed || catalog.getSnapshot().incompatible)
			throw new Error("UNCONFIRMED");
		applyCatalogResult();
	};
	const createConversation = async (workspaceId: string, title: string, model?: ModelReference) => {
		await catalog.execute({
			version: PROTOCOL_VERSION,
			method: "createConversation",
			params: { workspaceId, requestId: crypto.randomUUID(), title, ...(model ? { model } : {}) },
		});
		if (catalog.getSnapshot().pending || catalog.getSnapshot().failed || catalog.getSnapshot().incompatible)
			throw new Error("UNCONFIRMED");
		applyCatalogResult();
	};

	return (
		<div className="work-shell" data-navigation-open={navigationOpen} data-navigation-collapsed={navigationCollapsed}>
			<aside
				className="sidebar"
				id="work-navigation"
				aria-label={t("nav.workspaces")}
				inert={narrow ? !navigationOpen : navigationCollapsed}
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
						className="sidebar-collapse"
						variant="ghost"
						size="icon-sm"
						aria-label={wl["workbench.hideNavigation"]}
						title={wl["workbench.hideNavigation"]}
						onClick={() => {
							setNavigationCollapsed(true);
							navigationToggle.current?.focus();
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
						{workspace ? (
							<CreateDialog
								disabled={catalogBlocked}
								kind="conversation"
								onCreate={(title, model) => createConversation(selectedWorkspace, title, model)}
							/>
						) : (
							<CreateDialog disabled={catalogBlocked} kind="workspace" onCreate={createWorkspace} />
						)}
					</div>
					<label className="sr-only" htmlFor={searchInputId}>
						{t("nav.search")}
					</label>
					<InputGroup className="nav-search">
						<InputGroupInput
							className="text-[13px]"
							id={searchInputId}
							placeholder={t("nav.search")}
							aria-describedby={`${searchInputId}-scope`}
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
						<InputGroupAddon>
							<Icon name="search" />
						</InputGroupAddon>
						<InputGroupAddon align="inline-end">
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={cl.searchScopeLabel}
											aria-describedby={`${searchInputId}-scope`}
										>
											<Icon name="info" size={14} />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="right" className="max-w-64">
										{cl.searchScope}
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						</InputGroupAddon>
					</InputGroup>
					<p className="sr-only" id={`${searchInputId}-scope`}>
						{cl.searchScope}
					</p>
					<div className="nav-section-heading">
						<span>{t("nav.workspaces")}</span>
						{workspace && (
							<CreateDialog disabled={catalogBlocked} kind="workspace" compact onCreate={createWorkspace} />
						)}
					</div>
					<div className="navigation-list">
						{workspaces.isPending && <output className="nav-feedback">{t("common.loading")}</output>}
						{workspaces.isError && (
							<div className="nav-feedback" role="alert">
								<p>
									{t(
										workspaces.error instanceof AppError && workspaces.error.code === "STORE_MISMATCH"
											? "connection.storeMismatch"
											: "nav.loadError",
									)}
								</p>
								<Button variant="outline" size="sm" onClick={() => void workspaces.refetch()}>
									<Icon name="refresh" size={14} />
									{t("nav.refresh")}
								</Button>
							</div>
						)}
						{workspaces.isSuccess && workspaces.data.items.length === 0 && (
							<p className="nav-feedback">{t("nav.noWorkspaces")}</p>
						)}
						<WorkspaceTree
							workspaces={workspaces.data?.items ?? []}
							catalog={catalog}
							guard={guard}
							selectedWorkspace={selectedWorkspace}
							selectedConversation={selectedConversation}
							search={search}
							isExpanded={isExpanded}
							onToggle={(id) => {
								if (id !== selectedWorkspace) selectWorkspace(id);
								else setProjectExpanded(id, !isExpanded(id));
							}}
							onSelect={selectConversation}
							onCreate={createConversation}
							onDetails={(item, returnFocus) => {
								selectConversation(item, () => {
									detailsReturn.current = returnFocus;
									setDetailsOpen(true);
								});
							}}
						/>
						{!!(workspaceCursor || workspaces.data?.nextCursor) && (
							<div className="flex gap-1">
								<Button
									size="sm"
									variant="ghost"
									disabled={workspaces.isFetching || !workspaceCursor}
									onClick={() => setWorkspaceCursor(undefined)}
								>
									{cl.first}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={workspaces.isFetching || !workspaces.data?.nextCursor}
									onClick={() => {
										if (workspaces.data?.nextCursor) setWorkspaceCursor(workspaces.data.nextCursor);
									}}
								>
									{cl.next}
								</Button>
							</div>
						)}
						<CatalogRecovery session={catalog} onResolved={applyCatalogResult} />
					</div>
				</section>
				<div className="sidebar-footer">
					<Popover>
						<PopoverTrigger asChild>
							<Button variant="ghost" className="runtime-menu-trigger" aria-label={wl["workbench.runtimeControls"]}>
								<span className="runtime-label">
									<span className="status-dot" />
									{t("app.localRuntime")}
								</span>
								<ChevronUp size={14} aria-hidden="true" />
							</Button>
						</PopoverTrigger>
						<PopoverContent
							className="runtime-menu"
							side="top"
							align="start"
							aria-label={wl["workbench.runtimeControls"]}
							onInteractOutside={(event) => {
								if (document.querySelector('[data-slot="dialog-content"]')) event.preventDefault();
							}}
						>
							<p className="eyebrow">{wl["workbench.runtimeControls"]}</p>
							<ConnectionActions
								disconnect={() => guard(disconnect)}
								onOpen={(opened, item) => {
									cache.setQueryData(["workspace", opened.workspaceId], opened);
									selectConversation(item);
								}}
							/>
						</PopoverContent>
					</Popover>
				</div>
			</aside>
			<div className="main-shell" inert={navigationOpen}>
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
								else setNavigationCollapsed((value) => !value);
							}}
						>
							<Icon name="panel" />
						</Button>
						<Icon name="folder" size={15} />
						<span>{workspace?.name ?? t("app.workspace")}</span>
						{selected && (
							<>
								<Icon name="chevron" size={12} />
								<span className="toolbar-conversation">{selected.title}</span>
							</>
						)}
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
						{selected && <ConversationActions conversation={selected} session={catalog} guard={guard} />}
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
						<Popover>
							<PopoverTrigger asChild>
								<Button variant="ghost" size="icon" aria-label={cl.settings}>
									<Settings size={18} aria-hidden="true" />
								</Button>
							</PopoverTrigger>
							<PopoverContent
								align="end"
								className="workbench-settings"
								aria-label={cl.settings}
								onInteractOutside={(event) => {
									// Dialogs and their portalled selects must not unmount with their settings entry.
									if (document.querySelector('[data-slot="dialog-content"]')) event.preventDefault();
								}}
							>
								{workspace && (
									<ToolPacksDialog
										key={
											selected
												? `${workspace.workspaceId}.conversation.${selected.conversationId}`
												: `${workspace.workspaceId}.workspace`
										}
										workspaceId={workspace.workspaceId}
										conversation={selected}
									/>
								)}
								<AppearanceSettings />
								<ModelSettings />
								<Button variant="ghost" size="sm" onClick={toggleLocale} aria-label={t("settings.language")}>
									中 / EN
								</Button>
								<Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={t("settings.theme")}>
									<Icon name="sun" />
								</Button>
							</PopoverContent>
						</Popover>
					</div>
				</header>
				{panelState.storageFailed && (
					<output className="file-panel-storage">{filePanelLabels(locale)["filePanel.storageFailed"]}</output>
				)}
				<main className="work-area" ref={area}>
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
					{selected ? (
						<ConversationPane
							key={`${selected.workspaceId}.${selected.conversationId}`}
							conversation={selected}
							onOpenArtifact={
								session ? artifactNavigation(selected, () => currentScope.current, guard, session, panel) : undefined
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
								workspace ? (
									<CreateDialog
										kind="conversation"
										disabled={catalogBlocked}
										onCreate={(title, model) => createConversation(selectedWorkspace, title, model)}
									/>
								) : (
									<CreateDialog disabled={catalogBlocked} kind="workspace" onCreate={createWorkspace} />
								)
							}
						/>
					)}
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
