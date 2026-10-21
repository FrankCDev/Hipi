import type { Conversation } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { PopoverHeader, PopoverTitle } from "../../../components/ui/popover.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import type { SidebarOrderAction } from "./drag-provider.tsx";
import { conversationAge } from "./preview-metadata.ts";
import { type PreviewActions, SidebarPreviewRow } from "./preview-row.tsx";
import type { SidebarLocation } from "./selection-owner.ts";
import { useSidebarAlias } from "./selection-provider.tsx";
import { SidebarTitle } from "./title.tsx";

function ConversationProject({ workspaceId }: { workspaceId: string }) {
	const client = useAppClient();
	const query = useQuery({
		queryKey: ["workspace", workspaceId],
		queryFn: ({ signal }) => client.call("getWorkspace", { workspaceId }, signal),
		staleTime: 15_000,
		retry: false,
	});
	return query.data?.workspaceId === workspaceId ? (
		<p className="preview-workspace">
			<Icon name="folder" size={15} />
			<span>{query.data.name}</span>
		</p>
	) : null;
}

function LogicalConversationProject({ projectId }: { projectId: string }) {
	const client = useAppClient();
	const query = useQuery({
		queryKey: ["project", projectId],
		queryFn: ({ signal }) => client.call("getProject", { projectId }, signal),
		staleTime: 15_000,
		retry: false,
	});
	return !query.isError && query.data?.projectId === projectId ? (
		<p className="preview-workspace">
			<Icon name="folder" size={15} />
			<span>{query.data.name}</span>
		</p>
	) : null;
}

export function ConversationPreview({
	conversation,
	workspaceName,
	location,
	onSelect,
	renderActions,
	resolveWorkspace = false,
	projectId,
	orderAction,
}: {
	conversation: Conversation;
	workspaceName?: string;
	location: SidebarLocation;
	onSelect: () => void;
	renderActions?: PreviewActions;
	resolveWorkspace?: boolean;
	/** Undefined is legacy physical metadata; null is authoritatively projectless. */
	projectId?: string | null;
	orderAction?: SidebarOrderAction;
}) {
	const { locale } = usePreferences();
	const alias = useSidebarAlias(conversation, location);
	const titleId = useId();
	const l = catalogLabels(locale);
	const timestamp = conversation.createdAt === null ? null : new Date(conversation.createdAt);
	const created = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : null;
	return (
		<SidebarPreviewRow
			className="conversation-preview-row"
			selected={alias.active}
			titleId={titleId}
			renderActions={renderActions}
			orderAction={orderAction}
			preview={() => (
				<>
					<PopoverHeader className="preview-heading">
						<PopoverTitle className="preview-title">{conversation.title}</PopoverTitle>
						{created && (
							<time
								className="preview-created"
								dateTime={created.toISOString()}
								title={`${l.created} ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(created)}`}
							>
								<span className="sr-only">{l.created} </span>
								{conversationAge(created.getTime(), Date.now(), locale)}
							</time>
						)}
					</PopoverHeader>
					{projectId === undefined && workspaceName && (
						<p className="preview-workspace">
							<Icon name="folder" size={15} />
							<span>{workspaceName}</span>
						</p>
					)}
					{projectId ? (
						<LogicalConversationProject projectId={projectId} />
					) : projectId === undefined && !workspaceName && resolveWorkspace ? (
						<ConversationProject workspaceId={conversation.workspaceId} />
					) : null}
				</>
			)}
		>
			{({ hovered, describedBy }) => (
				<button
					ref={alias.ref}
					type="button"
					className="conversation-link"
					data-sidebar-cycle-item=""
					data-workspace-id={conversation.workspaceId}
					data-conversation-id={conversation.conversationId}
					data-sidebar-location={location.kind}
					data-sidebar-location-workspace={location.kind === "workspace" ? location.workspaceId : undefined}
					data-sidebar-location-project={location.kind === "project" ? location.projectId : undefined}
					aria-current={alias.active ? "page" : undefined}
					aria-describedby={describedBy}
					onClick={onSelect}
				>
					<SidebarTitle className="conversation-title" id={titleId} text={conversation.title} hovered={hovered} />
				</button>
			)}
		</SidebarPreviewRow>
	);
}
