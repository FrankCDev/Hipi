import type { Conversation } from "@hipi/work-runtime/contracts";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../../components/ui/dialog.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { ConversationCapabilities } from "../conversation-capabilities/conversation-capabilities.tsx";
import { ToolActivities, type ToolActivityArtifact } from "../tool-activities/tool-activities.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import { ConversationComposer } from "./conversation-composer.tsx";
import { ConversationHistory } from "./conversation-history.tsx";
import { ConversationModelControls } from "./conversation-model.tsx";
import { ConversationReceipt } from "./conversation-receipt.tsx";
import { useConversation } from "./use-conversation.ts";

export function ConversationPane({
	conversation,
	detailsOpen,
	onDetailsClose,
	onOpenArtifact,
}: {
	conversation: Conversation;
	detailsOpen: boolean;
	onDetailsClose: () => void;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
}) {
	const { t, locale } = usePreferences();
	const controller = useConversation(conversation);
	const { observation } = controller;
	return (
		<section className="conversation-panel" aria-label={conversation.title}>
			<h1 className="sr-only">{conversation.title}</h1>
			{conversation.archivedAt !== null && <p className="notice">{catalogLabels(locale).archivedNote}</p>}
			{observation.connection !== "connected" && (
				<div className={`connection-bar ${observation.connection === "stale" ? "connection-warning" : ""}`}>
					<output className="flex items-center gap-2">
						<span className="status-dot" />
						{t(`connection.${observation.connection}`)}
					</output>
					{(observation.connection === "paused" || observation.connection === "stale") && (
						<Button variant="outline" size="sm" onClick={controller.reconnect}>
							<Icon name="refresh" size={14} />
							{t("connection.reconnect")}
						</Button>
					)}
				</div>
			)}
			<Dialog
				open={detailsOpen}
				onOpenChange={(open) => {
					if (!open) onDetailsClose();
				}}
			>
				<DialogContent
					placement="right"
					className="workbench-detail-dialog"
					closeLabel={t("common.close")}
					aria-describedby={undefined}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						onDetailsClose();
					}}
				>
					<DialogTitle>{t("receipt.details")}</DialogTitle>
					<DialogBody>
						<span className="status-pill">
							{observation.connection === "connected" && observation.snapshot
								? t(observation.snapshot.running ? "work.running" : "work.idle")
								: t("receipt.unconfirmed")}
						</span>
						<ConversationReceipt conversation={conversation} controller={controller} />
					</DialogBody>
				</DialogContent>
			</Dialog>
			<ConversationHistory scope={conversation} snapshot={observation.snapshot} error={observation.error} />
			<ConversationComposer
				controller={controller}
				activity={
					<ToolActivities
						scope={conversation}
						connected={observation.connection === "connected"}
						running={observation.snapshot?.running ?? false}
						onOpenArtifact={onOpenArtifact}
					/>
				}
				controls={
					<div className="conversation-tools">
						<ConversationModelControls controller={controller} />
						<ConversationCapabilities
							key={`${conversation.workspaceId}/${conversation.conversationId}`}
							conversation={conversation}
							model={controller.model.data?.model}
							connected={observation.connection === "connected"}
						/>
					</div>
				}
			/>
		</section>
	);
}
