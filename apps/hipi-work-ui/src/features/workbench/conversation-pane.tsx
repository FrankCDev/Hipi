import type { Conversation } from "@hipi/work-runtime/contracts";
import { useEffect, useId, useRef } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { AgentPermissions } from "../agent-permissions/agent-permissions.tsx";
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
	const detailsTitle = useRef<HTMLHeadingElement>(null);
	const detailsId = useId();
	const detailsTitleId = useId();
	useEffect(() => {
		if (detailsOpen) detailsTitle.current?.focus();
	}, [detailsOpen]);
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
			<div className="diagnostics-panel" id={detailsId} hidden={!detailsOpen}>
				<section aria-labelledby={detailsTitleId}>
					<div className="diagnostics-heading">
						<h2 id={detailsTitleId} ref={detailsTitle} tabIndex={-1}>
							{t("receipt.details")}
						</h2>
						<span className="status-pill">
							{observation.connection === "connected" && observation.snapshot
								? t(observation.snapshot.running ? "work.running" : "work.idle")
								: t("receipt.unconfirmed")}
						</span>
						<Button variant="ghost" size="sm" onClick={onDetailsClose}>
							{t("common.close")}
						</Button>
					</div>
					<ConversationReceipt conversation={conversation} controller={controller} />
				</section>
			</div>
			<ConversationModelControls controller={controller} />
			<AgentPermissions
				key={`${conversation.workspaceId}/${conversation.conversationId}`}
				scope={conversation}
				archived={conversation.archivedAt !== null}
				model={controller.model.data?.model}
				connected={observation.connection === "connected"}
			/>
			<ToolActivities
				scope={conversation}
				connected={observation.connection === "connected"}
				running={observation.snapshot?.running ?? false}
				onOpenArtifact={onOpenArtifact}
			/>
			<ConversationHistory scope={conversation} snapshot={observation.snapshot} error={observation.error} />
			<ConversationComposer controller={controller} />
		</section>
	);
}
