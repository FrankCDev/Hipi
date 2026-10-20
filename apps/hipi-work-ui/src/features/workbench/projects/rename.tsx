import { useId, useRef, useState } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import { ComposerKeyboard } from "../composer/keyboard.ts";
import { projectLabels } from "./labels.ts";
import "./rename.css";

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
