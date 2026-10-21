import { useId, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import { ComposerKeyboard } from "../composer/keyboard.ts";
import type { ProjectActionOwner } from "./action-owner.ts";
import { projectLabels } from "./labels.ts";
import "./rename.css";

export function ProjectEditableTitle({
	name,
	owner,
}: {
	name: string;
	owner: Pick<
		ProjectActionOwner,
		"inline" | "disabled" | "beginInlineRename" | "changeInlineName" | "commitInlineRename" | "cancelInlineRename"
	>;
}) {
	const { locale } = usePreferences();
	const title = useRef<HTMLButtonElement>(null);
	const returnToTitle = useRef<{ source?: HTMLInputElement } | null>(null);
	useLayoutEffect(() => {
		if (owner.inline?.editing || !returnToTitle.current) return;
		const source = returnToTitle.current.source;
		returnToTitle.current = null;
		const button = title.current;
		if (!button) return;
		const doc = button.ownerDocument;
		// Only an explicit cancellation returns focus. A newer outside owner wins.
		if (doc.activeElement === doc.body || doc.activeElement === source) button.focus();
	});
	return owner.inline?.editing ? (
		<ProjectInlineRename
			draft={owner.inline.draft}
			validationAttempt={owner.inline.validationAttempt}
			disabled={owner.disabled}
			onChange={owner.changeInlineName}
			onCommit={owner.commitInlineRename}
			onCancel={(source) => {
				returnToTitle.current = { source };
				owner.cancelInlineRename();
			}}
		/>
	) : (
		<Button
			ref={title}
			variant="ghost"
			className="project-preview-name"
			disabled={owner.disabled}
			aria-label={projectLabels(locale).rename}
			onClick={owner.beginInlineRename}
		>
			<span className="project-preview-name-label">{name}</span>
		</Button>
	);
}

/** Ephemeral editor; its branch owner retains the draft and admitted request. */
export function ProjectInlineRename({
	draft,
	validationAttempt,
	disabled,
	onChange,
	onCommit,
	onCancel,
}: {
	draft: string;
	validationAttempt?: number;
	disabled: boolean;
	onChange: (value: string) => void;
	onCommit: () => void;
	onCancel: (source?: HTMLInputElement) => void;
}) {
	const { locale } = usePreferences();
	const input = useRef<HTMLInputElement>(null);
	const keyboard = useRef(new ComposerKeyboard());
	const cancelled = useRef(false);
	useLayoutEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	useLayoutEffect(() => {
		if (!validationAttempt || !input.current) return;
		input.current.setCustomValidity(projectLabels(locale).nameTooLong);
		input.current.focus();
		input.current.reportValidity();
	}, [validationAttempt, locale]);
	return (
		<Input
			ref={input}
			className="project-preview-name-input"
			data-project-inline-rename=""
			aria-label={projectLabels(locale).name}
			aria-invalid={draft.trim().length > 128}
			value={draft}
			disabled={disabled}
			maxLength={128}
			autoComplete="off"
			onChange={(event) => {
				event.currentTarget.setCustomValidity("");
				onChange(event.target.value);
			}}
			onCompositionStart={() => keyboard.current.compositionStart()}
			onCompositionEnd={(event) => keyboard.current.compositionEnd(event.timeStamp)}
			onKeyUp={() => keyboard.current.keyUp()}
			onBlur={() => {
				keyboard.current.reset();
				if (!cancelled.current) onCommit();
			}}
			onKeyDown={(event) => {
				if (event.key === " " || event.key === "Enter" || event.key === "Escape") event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					// Apply the same composition-end guard to cancellation as to Enter.
					const action = keyboard.current.keyDown({
						...event.nativeEvent,
						key: "Enter",
						ctrlKey: false,
						metaKey: false,
						shiftKey: false,
						altKey: false,
						isComposing: event.nativeEvent.isComposing,
						keyCode: event.nativeEvent.keyCode,
						repeat: event.repeat,
						timeStamp: event.timeStamp,
					});
					if (action !== "submit") return;
					cancelled.current = true;
					onCancel(event.currentTarget);
					return;
				}
				const action = keyboard.current.keyDown(event.nativeEvent);
				if (action !== "native") event.preventDefault();
				if (action === "submit") event.currentTarget.blur();
			}}
		/>
	);
}

export function ProjectRenameDialog({
	name,
	disabled,
	busy,
	pending,
	failed,
	onSave,
	onClose,
	onReturnFocus,
}: {
	name: string;
	disabled: boolean;
	busy: boolean;
	pending: boolean;
	failed: boolean;
	onSave: (name: string) => void;
	onClose: () => void;
	onReturnFocus: () => void;
}) {
	const { locale } = usePreferences();
	const l = catalogLabels(locale);
	const pl = projectLabels(locale);
	// The mounted dialog owns its draft; refreshed project data must not replace it.
	const [draft, setDraft] = useState(name);
	const nameId = useId();
	const nameInput = useRef<HTMLInputElement>(null);
	const keyboard = useRef(new ComposerKeyboard());
	const preparedName = draft.trim();
	const inputDisabled = disabled || busy || pending;
	const saveDisabled = inputDisabled || !preparedName || preparedName.length > 128;
	const close = () => {
		if (busy) return;
		keyboard.current.reset();
		onClose();
	};
	const save = () => {
		if (!saveDisabled) onSave(preparedName);
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent
				className="project-rename-dialog"
				data-sidebar-row-portal=""
				closeLabel={l.close}
				closeDisabled={busy}
				onContextMenu={(event) => event.stopPropagation()}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					nameInput.current?.focus();
					nameInput.current?.select();
				}}
				onEscapeKeyDown={(event) => {
					if (event.isComposing || event.keyCode === 229 || busy) event.preventDefault();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					onReturnFocus();
				}}
			>
				<DialogTitle>{pl.rename}</DialogTitle>
				<DialogDescription>{pl.renameNote}</DialogDescription>
				<form
					className="project-rename-form"
					onSubmit={(event) => {
						event.preventDefault();
						// Enter is owned below so confirming IME input cannot submit implicitly.
					}}
				>
					<label htmlFor={nameId}>
						{pl.name}
						<Input
							ref={nameInput}
							className="project-rename-input"
							id={nameId}
							value={draft}
							disabled={inputDisabled}
							maxLength={128}
							autoComplete="off"
							onChange={(event) => setDraft(event.target.value)}
							onCompositionStart={() => keyboard.current.compositionStart()}
							onCompositionEnd={(event) => keyboard.current.compositionEnd(event.timeStamp)}
							onBlur={() => keyboard.current.reset()}
							onKeyUp={() => keyboard.current.keyUp()}
							onKeyDown={(event) => {
								const action = keyboard.current.keyDown(event.nativeEvent);
								if (action !== "native") event.preventDefault();
								if (action === "submit") save();
							}}
						/>
					</label>
					{failed && <p role="alert">{l.failed}</p>}
					{pending && <p role="alert">{l.pending}</p>}
					<div className="project-rename-actions">
						<Button type="button" className="project-rename-cancel" variant="ghost" disabled={busy} onClick={close}>
							{pending ? l.close : l.cancel}
						</Button>
						<Button type="button" className="project-rename-save" disabled={saveDisabled} onClick={save}>
							{l.save}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
