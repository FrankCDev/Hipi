import { AppError, type Conversation, type ModelReference, type Workspace } from "@hipi/work-runtime/contracts";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { PopoverHeader, PopoverTitle } from "../../components/ui/popover.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.tsx";
import { ConversationActions } from "./catalog-controls.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import { CatalogPagination } from "./catalog-pagination.tsx";
import type { CatalogSession } from "./catalog-session.ts";
import { ConversationPreview } from "./conversation-preview.tsx";
import { CreateDialog } from "./create-dialog.tsx";
import { SidebarPreviewRow } from "./sidebar-preview-row.tsx";
import { useCatalogPages } from "./use-catalog-pages.ts";

type TreeProps = {
	catalog: CatalogSession;
	guard: (action: () => void) => void;
	workspaces: Workspace[];
	selectedWorkspace: string;
	selectedConversation: string;
	search: string;
	isExpanded: (id: string) => boolean;
	onToggle: (id: string) => void;
	onOpenProject: (id: string) => void;
	onSelect: (conversation: Conversation) => void;
	onDetails: (conversation: Conversation, returnFocus: HTMLButtonElement | null) => void;
	onCreate: (workspaceId: string, title: string, model?: ModelReference, initialDraft?: string) => Promise<void>;
	preparedDraft?: (workspaceId: string) => string;
	onPreparedDraftChange?: (workspaceId: string, value: string) => void;
};

/** Each expanded branch shows a bounded catalog window, never execution streams. */
export function WorkspaceTree(props: TreeProps) {
	const { t } = usePreferences();
	return (
		<nav aria-label={t("nav.workspaces")}>
			<ul className="workspace-tree">
				{props.workspaces.map((workspace) => (
					<WorkspaceBranch key={workspace.workspaceId} {...props} workspace={workspace} />
				))}
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
	const filterName = useId();
	const expanded = props.isExpanded(workspace.workspaceId);
	const region = useRef<HTMLElement>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [filter, setFilter] = useState<"active" | "archived">("active");
	const cl = catalogLabels(locale);
	const catalogState = useSyncExternalStore(
		props.catalog.subscribe,
		props.catalog.getSnapshot,
		props.catalog.getSnapshot,
	);
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
		<li className="workspace-branch" data-current={current} data-contains-current={containsCurrent}>
			<SidebarPreviewRow
				className="project-row"
				selected={current}
				containsCurrent={containsCurrent}
				dialogOpen={createOpen}
				titleId={headingId}
				preview={() => (
					<>
						<PopoverHeader>
							<PopoverTitle>{workspace.name}</PopoverTitle>
						</PopoverHeader>
						{conversations.hasData && (
							<dl className="conversation-preview-summary">
								<dt>{cl.filter}</dt>
								<dd>{filter === "active" ? cl.active : cl.archived}</dd>
								<dt>{cl.loaded}</dt>
								<dd>{new Intl.NumberFormat(locale).format(conversations.items.length)}</dd>
							</dl>
						)}
						<details className="preview-identifiers">
							<summary>{cl.identifiers}</summary>
							<dl className="conversation-preview-metadata">
								<dt>{t("common.workspaceId")}</dt>
								<dd>{workspace.workspaceId}</dd>
							</dl>
						</details>
					</>
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
					{conversations.hasData && (
						<span className="subtle-count project-page-count">
							<span className="sr-only">{cl.loaded}: </span>
							{new Intl.NumberFormat(locale).format(conversations.items.length)}
						</span>
					)}
				</button>
				<CreateDialog
					kind="conversation"
					workspaceId={workspace.workspaceId}
					draft={props.preparedDraft?.(workspace.workspaceId)}
					onDraftChange={
						props.onPreparedDraftChange
							? (value) => props.onPreparedDraftChange?.(workspace.workspaceId, value)
							: undefined
					}
					disabled={catalogState.busy || !!catalogState.pending || catalogState.incompatible}
					compact
					onOpenChange={setCreateOpen}
					onCreate={(title, model, initialDraft) => props.onCreate(workspace.workspaceId, title, model, initialDraft)}
				/>
			</SidebarPreviewRow>
			<section
				ref={region}
				id={regionId}
				aria-labelledby={headingId}
				hidden={!expanded}
				className="project-conversations"
				tabIndex={-1}
				aria-busy={expanded && conversations.isFetching}
			>
				<div className="project-list-toolbar">
					<fieldset className="conversation-filter-tabs">
						<legend className="sr-only">{cl.filter}</legend>
						{(["active", "archived"] as const).map((value) => (
							<label key={value} className="conversation-filter-tab" data-selected={filter === value}>
								<input
									type="radio"
									className="sr-only"
									name={filterName}
									value={value}
									aria-label={cl[value]}
									checked={filter === value}
									onChange={() => setFilter(value)}
								/>
								<span>{cl[value === "active" ? "activeShort" : "archivedShort"]}</span>
							</label>
						))}
					</fieldset>
					{conversations.hasData && props.search.trim() && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										className="project-match-count"
										aria-label={`${cl.pageMatches}: ${new Intl.NumberFormat(locale).format(visible.length)}`}
									>
										{new Intl.NumberFormat(locale).format(visible.length)}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="right">
									{cl.pageMatches}: {new Intl.NumberFormat(locale).format(visible.length)}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
				</div>
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
									workspaceName={workspace.name}
									selected={
										props.selectedWorkspace === workspace.workspaceId &&
										props.selectedConversation === conversation.conversationId
									}
									onSelect={() => props.onSelect(conversation)}
									onDetails={(returnFocus) => props.onDetails(conversation, returnFocus)}
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
						{!props.search.trim() && filter === "active" && <p className="nav-empty-hint">{cl.emptyHint}</p>}
					</div>
				)}
				{expanded && <CatalogPagination pages={conversations} listRef={region} />}
			</section>
		</li>
	);
}
