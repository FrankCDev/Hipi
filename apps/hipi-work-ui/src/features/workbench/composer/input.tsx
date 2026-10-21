import { AppError, LIMITS } from "@hipi/work-runtime/contracts";
import { LoaderCircle, Square } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { ReceiptRecovery } from "../conversation/receipt.tsx";
import type { ConversationController } from "../conversation/use-conversation.ts";
import { ComposerEditor, type ComposerEditorHandle } from "./editor.tsx";
import { ComposerFooter } from "./footer.tsx";

export function ConversationComposer({
	controller,
	controls,
	expandingControls,
	attention,
}: {
	controller: ConversationController;
	controls?: ReactNode;
	expandingControls?: ReactNode;
	attention?: ReactNode;
}) {
	const { t } = usePreferences();
	const inputId = useId();
	const hintId = useId();
	const editor = useRef<ComposerEditorHandle>(null);
	const { draft, setDraft, submit, blocked, composing, mutation, receipt, errorCode } = controller;
	const stopping = controller.model.data?.executionState === "running";
	const pending = stopping ? controller.execution.isPending : mutation.isPending;
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
			<div className="composer-attention">{attention}</div>
			<div
				className="composer"
				data-has-draft={draft.length > 0}
				aria-busy={pending}
				onPointerDown={(event) => {
					if (
						event.button !== 0 ||
						event.defaultPrevented ||
						!(event.target instanceof Element) ||
						!event.currentTarget.contains(event.target)
					)
						return;
					if (
						event.target.closest(
							'a[href], button, input, select, textarea, [contenteditable="true"], [draggable="true"], [role="button"], [role="link"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])',
						)
					)
						return;
					event.preventDefault();
					editor.current?.focus({ preventScroll: true });
				}}
			>
				<ComposerFooter
					input={
						<form
							id={`${inputId}-form`}
							className="composer-form"
							onSubmit={(event) => {
								event.preventDefault();
								submit();
							}}
						>
							<ComposerEditor
								ref={editor}
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
					}
					leading={controls}
					expanding={expandingControls}
					actions={
						<Button
							type={stopping ? "button" : "submit"}
							form={stopping ? undefined : `${inputId}-form`}
							size="icon"
							className="composer-submit"
							data-action={stopping ? "stop" : "send"}
							disabled={pending || (stopping ? controller.model.isError : !draft.trim() || blocked)}
							onClick={stopping ? () => controller.execution.mutate("cancel") : undefined}
							aria-label={t(stopping ? "model.cancelExecution" : mutation.isPending ? "work.sending" : "work.send")}
							aria-busy={pending || undefined}
						>
							{pending ? (
								<LoaderCircle size={18} className="composer-pending-icon" aria-hidden="true" />
							) : stopping ? (
								<Square size={13} fill="currentColor" aria-hidden="true" />
							) : (
								<Icon name="arrowUp" size={18} />
							)}
						</Button>
					}
				/>
			</div>
			<p className="sr-only" id={hintId}>
				{t("work.composer.shortcuts")}
			</p>
		</div>
	);
}
