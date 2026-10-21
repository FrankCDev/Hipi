import { AppError, LIMITS } from "@hipi/work-runtime/contracts";
import { Square } from "lucide-react";
import { type ReactNode, useId } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { ReceiptRecovery } from "../conversation/receipt.tsx";
import type { ConversationController } from "../conversation/use-conversation.ts";
import { ComposerEditor } from "./editor.tsx";

export function ConversationComposer({
	controller,
	controls,
}: {
	controller: ConversationController;
	controls?: ReactNode;
}) {
	const { t } = usePreferences();
	const inputId = useId();
	const hintId = useId();
	const { draft, setDraft, submit, blocked, composing, mutation, receipt, errorCode } = controller;
	const stopping = controller.model.data?.executionState === "running";
	const contextRequired =
		errorCode === "CONTEXT_AUTHORIZATION_REQUIRED" ||
		(controller.execution.error instanceof AppError &&
			controller.execution.error.code === "CONTEXT_AUTHORIZATION_REQUIRED");
	return (
		<div className="composer-wrap">
			{contextRequired && (
				<p className="notice" role="alert">
					{t("permissions.context.required")}
				</p>
			)}
			{!contextRequired && !controller.admissionFailed && ((mutation.isError && !receipt.data) || receipt.isError) && (
				<p className="notice" role="alert">
					{t(errorCode ? "work.rejected" : "work.unknown")}
					{errorCode && <span> ({errorCode})</span>}
				</p>
			)}
			{controller.storeMismatch && (
				<p className="notice" role="alert">
					{t("connection.storeMismatch")}
				</p>
			)}
			{!controller.storageAvailable && (
				<p className="notice" role="alert">
					{t("work.storageUnavailable")}
				</p>
			)}
			{controller.admissionFailed && (
				<p className="notice" role="alert">
					{t("work.submissionNotSent")}
				</p>
			)}
			<ReceiptRecovery controller={controller} />
			<div className="composer" data-has-draft={draft.length > 0} aria-busy={mutation.isPending}>
				<form
					id={`${inputId}-form`}
					className="composer-form"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<ComposerEditor
						id={inputId}
						value={draft}
						onChange={setDraft}
						onSubmit={submit}
						onComposingChange={(value) => {
							composing.current = value;
						}}
						maxLength={LIMITS.text}
						placeholder={t("work.placeholder")}
						label={t("work.draft")}
						describedBy={hintId}
					/>
				</form>
				{/* Permission dialogs can own forms. Keep their React event tree outside the submission form. */}
				<div className="composer-actions">
					<div className="composer-controls">{controls}</div>
					<Button
						type={stopping ? "button" : "submit"}
						form={stopping ? undefined : `${inputId}-form`}
						size="icon"
						className="composer-submit"
						data-action={stopping ? "stop" : "send"}
						disabled={stopping ? controller.execution.isPending || controller.model.isError : !draft.trim() || blocked}
						onClick={stopping ? () => controller.execution.mutate("cancel") : undefined}
						aria-label={t(stopping ? "model.cancelExecution" : mutation.isPending ? "work.sending" : "work.send")}
						title={t(stopping ? "model.cancelExecution" : mutation.isPending ? "work.sending" : "work.send")}
					>
						{stopping ? <Square size={13} fill="currentColor" aria-hidden="true" /> : <Icon name="arrowUp" size={18} />}
					</Button>
				</div>
			</div>
			<p className="sr-only" id={hintId}>
				{t("work.composer.shortcuts")}
			</p>
		</div>
	);
}
