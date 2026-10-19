import { AppError, type Conversation, type ModelReference, type Workspace } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { PopoverHeader, PopoverTitle } from "../../components/ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { ConversationActions } from "./catalog-controls.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import type { CatalogSession } from "./catalog-session.ts";
import { ConversationPreview } from "./conversation-preview.tsx";
import { CreateDialog } from "./create-dialog.tsx";
import { SidebarPreviewRow } from "./sidebar-preview-row.tsx";

type TreeProps = {
	catalog: CatalogSession;
	guard: (action: () => void) => void;
	workspaces: Workspace[];
	selectedWorkspace: string;
	selectedConversation: string;
	search: string;
	isExpanded: (id: string) => boolean;
	onToggle: (id: string) => void;
	onSelect: (conversation: Conversation) => void;
	onDetails: (conversation: Conversation, returnFocus: HTMLButtonElement | null) => void;
	onCreate: (workspaceId: string, title: string, model?: ModelReference) => Promise<void>;
};

/** Each expanded branch shows one bounded catalog page, never execution streams. */
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
	const expanded = props.isExpanded(workspace.workspaceId);
	const [cursor, setCursor] = useState<string | undefined>();
	const [filter, setFilter] = useState<"active" | "archived">("active");
	const cl = catalogLabels(locale);
	const catalogState = useSyncExternalStore(
		props.catalog.subscribe,
		props.catalog.getSnapshot,
		props.catalog.getSnapshot,
	);
	const conversations = useQuery({
		queryKey: ["conversations", workspace.workspaceId, filter, cursor],
		queryFn: ({ signal }) =>
			client.call(
				"listConversations",
				{ workspaceId: workspace.workspaceId, filter, ...(cursor ? { cursor } : {}) },
				signal,
			),
		enabled: expanded,
		retry: false,
	});
	useEffect(() => {
		if (cursor && conversations.error instanceof AppError && conversations.error.code === "CURSOR_STALE")
			setCursor(undefined);
	}, [cursor, conversations.error]);
	const visible = (conversations.data?.items ?? []).filter((item) =>
		item.title.toLocaleLowerCase(locale).includes(props.search.trim().toLocaleLowerCase(locale)),
	);
	return (
		<li className="workspace-branch" data-selected={props.selectedWorkspace === workspace.workspaceId}>
			<SidebarPreviewRow
				className="project-row"
				selected={props.selectedWorkspace === workspace.workspaceId}
				titleId={headingId}
				preview={() => (
					<>
						<PopoverHeader>
							<PopoverTitle>{workspace.name}</PopoverTitle>
						</PopoverHeader>
						<dl className="conversation-preview-metadata">
							<dt>{t("common.workspaceId")}</dt>
							<dd>{workspace.workspaceId}</dd>
							{conversations.isSuccess && (
								<>
									<dt>{cl.loaded}</dt>
									<dd>{new Intl.NumberFormat(locale).format(conversations.data.items.length)}</dd>
								</>
							)}
						</dl>
					</>
				)}
			>
				<button
					type="button"
					id={headingId}
					className="project-toggle"
					aria-expanded={expanded}
					aria-controls={regionId}
					onClick={() => props.onToggle(workspace.workspaceId)}
				>
					<span className="project-chevron" data-expanded={expanded}>
						<Icon name="chevron" size={12} />
					</span>
					<Icon name="folder" size={16} />
					<span className="project-name">{workspace.name}</span>
					{conversations.isSuccess && (
						<span className="subtle-count">
							{new Intl.NumberFormat(locale).format(conversations.data.items.length)}
						</span>
					)}
				</button>
				<CreateDialog
					kind="conversation"
					disabled={catalogState.busy || !!catalogState.pending || catalogState.incompatible}
					compact
					onCreate={(title, model) => props.onCreate(workspace.workspaceId, title, model)}
				/>
			</SidebarPreviewRow>
			<section id={regionId} aria-labelledby={headingId} hidden={!expanded} className="project-conversations">
				<Select
					value={filter}
					onValueChange={(value) => {
						if (value === "active" || value === "archived") {
							setFilter(value);
							setCursor(undefined);
						}
					}}
				>
					<SelectTrigger aria-label={cl.filter}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="active">{cl.active}</SelectItem>
						<SelectItem value="archived">{cl.archived}</SelectItem>
					</SelectContent>
				</Select>
				{expanded && conversations.isPending && <output className="nav-feedback">{t("common.loading")}</output>}
				{expanded && conversations.isError && (
					<div className="nav-feedback" role="alert">
						<p>
							{t(
								conversations.error instanceof AppError && conversations.error.code === "STORE_MISMATCH"
									? "connection.storeMismatch"
									: "nav.loadError",
							)}
						</p>
						<Button variant="outline" size="sm" onClick={() => void conversations.refetch()}>
							<Icon name="refresh" size={14} />
							{t("nav.refresh")}
						</Button>
					</div>
				)}
				{expanded && (
					<ul className="conversation-list">
						{visible.map((conversation) => (
							<li key={conversation.conversationId}>
								<ConversationPreview
									conversation={conversation}
									workspaceName={workspace.name}
									selected={
										props.selectedWorkspace === workspace.workspaceId &&
										props.selectedConversation === conversation.conversationId
									}
									onSelect={() => props.onSelect(conversation)}
									onDetails={(returnFocus) => props.onDetails(conversation, returnFocus)}
								/>
								<ConversationActions conversation={conversation} session={props.catalog} guard={props.guard} />
							</li>
						))}
					</ul>
				)}
				{expanded && conversations.isSuccess && visible.length === 0 && (
					<p className="nav-feedback">{t(props.search.trim() ? "nav.noResults" : "nav.empty")}</p>
				)}
				{expanded && (
					<div className="flex gap-1">
						<Button
							variant="ghost"
							size="sm"
							disabled={conversations.isFetching || !cursor}
							onClick={() => setCursor(undefined)}
						>
							{cl.first}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={conversations.isFetching || !conversations.data?.nextCursor}
							onClick={() => {
								if (conversations.data?.nextCursor) setCursor(conversations.data.nextCursor);
							}}
						>
							{cl.next}
						</Button>
					</div>
				)}
			</section>
		</li>
	);
}
