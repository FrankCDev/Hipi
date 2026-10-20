import type { Conversation } from "@hipi/work-runtime/contracts";
import { useId } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { PopoverHeader, PopoverTitle } from "../../components/ui/popover.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import { type PreviewActions, SidebarPreviewRow } from "./sidebar-preview-row.tsx";

export function ConversationPreview({
	conversation,
	workspaceName,
	selected,
	onSelect,
	renderActions,
}: {
	conversation: Conversation;
	workspaceName?: string;
	selected: boolean;
	onSelect: () => void;
	renderActions?: PreviewActions;
}) {
	const { locale } = usePreferences();
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
								{new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(created)}
							</time>
						)}
					</PopoverHeader>
					{workspaceName && (
						<p className="preview-workspace">
							<Icon name="folder" size={15} />
							<span>{workspaceName}</span>
						</p>
					)}
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
