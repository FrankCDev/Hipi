import type { Conversation } from "@hipi/work-runtime/contracts";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { CopyId } from "./copy-id.tsx";
import { executionOutcome } from "./execution-outcome.ts";
import type { ConversationController } from "./use-conversation.ts";

/** Unknown acceptance must remain actionable even when technical details are collapsed. */
export function ReceiptRecovery({ controller }: { controller: ConversationController }) {
	const { t, locale } = usePreferences();
	const { requestId, receipt, mutation, pending, observation } = controller;
	// Model failures belong to the request-keyed transcript status, not the composer.
	if (requestId && receipt.data?.execution === "unanswered" && receipt.data.reason === "model_error") return null;
	if (requestId && receipt.data?.execution === "unanswered")
		return (
			<section className="composer-recovery">
				<output>{executionOutcome(receipt.data.reason, locale)}</output>
			</section>
		);
	if (!requestId || (receipt.data && receipt.data.state !== "reconciliation_required")) return null;
	return (
		<section className="composer-recovery" aria-label={t("receipt.recoveryTitle")}>
			<output className="receipt-summary">
				<Icon name="info" size={16} />
				<strong>{t(mutation.isPending ? "work.sending" : "receipt.recoveryTitle")}</strong>
			</output>
			<p className="small-copy">
				{t(
					receipt.data?.state === "reconciliation_required"
						? "receipt.reconciliation_required"
						: receipt.data === null
							? "receipt.notFound"
							: "work.unknown",
				)}
			</p>
			<div className="recovery-actions">
				<Button
					variant="outline"
					size="sm"
					disabled={receipt.isFetching}
					onClick={() => {
						void receipt.refetch();
					}}
				>
					<Icon name="refresh" size={14} />
					{t(receipt.isFetching ? "common.loading" : "receipt.check")}
				</Button>
				{pending && !receipt.data && !mutation.isPending && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => mutation.mutate(pending)}
						disabled={
							observation.connection !== "connected" || controller.storeMismatch || !controller.executionAllowed
						}
					>
						{t("receipt.retry")}
					</Button>
				)}
			</div>
			{pending && !receipt.data && !mutation.isPending && <p className="small-copy">{t("receipt.retryNote")}</p>}
		</section>
	);
}

export function ConversationReceipt({
	conversation,
	controller,
}: {
	conversation: Conversation;
	controller: ConversationController;
}) {
	const { t } = usePreferences();
	const { requestId, receipt, stopWaiting, observation, mutation } = controller;
	const known = receipt.data;
	return (
		<div className="diagnostics-grid">
			<section>
				<h3>{t("receipt.title")}</h3>
				<p className="small-copy">{t("receipt.description")}</p>
				{!requestId ? (
					<p className="empty-copy">{t("receipt.empty")}</p>
				) : (
					<>
						<dl className="receipt-details">
							<dt>{t("receipt.request")}</dt>
							<CopyId key={requestId} value={requestId} testId="request-id" />
							<dt>{t("receipt.admission")}</dt>
							<dd>{known ? t(`receipt.${known.state}`) : t("receipt.unconfirmed")}</dd>
							{known && (
								<>
									<dt>{t("receipt.receipt")}</dt>
									<dd className="identifier">{known.receiptId}</dd>
									<dt>{t("receipt.execution")}</dt>
									<dd data-testid="execution-status">
										{known.execution ? t(`receipt.${known.execution}`) : t("receipt.unconfirmed")}
									</dd>
								</>
							)}
						</dl>
						{known?.answer !== undefined && (
							<div>
								<h3>{t("history.answer")}</h3>
								{known.answerTruncated && (
									<p className="small-copy">
										{t("history.receiptPreview")} ({known.answer.length} / {known.answerLength})
									</p>
								)}
								<div className="message-text">{known.answer}</div>
							</div>
						)}
						<Button
							variant="outline"
							size="sm"
							disabled={receipt.isFetching}
							onClick={() => {
								void receipt.refetch();
							}}
						>
							{t(receipt.isFetching ? "common.loading" : "receipt.check")}
						</Button>
					</>
				)}
			</section>
			<section>
				<h3>{t("scope.title")}</h3>
				<dl className="receipt-details">
					<dt>{t("common.workspaceId")}</dt>
					<CopyId value={conversation.workspaceId} testId="workspace-id" />
					<dt>{t("common.conversationId")}</dt>
					<CopyId value={conversation.conversationId} testId="conversation-id" />
				</dl>
				<p className="small-copy">{t("scope.body")}</p>
			</section>
			<section>
				<Button
					variant="outline"
					size="sm"
					onClick={stopWaiting}
					disabled={observation.connection === "paused" && !mutation.isPending}
				>
					{t("work.cancelWait")}
				</Button>
				<p className="small-copy">{t("work.cancelNote")}</p>
				<div className="runtime-note">
					<p>{t("model.runtimeNote")}</p>
				</div>
			</section>
		</div>
	);
}
