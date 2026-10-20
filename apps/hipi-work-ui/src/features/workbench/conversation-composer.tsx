import { AppError, LIMITS } from "@hipi/work-runtime/contracts";
import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { ComposerKeyboard } from "./composer-keyboard.ts";
import { COMPOSER_ROWS, resizeComposerTextarea } from "./composer-textarea.ts";
import { ReceiptRecovery } from "./conversation-receipt.tsx";
import { ConversationStarters } from "./conversation-starters.tsx";
import type { ConversationController } from "./use-conversation.ts";

export function ConversationComposer({
	controller,
	controls,
	activity,
}: {
	controller: ConversationController;
	controls?: ReactNode;
	activity?: ReactNode;
}) {
	const { t } = usePreferences();
	const inputId = useId();
	const hintId = useId();
	const textarea = useRef<HTMLTextAreaElement>(null);
	const keyboard = useRef(new ComposerKeyboard());
	const focusDraft = useRef(false);
	const { draft, setDraft, submit, blocked, composing, mutation, receipt, errorCode } = controller;
	const snapshot = controller.observation.snapshot;
	const empty = snapshot && !snapshot.messages.length && !snapshot.historyCursor && !snapshot.running;
	const contextRequired =
		errorCode === "CONTEXT_AUTHORIZATION_REQUIRED" ||
		(controller.execution.error instanceof AppError &&
			controller.execution.error.code === "CONTEXT_AUTHORIZATION_REQUIRED");
	useLayoutEffect(() => {
		const element = textarea.current;
		// Only measure the committed controlled value, never each streamed response render.
		if (element && element.value === draft) {
			resizeComposerTextarea(element);
			if (focusDraft.current) {
				focusDraft.current = false;
				element.focus();
				element.setSelectionRange(draft.length, draft.length);
			}
		}
	}, [draft]);
	useLayoutEffect(() => {
		const element = textarea.current;
		if (!element) return;
		let width = element.getBoundingClientRect().width;
		const observer = new ResizeObserver(() => {
			const nextWidth = element.getBoundingClientRect().width;
			if (nextWidth === width) return;
			width = nextWidth;
			resizeComposerTextarea(element);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return (
		<div className="composer-wrap">
			{empty && (
				<ConversationStarters
					hasDraft={draft.length > 0}
					disabled={blocked}
					onSelect={(text) => {
						// Do not replace user input if an event arrives after the visible state changed.
						if (draft.length || blocked) return;
						focusDraft.current = true;
						setDraft(text);
					}}
				/>
			)}
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
			{activity && <div className="composer-context">{activity}</div>}
			<div className="composer" data-has-draft={draft.length > 0} aria-busy={mutation.isPending}>
				<form
					id={`${inputId}-form`}
					className="composer-form"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<label className="sr-only" htmlFor={inputId}>
						{t("work.draft")}
					</label>
					<Textarea
						className="composer-input border-0 bg-transparent shadow-none focus-visible:ring-0"
						ref={textarea}
						rows={COMPOSER_ROWS.min}
						id={inputId}
						aria-describedby={hintId}
						value={draft}
						maxLength={LIMITS.text}
						placeholder={t("work.placeholder")}
						onChange={(event) => setDraft(event.target.value)}
						onCompositionStart={() => {
							composing.current = true;
							keyboard.current.compositionStart();
						}}
						onCompositionEnd={(event) => {
							composing.current = false;
							keyboard.current.compositionEnd(event.timeStamp);
						}}
						onBlur={() => {
							composing.current = false;
							keyboard.current.reset();
						}}
						onKeyUp={() => keyboard.current.keyUp()}
						onKeyDown={(event) => {
							const action = keyboard.current.keyDown(event.nativeEvent);
							if (action !== "native") event.preventDefault();
							if (action === "submit") submit();
						}}
					/>
				</form>
				{/* Permission dialogs can own forms. Keep their React event tree outside the submission form. */}
				<div className="composer-actions">
					<div className="composer-controls">{controls}</div>
					<Button
						type="submit"
						form={`${inputId}-form`}
						size="icon"
						className="composer-submit"
						disabled={!draft.trim() || blocked}
						aria-label={t(mutation.isPending ? "work.sending" : "work.send")}
						title={t(mutation.isPending ? "work.sending" : "work.send")}
					>
						<Icon name="arrowUp" size={18} />
					</Button>
				</div>
			</div>
			<p className="composer-hint" id={hintId}>
				<span>
					{t("work.composer.shortcuts")}
					{" · "}
				</span>
				{t(controller.storageAvailable ? "work.draftNote" : "work.draftUnsaved")}
			</p>
		</div>
	);
}
