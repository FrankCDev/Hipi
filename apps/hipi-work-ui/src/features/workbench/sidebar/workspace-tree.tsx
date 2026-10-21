import {
	AppError,
	type Conversation,
	type Project,
	type ProjectListItem,
	type Workspace,
} from "@hipi/work-runtime/contracts";
import { Archive, MessageCircle } from "lucide-react";
import { type ComponentPropsWithRef, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { useReducedMotionPreference } from "../../../app/theme/use-reduced-motion.ts";
import {
	ActionMenu,
	ActionMenuContent,
	ActionMenuItem,
	ActionMenuRadioGroup,
	ActionMenuRadioItem,
	ActionMenuSeparator,
	ActionMenuTrigger,
} from "../../../components/ui/action-menu.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { DisclosureSurface } from "../../../components/ui/disclosure-surface.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { ConversationActions } from "../catalog/controls.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import { CatalogPagination } from "../catalog/pagination.tsx";
import type { CatalogSession } from "../catalog/session.ts";
import { type ProjectPinNotice, useProjectActionOwner } from "../projects/action-owner.ts";
import { ProjectActions } from "../projects/actions.tsx";
import { projectFolderLabels } from "../projects/folder-labels.ts";
import { projectLabels } from "../projects/labels.ts";
import { SidebarActionTooltip } from "./action-tooltip.tsx";
import { SidebarBranchAvailability, useBranchFocus } from "./branch-availability.tsx";
import { ConversationPreview } from "./conversation-preview.tsx";
import type { SidebarOrderAction } from "./drag-provider.tsx";
import { SidebarIcon } from "./icon.tsx";
import type { PresentationSession } from "./presentation-session.ts";
import { type PreviewActions, SidebarPreviewRow } from "./preview-row.tsx";
import { ProjectPreviewCard } from "./project-preview-card.tsx";
import { RecentConversations } from "./recent-conversations.tsx";
import { SidebarSectionContent, SidebarSectionHeading, useSidebarSection } from "./section.tsx";
import type { SidebarLocation } from "./selection-owner.ts";
import { SidebarTitle } from "./title.tsx";
import { useNavigation } from "./use-navigation.ts";
import "./layout.css";
import "./action-menu.css";

type TreeProps = {
	onProjectPinNotice?: (notice: ProjectPinNotice) => void;
	recentWindow?: boolean;
	navigationVisible?: boolean;
	recentLast?: boolean;
	scrollRef?: RefObject<HTMLElement | null>;
	catalog: CatalogSession;
	presentation?: PresentationSession;
	guard: (action: () => void) => void;
	workspaces: Workspace[];
	projects?: ProjectListItem[];
	logicalReady?: boolean;
	projectPinEnabled?: boolean;
	projectDataUpdatedAt?: number;
	pinnedProject?: boolean;
	selectedProjectId?: string | null;
	onManageLogicalProjectFolder?: (project: Project, restoreFocus?: () => void) => void;
	logicalProjectOrder?: (item: ProjectListItem) => SidebarOrderAction | undefined;
	defaultWorkspaceId?: string | null;
	selectedWorkspace: string;
	selectedConversation: string;
	isExpanded: (id: string) => boolean;
	onToggle: (id: string) => void;
	onOpenProject: (id: string) => void;
	onSelect: (conversation: Conversation, location?: SidebarLocation) => void;
	onNewConversation: (id: string) => void;
	onManageProjectFolder?: (workspace: Workspace, restoreFocus?: () => void) => void;
	section?: "projects" | "recent";
	projectOrder?: (workspace: Workspace) => SidebarOrderAction;
	filterFor?: (id: string) => "active" | "archived";
	onFilterChange?: (id: string, filter: "active" | "archived") => void;
};

/** Each expanded branch shows a bounded catalog window, never execution streams. */
export function WorkspaceTree(props: TreeProps) {
	const { t } = usePreferences();
	return (
		<nav
			aria-label={t("nav.workspaces")}
			data-project-query={
				props.section === "projects" && props.projects !== undefined ? JSON.stringify(["projects", "pages"]) : undefined
			}
			data-project-updated-at={props.section === "projects" ? props.projectDataUpdatedAt : undefined}
		>
			<ul className="workspace-tree">
				{props.projects !== undefined
					? props.section !== "recent" &&
						props.projects.map((item) => <WorkspaceBranch key={item.project.projectId} {...props} projectItem={item} />)
					: props.workspaces
							.filter((workspace) => props.section !== "recent" && workspace.workspaceId !== props.defaultWorkspaceId)
							.map((workspace) => <WorkspaceBranch key={workspace.workspaceId} {...props} workspace={workspace} />)}

				{props.section !== "projects" &&
					(props.recentWindow ? <RecentBranch key="recent" {...props} /> : <WorkspaceBranch key="recent" {...props} />)}
			</ul>
		</nav>
	);
}

function RecentBranch(props: TreeProps) {
	const [filter, setFilter] = useState<"active" | "archived">("active");
	const { locale } = usePreferences();
	return (
		<RecentConversations
			key={`${props.logicalReady !== false}:${filter}`}
			catalog={props.catalog}
			presentation={props.presentation}
			onSelect={(conversation) => props.onSelect(conversation, { kind: "recent" })}
			selected={
				props.selectedConversation
					? { workspaceId: props.selectedWorkspace, conversationId: props.selectedConversation }
					: undefined
			}
			logicalReady={props.logicalReady !== false}
			visible={props.navigationVisible}
			last={props.recentLast}
			scrollRef={props.scrollRef}
			filter={filter}
			filterMenu={
				<ProjectConversationMenu name={catalogLabels(locale).recent} filter={filter} onFilterChange={setFilter} />
			}
		/>
	);
}

export function WorkspaceBranch({
	workspace,
	projectItem,
	...props
}: TreeProps & { workspace?: Workspace; projectItem?: ProjectListItem }) {
	const sectionCollapsed = useSidebarSection()?.collapsed ?? false;
	const { t, locale } = usePreferences();
	const regionId = useId();
	const headingId = useId();
	const disclosureId = useId();
	const openId = useId();
	const recent = workspace === undefined && projectItem === undefined;
	const logicalReady = props.projects !== undefined && props.logicalReady !== false;
	const projectOwner = useProjectActionOwner(
		projectItem,
		props.catalog,
		props.guard,
		props.projectPinEnabled,
		logicalReady,
		props.onProjectPinNotice,
	);
	const fenced = !!projectItem && !logicalReady;
	const branchId = projectItem?.project.projectId ?? workspace?.workspaceId ?? "";
	const branchName = projectItem?.project.name ?? workspace?.name ?? "";
	const homeWorkspaceId = projectItem?.project.homeWorkspaceId ?? workspace?.workspaceId ?? "";
	const metadata = projectItem ? { project: projectItem.project } : workspace ? { workspace } : null;
	const location: SidebarLocation = recent
		? { kind: "recent" }
		: projectItem
			? { kind: "project", projectId: projectItem.project.projectId }
			: { kind: "workspace", workspaceId: homeWorkspaceId };
	const orderAction = projectItem
		? props.logicalProjectOrder?.(projectItem)
		: workspace
			? props.projectOrder?.(workspace)
			: undefined;
	const expanded = recent || props.isExpanded(branchId);
	const region = useRef<HTMLElement>(null);
	const heading = useRef<HTMLButtonElement>(null);
	const branchFocus = useBranchFocus(!expanded, heading);
	const reduced = useReducedMotionPreference();
	const focusedRow = useRef<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (sectionCollapsed || !expanded) {
			focusedRow.current = null;
			return;
		}
		const previous = focusedRow.current;
		if (!previous || previous.isConnected || document.activeElement !== document.body) return;
		focusedRow.current = null;
		// A successful archive/restore can remove the row after a delayed catalog refresh.
		// Restore from the actual DOM commit, never an estimated number of animation frames.
		region.current?.focus({ preventScroll: true });
	});
	const [localFilter, setLocalFilter] = useState<"active" | "archived">("active");
	const filter = (!recent ? props.filterFor?.(branchId) : undefined) ?? localFilter;
	const setFilter = (value: "active" | "archived") => {
		if (!recent && props.onFilterChange) props.onFilterChange(branchId, value);
		else setLocalFilter(value);
	};
	const cl = catalogLabels(locale);
	const conversations = useNavigation(
		recent
			? { kind: logicalReady ? "project_recent" : "recent" }
			: projectItem
				? { kind: "project", projectId: projectItem.project.projectId }
				: { kind: "workspace", workspaceId: homeWorkspaceId },
		filter,
		expanded && !sectionCollapsed && !fenced,
		() => {
			const focused = focusedRow.current?.closest<HTMLElement>("[data-workspace-id][data-conversation-id]");
			return [
				...(props.selectedConversation
					? [{ workspaceId: props.selectedWorkspace, conversationId: props.selectedConversation }]
					: []),
				...(focused?.dataset.workspaceId && focused.dataset.conversationId
					? [{ workspaceId: focused.dataset.workspaceId, conversationId: focused.dataset.conversationId }]
					: []),
			];
		},
	);
	const containsCurrent =
		!recent &&
		(projectItem ? props.selectedProjectId === branchId : props.selectedWorkspace === branchId) &&
		!!props.selectedConversation;
	const current =
		!recent &&
		(projectItem ? props.selectedProjectId === branchId : props.selectedWorkspace === branchId) &&
		!props.selectedConversation;
	const regionProps: ComponentPropsWithRef<"section"> = {
		ref: region,
		id: regionId,
		"aria-labelledby": headingId,
		className: "project-conversations",
		tabIndex: -1,
		"aria-busy": expanded && conversations.isFetching,
		onBlurCapture: branchFocus.onBlurCapture,
		onFocusCapture: (event) => {
			branchFocus.onFocusCapture(event);
			if (event.currentTarget.contains(event.target) && event.target.closest(".conversation-preview-row"))
				focusedRow.current = event.target;
		},
	};
	const queryAttributes = {
		"data-sidebar-query": conversations.queryIdentity,
		"data-sidebar-updated-at": conversations.dataUpdatedAt,
		"data-sidebar-fetching": conversations.isFetching,
	};
	const conversationsBody = (
		<>
			{fenced ? (
				<output className="nav-feedback">{cl.refreshing}</output>
			) : (
				<>
					{filter === "archived" && <p className="project-archive-label">{cl.archived}</p>}
					{(conversations.isPending || conversations.coverage?.state === "building") && (
						<output className="nav-feedback">{t("common.loading")}</output>
					)}
					{conversations.hasData &&
						conversations.coverage?.state !== "building" &&
						(conversations.isFetching || conversations.coverage?.state === "refreshing") &&
						!conversations.isLoadingMore && (
							<output className="sr-only" aria-live="off">
								{cl.refreshing}
							</output>
						)}
					{conversations.isError && (
						<div className="nav-feedback" role="alert">
							<p>
								{conversations.error instanceof AppError && conversations.error.code === "STORE_MISMATCH"
									? t("connection.storeMismatch")
									: conversations.staleCursor
										? cl.staleList
										: conversations.isLoadMoreError
											? cl.loadMoreFailed
											: conversations.hasData
												? cl.refreshFailed
												: t("nav.loadError")}
							</p>
							<Button
								variant="outline"
								size="sm"
								disabled={conversations.isFetching}
								onClick={() => void conversations.retry()}
							>
								<Icon name="refresh" size={14} />
								{t("nav.refresh")}
							</Button>
						</div>
					)}
					<ul className="conversation-list">
						{conversations.items.map((conversation) => (
							<li
								key={JSON.stringify([conversation.workspaceId, conversation.conversationId])}
								className="conversation-nav-item"
								data-catalog-key={JSON.stringify([conversation.workspaceId, conversation.conversationId])}
							>
								<ConversationPreview
									conversation={conversation}
									projectId={
										logicalReady
											? (conversations.memberships?.get(
													JSON.stringify([conversation.workspaceId, conversation.conversationId]),
												)?.projectId ?? null)
											: undefined
									}
									workspaceName={recent ? undefined : branchName}
									location={location}
									onSelect={() => props.onSelect(conversation, location)}
									renderActions={
										fenced
											? undefined
											: (controls) => (
													<ConversationActions
														conversation={conversation}
														session={props.catalog}
														presentation={props.presentation}
														guard={props.guard}
														{...controls}
													/>
												)
									}
								/>
							</li>
						))}
					</ul>
					{conversations.isEmpty && (
						<div className="nav-feedback nav-empty-state">
							<p>{filter === "archived" ? cl.emptyArchived : t("nav.empty")}</p>
						</div>
					)}
					<CatalogPagination pages={conversations} listRef={region} />
				</>
			)}
		</>
	);
	const conversationsContent = recent ? (
		<section {...regionProps} {...queryAttributes}>
			{conversationsBody}
		</section>
	) : (
		<DisclosureSurface {...regionProps} {...queryAttributes} expanded={expanded} reduced={reduced}>
			{conversationsBody}
		</DisclosureSurface>
	);
	return (
		<li
			className={`workspace-branch${recent ? " recent-conversations" : ""}`}
			data-workspace-id={recent ? undefined : homeWorkspaceId}
			data-project-id={projectItem?.project.projectId}
			data-catalog-key={
				projectItem
					? props.pinnedProject
						? JSON.stringify(["project", projectItem.project.projectId])
						: projectItem.project.projectId
					: undefined
			}
			data-pinned-project={props.pinnedProject ? "" : undefined}
			data-current={current}
			data-contains-current={containsCurrent}
		>
			{recent ? (
				<div className="recent-conversations-heading">
					<SidebarSectionHeading
						titleId={headingId}
						actions={<ProjectConversationMenu name={cl.recent} filter={filter} onFilterChange={setFilter} />}
					>
						{props.projects !== undefined && !logicalReady ? projectLabels(locale).legacyHistory : cl.recent}
					</SidebarSectionHeading>
				</div>
			) : (
				<SidebarPreviewRow
					className="project-row"
					selected={current}
					containsCurrent={containsCurrent}
					titleId={headingId}
					orderAction={fenced ? undefined : orderAction}
					menuPreview={
						!fenced && metadata && <ProjectPreviewCard {...metadata} logicalReady={logicalReady} mode="menu" />
					}
					preview={(preview) =>
						!fenced && metadata ? (
							<ProjectPreviewCard
								owner={projectOwner}
								logicalReady={logicalReady}
								{...metadata}
								onManageFolder={
									(projectItem ? props.onManageLogicalProjectFolder : props.onManageProjectFolder)
										? () => {
												preview.close();
												if (projectItem) props.onManageLogicalProjectFolder?.(projectItem.project, preview.returnFocus);
												else if (workspace) props.onManageProjectFolder?.(workspace, preview.returnFocus);
											}
										: undefined
								}
							/>
						) : null
					}
					renderActions={
						fenced
							? undefined
							: (controls) => (
									<div className="sidebar-row-actions" data-preview-immediate="">
										{projectItem ? (
											<ProjectActions
												item={projectItem}
												owner={projectOwner}
												controls={controls}
												filter={filter}
												onFilterChange={(value) => {
													setFilter(value);
													if (!expanded) props.onToggle(branchId);
												}}
												onManageFolder={
													props.onManageLogicalProjectFolder
														? () => {
																controls.onOverlayChange("dialog", true);
																props.onManageLogicalProjectFolder?.(projectItem.project, () => {
																	controls.onOverlayChange("dialog", false);
																	controls.onReturnFocus("dialog");
																});
															}
														: undefined
												}
											/>
										) : (
											<ProjectConversationMenu
												name={branchName}
												filter={filter}
												controls={controls}
												onManageFolder={
													props.onManageProjectFolder
														? () => {
																controls.onOverlayChange("dialog", true);
																if (workspace)
																	props.onManageProjectFolder?.(workspace, () => {
																		controls.onOverlayChange("dialog", false);
																		controls.onReturnFocus("dialog");
																	});
															}
														: undefined
												}
												onFilterChange={(value) => {
													setFilter(value);
													if (!expanded) props.onToggle(branchId);
												}}
											/>
										)}
										<SidebarActionTooltip label={t("nav.newConversation")}>
											<Button
												variant="ghost"
												size="icon-sm"
												className="project-new-conversation"
												aria-label={`${t("nav.newConversation")}: ${branchName}`}
												onClick={() => props.onNewConversation(branchId)}
											>
												<SidebarIcon name="newChat" />
											</Button>
										</SidebarActionTooltip>
									</div>
								)
					}
				>
					{({ hovered, describedBy }) => (
						<>
							<SidebarActionTooltip label={expanded ? cl.collapseProject : cl.expandProject}>
								<button
									type="button"
									ref={heading}
									className="project-toggle"
									aria-expanded={expanded}
									aria-controls={regionId}
									aria-labelledby={`${disclosureId} ${headingId}`}
									onClick={() => props.onToggle(branchId)}
								>
									<span id={disclosureId} className="sr-only">
										{expanded ? cl.collapseProject : cl.expandProject}
									</span>
									<span className="project-icon" aria-hidden="true">
										<SidebarIcon name={expanded ? "folderOpen" : "folder"} />
									</span>
									<span className="project-chevron" data-expanded={expanded} aria-hidden="true">
										<SidebarIcon name="disclosure" />
									</span>
								</button>
							</SidebarActionTooltip>
							<button
								type="button"
								className="project-open"
								data-sidebar-cycle-item=""
								disabled={fenced}
								aria-describedby={describedBy}
								aria-current={current ? "page" : undefined}
								aria-labelledby={`${openId} ${headingId}`}
								onClick={() => {
									if (!fenced) props.onOpenProject(branchId);
								}}
							>
								<span id={openId} className="sr-only">
									{cl.openProject}
								</span>
								<SidebarTitle id={headingId} className="project-name" text={branchName} hovered={hovered} />
							</button>
						</>
					)}
				</SidebarPreviewRow>
			)}
			{recent ? (
				<SidebarSectionContent>{conversationsContent}</SidebarSectionContent>
			) : (
				<SidebarBranchAvailability.Provider value={{ collapsed: !expanded, heading }}>
					{conversationsContent}
				</SidebarBranchAvailability.Provider>
			)}
		</li>
	);
}

function ProjectConversationMenu({
	name,
	filter,
	onFilterChange,
	controls,
	onManageFolder,
}: {
	name: string;
	filter: "active" | "archived";
	onFilterChange: (filter: "active" | "archived") => void;
	controls?: Parameters<PreviewActions>[0];
	onManageFolder?: () => void;
}) {
	const { locale } = usePreferences();
	const cl = catalogLabels(locale);
	const [standaloneOpen, setStandaloneOpen] = useState(false);
	const open = controls?.rowMenu?.open ?? standaloneOpen;
	const setOpen = (open: boolean) => {
		if (controls?.rowMenu) controls.rowMenu.onOpenChange(controls.rowMenu.entry, open);
		else setStandaloneOpen(open);
	};
	useLayoutEffect(() => {
		if (controls?.rowMenu || !controls?.hidden || !open) return;
		setStandaloneOpen(false);
		controls.onOverlayChange("menu", false);
	}, [controls, open]);
	return (
		<ActionMenu
			boundary={controls?.rowMenu}
			open={open && !controls?.hidden}
			onOpenChange={(open) => {
				setOpen(open);
				controls?.onOverlayChange("menu", open);
				if (open) controls?.onMenuOpen();
			}}
		>
			<SidebarActionTooltip label={controls ? cl.projectActions : cl.filter} disabled={open}>
				<ActionMenuTrigger asChild>
					<Button
						ref={controls?.triggerRef}
						variant="ghost"
						size="icon-sm"
						className={controls ? "project-actions-trigger" : "recent-actions-trigger"}
						aria-label={`${controls ? cl.projectActions : cl.filter}: ${name}`}
					>
						<SidebarIcon name="more" />
					</Button>
				</ActionMenuTrigger>
			</SidebarActionTooltip>
			<ActionMenuContent
				side="bottom"
				align="start"
				sideOffset={1}
				alignOffset={0}
				collisionPadding={6}
				className="project-action-menu"
				data-sidebar-row-portal={controls ? "" : undefined}
				onCloseAutoFocus={(event) => {
					if (!controls) return;
					event.preventDefault();
					controls.onReturnFocus();
				}}
			>
				{onManageFolder && (
					<>
						<ActionMenuItem onSelect={onManageFolder}>
							<SidebarIcon name="folder" />
							{projectFolderLabels(locale).title}
						</ActionMenuItem>
						<ActionMenuSeparator />
					</>
				)}
				<ActionMenuRadioGroup
					aria-label={cl.filter}
					value={filter}
					onValueChange={(value) => {
						if (value === "active" || value === "archived") onFilterChange(value);
					}}
				>
					<ActionMenuRadioItem value="active">
						<MessageCircle size={16} aria-hidden="true" />
						{cl.active}
					</ActionMenuRadioItem>
					<ActionMenuRadioItem value="archived">
						<Archive size={16} aria-hidden="true" />
						{cl.archived}
					</ActionMenuRadioItem>
				</ActionMenuRadioGroup>
			</ActionMenuContent>
		</ActionMenu>
	);
}
