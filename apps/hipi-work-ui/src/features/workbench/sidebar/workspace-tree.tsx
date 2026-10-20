import { AppError, type Conversation, type Workspace } from "@hipi/work-runtime/contracts";
import { Archive, Ellipsis, MessageCircle, SquarePen } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { ConversationActions } from "../catalog/controls.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import { CatalogPagination } from "../catalog/pagination.tsx";
import type { CatalogSession } from "../catalog/session.ts";
import { useCatalogPages } from "../catalog/use-pages.ts";
import { projectFolderLabels } from "../projects/folder-labels.ts";
import { ConversationPreview } from "./conversation-preview.tsx";
import type { SidebarOrderAction } from "./drag-provider.tsx";
import type { PresentationSession } from "./presentation-session.ts";
import { type PreviewActions, SidebarPreviewRow } from "./preview-row.tsx";
import { ProjectPreviewCard } from "./project-preview-card.tsx";
import { SidebarSectionContent, SidebarSectionHeading, useSidebarSection } from "./section.tsx";
import { SidebarTitle } from "./title.tsx";
import "./layout.css";

type TreeProps = {
	catalog: CatalogSession;
	presentation?: PresentationSession;
	guard: (action: () => void) => void;
	workspaces: Workspace[];
	defaultWorkspaceId?: string | null;
	selectedWorkspace: string;
	selectedConversation: string;
	isExpanded: (id: string) => boolean;
	onToggle: (id: string) => void;
	onOpenProject: (id: string) => void;
	onSelect: (conversation: Conversation) => void;
	onNewConversation: (workspaceId: string) => void;
	onManageProjectFolder?: (workspace: Workspace, restoreFocus?: () => void) => void;
	section?: "projects" | "recent";
	projectOrder?: (workspace: Workspace) => SidebarOrderAction;
	filterFor?: (workspaceId: string) => "active" | "archived";
	onFilterChange?: (workspaceId: string, filter: "active" | "archived") => void;
};

/** Each expanded branch shows a bounded catalog window, never execution streams. */
export function WorkspaceTree(props: TreeProps) {
	const { t, locale } = usePreferences();
	const recent = props.defaultWorkspaceId
		? (props.workspaces.find((workspace) => workspace.workspaceId === props.defaultWorkspaceId) ?? {
				workspaceId: props.defaultWorkspaceId,
				name: catalogLabels(locale).recent,
			})
		: undefined;
	return (
		<nav aria-label={t("nav.workspaces")}>
			<ul className="workspace-tree">
				{props.workspaces
					.filter((workspace) => props.section !== "recent" && workspace.workspaceId !== props.defaultWorkspaceId)
					.map((workspace) => (
						<WorkspaceBranch key={workspace.workspaceId} {...props} workspace={workspace} />
					))}
				{recent && props.section !== "projects" && (
					<WorkspaceBranch key={recent.workspaceId} {...props} workspace={recent} />
				)}
			</ul>
		</nav>
	);
}

function WorkspaceBranch({ workspace, ...props }: TreeProps & { workspace: Workspace }) {
	const sectionCollapsed = useSidebarSection()?.collapsed ?? false;
	const client = useAppClient();
	const { t, locale } = usePreferences();
	const regionId = useId();
	const headingId = useId();
	const disclosureId = useId();
	const openId = useId();
	const recent = workspace.workspaceId === props.defaultWorkspaceId;
	const orderAction = recent ? undefined : props.projectOrder?.(workspace);
	const expanded = recent || props.isExpanded(workspace.workspaceId);
	const region = useRef<HTMLElement>(null);
	const focusedRow = useRef<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (sectionCollapsed) {
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
	const filter = props.filterFor?.(workspace.workspaceId) ?? localFilter;
	const setFilter = (value: "active" | "archived") => {
		if (props.onFilterChange) props.onFilterChange(workspace.workspaceId, value);
		else setLocalFilter(value);
	};
	const cl = catalogLabels(locale);
	const conversations = useCatalogPages({
		queryKey: ["conversations", workspace.workspaceId, filter],
		itemKey: (item: Conversation) => item.conversationId,
		queryPage: (cursor, signal) =>
			client.call(
				"listConversations",
				{ workspaceId: workspace.workspaceId, filter, ...(cursor ? { cursor } : {}) },
				signal,
			),
		enabled: expanded,
	});
	const containsCurrent = props.selectedWorkspace === workspace.workspaceId && !!props.selectedConversation;
	const current = props.selectedWorkspace === workspace.workspaceId && !props.selectedConversation;
	const conversationsContent = (
		<section
			ref={region}
			id={regionId}
			aria-labelledby={headingId}
			hidden={!expanded}
			className="project-conversations"
			tabIndex={-1}
			aria-busy={expanded && conversations.isFetching}
			onFocusCapture={(event) => {
				if (event.currentTarget.contains(event.target) && event.target.closest(".conversation-preview-row"))
					focusedRow.current = event.target;
			}}
		>
			{filter === "archived" && <p className="project-archive-label">{cl.archived}</p>}
			{expanded && conversations.isPending && <output className="nav-feedback">{t("common.loading")}</output>}
			{expanded && conversations.hasData && conversations.isFetching && !conversations.isLoadingMore && (
				<output className="nav-feedback catalog-refresh-status">{cl.refreshing}</output>
			)}
			{expanded && conversations.isError && (
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
			{expanded && (
				<ul className="conversation-list">
					{conversations.items.map((conversation) => (
						<li key={conversation.conversationId} className="conversation-nav-item">
							<ConversationPreview
								conversation={conversation}
								workspaceName={recent ? undefined : workspace.name}
								selected={
									props.selectedWorkspace === workspace.workspaceId &&
									props.selectedConversation === conversation.conversationId
								}
								onSelect={() => props.onSelect(conversation)}
								renderActions={(controls) => (
									<ConversationActions
										conversation={conversation}
										session={props.catalog}
										presentation={props.presentation}
										guard={props.guard}
										{...controls}
									/>
								)}
							/>
						</li>
					))}
				</ul>
			)}
			{expanded && conversations.isSuccess && conversations.items.length === 0 && (
				<div className="nav-feedback nav-empty-state">
					<p>{filter === "archived" ? cl.emptyArchived : t("nav.empty")}</p>
				</div>
			)}
			{expanded && <CatalogPagination pages={conversations} listRef={region} />}
		</section>
	);
	return (
		<li
			className={`workspace-branch${recent ? " recent-conversations" : ""}`}
			data-workspace-id={workspace.workspaceId}
			data-current={current}
			data-contains-current={containsCurrent}
		>
			{recent ? (
				<div className="recent-conversations-heading">
					<SidebarSectionHeading
						titleId={headingId}
						actions={<ProjectConversationMenu name={cl.recent} filter={filter} onFilterChange={setFilter} />}
					>
						{cl.recent}
					</SidebarSectionHeading>
				</div>
			) : (
				<SidebarPreviewRow
					className="project-row"
					selected={current}
					containsCurrent={containsCurrent}
					titleId={headingId}
					orderAction={orderAction}
					menuPreview={<ProjectPreviewCard workspace={workspace} mode="menu" />}
					preview={(preview) => (
						<ProjectPreviewCard
							workspace={workspace}
							onManageFolder={
								props.onManageProjectFolder
									? () => {
											preview.close();
											props.onManageProjectFolder?.(workspace, preview.returnFocus);
										}
									: undefined
							}
						/>
					)}
					renderActions={(controls) => (
						<div className="sidebar-row-actions" data-preview-immediate="">
							<ProjectConversationMenu
								name={workspace.name}
								filter={filter}
								controls={controls}
								onManageFolder={
									props.onManageProjectFolder
										? () => props.onManageProjectFolder?.(workspace, () => controls.onReturnFocus("dialog"))
										: undefined
								}
								onFilterChange={(value) => {
									setFilter(value);
									if (!expanded) props.onToggle(workspace.workspaceId);
								}}
							/>
							<Button
								variant="ghost"
								size="icon-sm"
								className="project-new-conversation"
								aria-label={`${t("nav.newConversation")}: ${workspace.name}`}
								title={t("nav.newConversation")}
								onClick={() => props.onNewConversation(workspace.workspaceId)}
							>
								<SquarePen size={16} aria-hidden="true" />
							</Button>
						</div>
					)}
				>
					{({ hovered, describedBy }) => (
						<>
							<button
								type="button"
								className="project-toggle"
								aria-expanded={expanded}
								aria-controls={regionId}
								aria-labelledby={`${disclosureId} ${headingId}`}
								title={expanded ? cl.collapseProject : cl.expandProject}
								onClick={() => props.onToggle(workspace.workspaceId)}
							>
								<span id={disclosureId} className="sr-only">
									{expanded ? cl.collapseProject : cl.expandProject}
								</span>
								<span className="project-chevron" data-expanded={expanded}>
									<Icon name="chevron" size={12} />
								</span>
							</button>
							<button
								type="button"
								className="project-open"
								aria-describedby={describedBy}
								aria-current={current ? "page" : undefined}
								aria-labelledby={`${openId} ${headingId}`}
								title={cl.openProject}
								onClick={() => props.onOpenProject(workspace.workspaceId)}
							>
								<span id={openId} className="sr-only">
									{cl.openProject}
								</span>
								<span className="project-icon">
									<Icon name="folder" size={16} />
								</span>
								<SidebarTitle id={headingId} className="project-name" text={workspace.name} hovered={hovered} />
							</button>
						</>
					)}
				</SidebarPreviewRow>
			)}
			{recent ? <SidebarSectionContent>{conversationsContent}</SidebarSectionContent> : conversationsContent}
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
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		if (!controls?.hidden || !open) return;
		setOpen(false);
		controls.onOverlayChange("menu", false);
	}, [controls, open]);
	return (
		<DropdownMenu
			open={open && !controls?.hidden}
			onOpenChange={(open) => {
				setOpen(open);
				controls?.onOverlayChange("menu", open);
				if (open) controls?.onMenuOpen();
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button
					ref={controls?.triggerRef}
					variant="ghost"
					size="icon-sm"
					className={controls ? "project-actions-trigger" : "recent-actions-trigger"}
					aria-label={`${controls ? cl.projectActions : cl.filter}: ${name}`}
				>
					<Ellipsis size={16} aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side={controls ? "right" : "bottom"}
				align={controls ? "start" : "end"}
				sideOffset={controls?.menuPosition.sideOffset}
				alignOffset={controls?.menuPosition.alignOffset}
				collisionPadding={12}
				className="project-action-menu"
				data-sidebar-row-portal={controls ? "" : undefined}
				onCloseAutoFocus={(event) => {
					if (!controls) return;
					event.preventDefault();
					controls.onReturnFocus();
				}}
			>
				<DropdownMenuLabel className="sidebar-menu-preview">{controls?.previewContent ?? name}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{onManageFolder && (
					<>
						<DropdownMenuItem onSelect={onManageFolder}>
							<Icon name="folder" size={16} />
							{projectFolderLabels(locale).title}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuRadioGroup
					aria-label={cl.filter}
					value={filter}
					onValueChange={(value) => {
						if (value === "active" || value === "archived") onFilterChange(value);
					}}
				>
					<DropdownMenuRadioItem value="active">
						<MessageCircle size={16} aria-hidden="true" />
						{cl.active}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="archived">
						<Archive size={16} aria-hidden="true" />
						{cl.archived}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
