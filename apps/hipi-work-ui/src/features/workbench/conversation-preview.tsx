import type { Conversation } from "@hipi/work-runtime/contracts";
import { useId } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { PopoverHeader, PopoverTitle } from "../../components/ui/popover.tsx";
import { SidebarPreviewRow } from "./sidebar-preview-row.tsx";

export function ConversationPreview({
	conversation,
	workspaceName,
	selected,
	onSelect,
	onDetails,
}: {
	conversation: Conversation;
	workspaceName: string;
	selected: boolean;
	onSelect: () => void;
	onDetails: (returnFocus: HTMLButtonElement | null) => void;
}) {
	const { t } = usePreferences();
	const titleId = useId();
	return (
		<SidebarPreviewRow
			className="conversation-preview-row"
			selected={selected}
			titleId={titleId}
			preview={(close, returnFocus) => (
				<>
					<PopoverHeader>
						<p className="eyebrow">{workspaceName}</p>
						<PopoverTitle>{conversation.title}</PopoverTitle>
					</PopoverHeader>
					<dl className="conversation-preview-metadata">
						<dt>{t("common.workspaceId")}</dt>
						<dd>{conversation.workspaceId}</dd>
						<dt>{t("common.conversationId")}</dt>
						<dd>{conversation.conversationId}</dd>
					</dl>
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
				<Icon name="chat" size={16} />
				<span id={titleId}>{conversation.title}</span>
			</button>
		</SidebarPreviewRow>
	);
}
