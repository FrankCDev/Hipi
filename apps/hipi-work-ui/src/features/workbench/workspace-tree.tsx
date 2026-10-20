import { AppError, type Conversation, type Workspace } from "@hipi/work-runtime/contracts";
import { Archive, Ellipsis, MessageCircle, SquarePen } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { PopoverHeader, PopoverTitle } from "../../components/ui/popover.tsx";
import { ConversationActions } from "./catalog-controls.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import { CatalogPagination } from "./catalog-pagination.tsx";
import type { CatalogSession } from "./catalog-session.ts";
import { ConversationPreview } from "./conversation-preview.tsx";
import { projectFolderLabels } from "./project-folder-labels.ts";
import { type PreviewActions, SidebarPreviewRow } from "./sidebar-preview-row.tsx";
import { useCatalogPages } from "./use-catalog-pages.ts";
import "./sidebar.css";

type TreeProps = {
	catalog: CatalogSession;
	guard: (action: () => void) => void;
	workspaces: Workspace[];
	defaultWorkspaceId?: string | null;
	selectedWorkspace: string;
	selectedConversation: string;
	search: string;
	isExpanded: (id: string) => boolean;
	onToggle: (id: string) => void;
	onOpenProject: (id: string) => void;
	onSelect: (conversation: Conversation) => void;
	onNewConversation: (workspaceId: string) => void;
	onManageProjectFolder?: (workspace: Workspace, restoreFocus?: () => void) => void;
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
					.filter((workspace) => workspace.workspaceId !== props.defaultWorkspaceId)
					.map((workspace) => (
						<WorkspaceBranch key={workspace.workspaceId} {...props} workspace={workspace} />
					))}
				{recent && <WorkspaceBranch key={recent.workspaceId} {...props} workspace={recent} />}
			</ul>
		</nav>
	);
}

function WorkspaceBranch({ workspace, ...props }: TreeProps & { workspace: Workspace }) {
	const client = useAppClient();
	const { t, locale } = usePreferences();
	const regionId = useId();
	const headingId = useId();
	const disclosureId = useId();
	const openId = useId();
	const recent = workspace.workspaceId === props.defaultWorkspaceId;
	const expanded = recent || props.isExpanded(workspace.workspaceId);
	const region = useRef<HTMLElement>(null);
	const [filter, setFilter] = useState<"active" | "archived">("active");
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
	const visible = conversations.items.filter((item) =>
		item.title.toLocaleLowerCase(locale).includes(props.search.trim().toLocaleLowerCase(locale)),
	);
	const containsCurrent = props.selectedWorkspace === workspace.workspaceId && !!props.selectedConversation;
	const current = props.selectedWorkspace === workspace.workspaceId && !props.selectedConversation;
	return (
		<li
			className={`workspace-branch${recent ? " recent-conversations" : ""}`}
			data-workspace-id={workspace.workspaceId}
			data-current={current}
			data-contains-current={containsCurrent}
		>
			{recent ? (
				<div className="recent-conversations-heading">
					<h3 id={headingId}>{cl.recent}</h3>
					<ProjectConversationMenu name={cl.recent} filter={filter} onFilterChange={setFilter} />
				</div>
			) : (
				<SidebarPreviewRow
					className="project-row"
					selected={current}
					containsCurrent={containsCurrent}
					titleId={headingId}
					preview={() => (
						<>
							<PopoverHeader>
								<PopoverTitle className="project-preview-title">
									<Icon name="folder" size={16} />
									{workspace.name}
								</PopoverTitle>
							</PopoverHeader>
						</>
					)}
					renderActions={(controls) => (
						<div className="sidebar-row-actions">
							<ProjectConversationMenu
								name={workspace.name}
								filter={filter}
								controls={controls}
								onManageFolder={
									props.onManageProjectFolder
										? () => props.onManageProjectFolder?.(workspace, controls.onReturnFocus)
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
						<span id={headingId} className="project-name">
							{workspace.name}
						</span>
					</button>
				</SidebarPreviewRow>
			)}
			<section
				ref={region}
				id={regionId}
				aria-labelledby={headingId}
				hidden={!expanded}
				className="project-conversations"
				tabIndex={-1}
				aria-busy={expanded && conversations.isFetching}
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
						{visible.map((conversation) => (
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
											guard={props.guard}
											{...controls}
										/>
									)}
								/>
							</li>
						))}
					</ul>
				)}
				{expanded && conversations.isSuccess && visible.length === 0 && (
					<div className="nav-feedback nav-empty-state">
						<p>
							{props.search.trim() ? t("nav.noResults") : filter === "archived" ? cl.emptyArchived : t("nav.empty")}
						</p>
					</div>
				)}
				{expanded && <CatalogPagination pages={conversations} listRef={region} />}
			</section>
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
	return (
		<DropdownMenu
			onOpenChange={(open) => {
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
