import type { Conversation } from "@hipi/work-runtime/contracts";
import { useMemo, useRef } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../../../components/ui/dialog.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { PermissionProvider } from "../../agent-permissions/permission-provider.tsx";
import { ConversationCapabilities } from "../../conversation-capabilities/conversation-capabilities.tsx";
import { ActivityTranscriptProvider } from "../../tool-activities/activity-transcript.tsx";
import {
	ActivityHistoryAction,
	ActivityHistoryDialog,
	type ToolActivityArtifact,
} from "../../tool-activities/tool-activities.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import { ConversationComposer } from "../composer/input.tsx";
import { conversationFailureTrackerFor } from "./failure.ts";
import { ConversationHistory } from "./history.tsx";
import type { SearchHistoryAnchor } from "./history-controller.ts";
import { ConversationModelControls } from "./model.tsx";
import { ConversationReceipt } from "./receipt.tsx";
import { useConversation } from "./use-conversation.ts";
import "./layout.css";

export function ConversationPane({
	conversation,
	draftRecoveryRevision,
	detailsOpen,
	onDetailsClose,
	onOpenArtifact,
	onOpenModelSettings,
	searchAnchor,
	onExitSearchAnchor,
}: {
	conversation: Conversation;
	draftRecoveryRevision?: string;
	detailsOpen: boolean;
	onDetailsClose: () => void;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
	onOpenModelSettings?: (returnFocus: HTMLElement) => void;
	searchAnchor?: SearchHistoryAnchor;
	onExitSearchAnchor?: () => void;
}) {
	const { t, locale } = usePreferences();
	const failureTracker = conversationFailureTrackerFor(useAppClient());
	const controller = useConversation(conversation, draftRecoveryRevision);
	const { observation } = controller;
	const failure = useMemo(
		() =>
			failureTracker.observe(
				conversation,
				controller.requestId,
				controller.receipt.data,
				observation.snapshot,
				controller.mutation.isPending,
			),
		[
			failureTracker,
			conversation,
			controller.requestId,
			controller.receipt.data,
			observation.snapshot,
			controller.mutation.isPending,
		],
	);
	const footer = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLElement>(null);
	return (
		<PermissionProvider
			scope={conversation}
			connected={observation.connection === "connected"}
			archived={conversation.archivedAt !== null}
		>
			<ActivityTranscriptProvider
				scope={conversation}
				connected={observation.connection === "connected"}
				running={observation.snapshot?.running ?? false}
				onOpenArtifact={
					onOpenArtifact
						? (artifact) => {
								if (detailsOpen) onDetailsClose();
								onOpenArtifact(artifact);
							}
						: undefined
				}
				rootRef={panel}
			>
				<section ref={panel} className="conversation-panel" aria-label={conversation.title}>
					<h1 className="sr-only">{conversation.title}</h1>
					{conversation.archivedAt !== null && <p className="notice">{catalogLabels(locale).archivedNote}</p>}
					{observation.showConnectionNotice && (
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
								<ActivityHistoryAction />
							</DialogBody>
						</DialogContent>
					</Dialog>
					<ConversationHistory
						scope={conversation}
						connected={observation.connection === "connected"}
						snapshot={observation.snapshot}
						responseActive={
							observation.connection === "connected" &&
							controller.model.data?.executionState === "running" &&
							!controller.model.isError &&
							!controller.execution.isPending
						}
						error={observation.error}
						footerRef={footer}
						failure={failure}
						onOpenModelSettings={onOpenModelSettings}
						searchAnchor={searchAnchor}
						onExitSearchAnchor={onExitSearchAnchor}
					/>
					<div className="conversation-footer" ref={footer}>
						<div className="conversation-column">
							<ConversationComposer
								controller={controller}
								controls={
									<div className="conversation-tools">
										<ConversationCapabilities
											key={`${conversation.workspaceId}/${conversation.conversationId}`}
											conversation={conversation}
											model={controller.model.data?.model}
											connected={observation.connection === "connected"}
										/>
										<ConversationModelControls controller={controller} onOpenModelSettings={onOpenModelSettings} />
									</div>
								}
							/>
						</div>
					</div>
					<ActivityHistoryDialog />
				</section>
			</ActivityTranscriptProvider>
		</PermissionProvider>
	);
}
