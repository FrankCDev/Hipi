import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.tsx";
import { ComposerKeyboard } from "./composer-keyboard.ts";
import "./create-dialog.css";

export function CreateDialog({
	onCreate,
	compact = false,
	disabled = false,
	onOpenChange,
	triggerLabel,
}: {
	kind: "workspace";
	onCreate: (name: string) => Promise<void>;
	compact?: boolean;
	disabled?: boolean;
	onOpenChange?: (open: boolean) => void;
	triggerLabel?: string;
}) {
	const { t } = usePreferences();
	const nameId = useId();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const keyboard = useRef(new ComposerKeyboard());
	const creating = useRef(false);
	const preparedName = name.trim();
	const mutation = useMutation({
		mutationFn: onCreate,
		onSuccess: () => {
			setOpen(false);
			onOpenChange?.(false);
			setName("");
			keyboard.current.reset();
		},
		onSettled: () => {
			creating.current = false;
		},
	});
	const create = () => {
		if (disabled || !preparedName || mutation.isPending || mutation.isError || creating.current) return;
		creating.current = true;
		mutation.mutate(preparedName);
	};
	const title = t("nav.newWorkspace");
	const trigger = (
		<DialogTrigger asChild>
			<Button
				variant="ghost"
				size={compact ? "icon-sm" : "default"}
				disabled={disabled}
				aria-label={title}
				className={compact ? undefined : "w-full justify-start"}
			>
				<Icon name="plus" size={16} />
				{!compact && (triggerLabel ?? title)}
			</Button>
		</DialogTrigger>
	);
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!mutation.isPending && !creating.current) {
					setOpen(value);
					onOpenChange?.(value);
					keyboard.current.reset();
					mutation.reset();
				}
			}}
		>
			{compact ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{trigger}</TooltipTrigger>
						<TooltipContent>{title}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				trigger
			)}
			<DialogContent
				className="project-create-dialog"
				scrollBody
				closeLabel={t("common.close")}
				closeDisabled={mutation.isPending}
				onEscapeKeyDown={(event) => {
					if (event.isComposing || event.keyCode === 229 || creating.current) event.preventDefault();
				}}
			>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription className="sr-only">{t("nav.workspaceDescription")}</DialogDescription>
				<DialogBody className="project-create-body">
					<form
						onSubmit={(event) => {
							event.preventDefault();
							// The keyboard handler owns Enter so IME confirmation cannot submit implicitly.
						}}
						className="project-create-form"
					>
						<label className="sr-only" htmlFor={nameId}>
							{t("nav.projectName")}
						</label>
						<Input
							className="task-title-input"
							id={nameId}
							disabled={mutation.isPending || disabled}
							autoComplete="off"
							placeholder={t("nav.projectName")}
							maxLength={128}
							value={name}
							onChange={(event) => setName(event.target.value)}
							onCompositionStart={() => keyboard.current.compositionStart()}
							onCompositionEnd={(event) => keyboard.current.compositionEnd(event.timeStamp)}
							onBlur={() => keyboard.current.reset()}
							onKeyUp={() => keyboard.current.keyUp()}
							onKeyDown={(event) => {
								const action = keyboard.current.keyDown(event.nativeEvent);
								if (action !== "native") event.preventDefault();
								if (action === "submit") create();
							}}
							required
						/>
						{mutation.isError && (
							<p role="alert" className="error-text">
								{t("nav.creationUnknown")}
							</p>
						)}
						<div className="project-create-actions">
							<DialogClose asChild>
								<Button type="button" variant="ghost" disabled={mutation.isPending}>
									{t("common.cancel")}
								</Button>
							</DialogClose>
							<Button
								type="button"
								className="task-create-confirm"
								disabled={disabled || !preparedName || mutation.isPending || mutation.isError}
								onClick={create}
							>
								{t(mutation.isPending ? "common.loading" : "common.create")}
							</Button>
						</div>
					</form>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
