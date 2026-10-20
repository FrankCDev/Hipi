import type { Conversation } from "@hipi/work-runtime/contracts";
import { useId } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { PopoverHeader, PopoverTitle } from "../../components/ui/popover.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import { type PreviewActions, SidebarPreviewRow } from "./sidebar-preview-row.tsx";

export function ConversationPreview({
	conversation,
	workspaceName,
	selected,
	onSelect,
	onDetails,
	renderActions,
}: {
	conversation: Conversation;
	workspaceName: string;
	selected: boolean;
	onSelect: () => void;
	onDetails: (returnFocus: HTMLButtonElement | null) => void;
	renderActions?: PreviewActions;
}) {
	const { t, locale } = usePreferences();
	const titleId = useId();
	const l = catalogLabels(locale);
	const timestamp = conversation.createdAt === null ? null : new Date(conversation.createdAt);
	const created = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : null;
	return (
		<SidebarPreviewRow
			className="conversation-preview-row"
			selected={selected}
			titleId={titleId}
			renderActions={renderActions}
			preview={(close, returnFocus) => (
				<>
					<PopoverHeader>
						<PopoverTitle>{conversation.title}</PopoverTitle>
					</PopoverHeader>
					<p className="preview-workspace">
						<Icon name="folder" size={15} />
						<span>{workspaceName}</span>
					</p>
					<div className="conversation-preview-summary">
						<span className="preview-status" data-archived={conversation.archivedAt !== null}>
							{conversation.archivedAt === null ? l.activeStatus : l.archivedShort}
						</span>
						{created && (
							<p className="preview-created">
								<span>{l.created}</span>
								<time dateTime={created.toISOString()}>
									{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(created)}
								</time>
							</p>
						)}
					</div>
					<details className="preview-identifiers">
						<summary>{l.identifiers}</summary>
						<dl className="conversation-preview-metadata">
							<dt>{t("common.workspaceId")}</dt>
							<dd>{conversation.workspaceId}</dd>
							<dt>{t("common.conversationId")}</dt>
							<dd>{conversation.conversationId}</dd>
						</dl>
					</details>
					<div className="conversation-preview-actions">
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								close();
								onSelect();
							}}
						>
							<Icon name="chat" size={14} />
							{t("common.open")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								close();
								onDetails(returnFocus());
							}}
						>
							<Icon name="info" size={14} />
							{t("receipt.details")}
						</Button>
					</div>
				</>
			)}
		>
			<button
				type="button"
				className="conversation-link"
				aria-current={selected ? "page" : undefined}
				onClick={onSelect}
			>
				<span className="conversation-title" id={titleId}>
					{conversation.title}
				</span>
			</button>
		</SidebarPreviewRow>
	);
}
