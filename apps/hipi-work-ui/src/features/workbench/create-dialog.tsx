import { useMutation } from "@tanstack/react-query";
import { FolderOpen, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProjectFolderSelection } from "../../app/file-client.ts";
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
import { projectFolderLabels } from "./project-folder-labels.ts";
import "./create-dialog.css";

export function CreateDialog({
	onCreate,
	compact = false,
	disabled = false,
	onOpenChange,
	triggerLabel,
	chooseFolder,
	forgetFolder,
}: {
	kind: "workspace";
	onCreate: (name: string, folder?: ProjectFolderSelection) => Promise<void>;
	compact?: boolean;
	disabled?: boolean;
	onOpenChange?: (open: boolean) => void;
	triggerLabel?: string;
	chooseFolder?: (locale?: "en" | "zh-CN") => Promise<ProjectFolderSelection | null>;
	forgetFolder?: (selectionId: string) => Promise<void>;
}) {
	const { t, locale } = usePreferences();
	const nameId = useId();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [folder, setFolder] = useState<ProjectFolderSelection>();
	const [picking, setPicking] = useState(false);
	const [pickFailed, setPickFailed] = useState(false);
	const lease = useMemo(
		() => ({
			active: true,
			folder: undefined as ProjectFolderSelection | undefined,
			chooseFolder,
			forgetFolder,
		}),
		[chooseFolder, forgetFolder],
	);
	const currentLease = useRef(lease);
	currentLease.current = lease;
	const selecting = useRef(false);
	const folderTrigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		lease.active = true;
		setFolder(undefined);
		setPicking(false);
		selecting.current = false;
		return () => {
			lease.active = false;
			if (lease.folder) void lease.forgetFolder?.(lease.folder.selectionId).catch(() => {});
			lease.folder = undefined;
		};
	}, [lease]);
	const pl = projectFolderLabels(locale);
	const keyboard = useRef(new ComposerKeyboard());
	const creating = useRef(false);
	const preparedName = name.trim();
	const mutation = useMutation({
		mutationFn: (name: string) => onCreate(name, folder),
		onSuccess: () => {
			if (!lease.active || currentLease.current !== lease) return;
			lease.folder = undefined;
			setOpen(false);
			onOpenChange?.(false);
			setName("");
			setFolder(undefined);
			keyboard.current.reset();
		},
		onSettled: () => {
			creating.current = false;
		},
	});
	const create = () => {
		if (disabled || !preparedName || mutation.isPending || mutation.isError || creating.current || selecting.current)
			return;
		creating.current = true;
		mutation.mutate(preparedName);
	};
	const pickFolder = async () => {
		if (!chooseFolder || selecting.current || creating.current || disabled) return;
		selecting.current = true;
		setPicking(true);
		setPickFailed(false);
		try {
			const selected = await chooseFolder(locale === "en" ? "en" : "zh-CN");
			if (!lease.active || currentLease.current !== lease) {
				if (selected) void forgetFolder?.(selected.selectionId).catch(() => {});
				return;
			}
			if (selected) {
				if (folder) void forgetFolder?.(folder.selectionId).catch(() => {});
				setFolder(selected);
				lease.folder = selected;
				if (!name.trim() && selected.displayName) setName(selected.displayName.slice(0, 128));
			}
		} catch {
			if (lease.active && currentLease.current === lease) setPickFailed(true);
		} finally {
			selecting.current = false;
			if (lease.active && currentLease.current === lease) {
				setPicking(false);
				requestAnimationFrame(() => {
					if (lease.active && currentLease.current === lease) folderTrigger.current?.focus({ preventScroll: true });
				});
			}
		}
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
				if (!mutation.isPending && !creating.current && !selecting.current) {
					setOpen(value);
					onOpenChange?.(value);
					keyboard.current.reset();
					mutation.reset();
					setPickFailed(false);
					if (!value && folder) {
						void forgetFolder?.(folder.selectionId).catch(() => {});
						setFolder(undefined);
						lease.folder = undefined;
					}
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
				closeDisabled={mutation.isPending || picking}
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
							disabled={mutation.isPending || picking || disabled}
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
						{chooseFolder && (
							<div className="project-create-folder">
								<Button
									ref={folderTrigger}
									type="button"
									variant="outline"
									disabled={mutation.isPending || picking || disabled}
									onClick={() => void pickFolder()}
								>
									<FolderOpen size={16} aria-hidden="true" />
									{picking ? pl.loading : (folder?.displayName ?? pl.chooseOptional)}
								</Button>
								{folder && (
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										disabled={mutation.isPending || picking}
										aria-label={pl.removeSelection}
										onClick={() => {
											void forgetFolder?.(folder.selectionId).catch(() => {});
											setFolder(undefined);
											lease.folder = undefined;
										}}
									>
										<X size={15} aria-hidden="true" />
									</Button>
								)}
							</div>
						)}
						{pickFailed && <p role="alert">{pl.folderPickFailed}</p>}
						<p className="text-sm text-muted-foreground">{pl.creation}</p>
						<div className="project-create-actions">
							<DialogClose asChild>
								<Button type="button" variant="ghost" disabled={mutation.isPending || picking}>
									{t("common.cancel")}
								</Button>
							</DialogClose>
							<Button
								type="button"
								className="task-create-confirm"
								disabled={disabled || !preparedName || mutation.isPending || mutation.isError || picking}
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
