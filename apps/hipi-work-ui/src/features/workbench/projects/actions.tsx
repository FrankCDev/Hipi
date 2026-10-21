import type { Project, ProjectListItem } from "@hipi/work-runtime/contracts";
import { usePresence } from "framer-motion";
import { Archive, Ellipsis, MessageCircle, Pencil, Pin, PinOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import {
	ActionMenu,
	ActionMenuContent,
	ActionMenuItem,
	ActionMenuLabel,
	ActionMenuRadioGroup,
	ActionMenuRadioItem,
	ActionMenuSeparator,
	ActionMenuTrigger,
} from "../../../components/ui/action-menu.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import type { ProjectCatalogCommand } from "../command-recovery.ts";
import type { PreviewActions } from "../sidebar/preview-row.tsx";
import type { ProjectActionOwner } from "./action-owner.ts";
import { matchesProjectCommand } from "./commands.ts";
import { projectFolderLabels } from "./folder-labels.ts";
import { projectLabels } from "./labels.ts";
import { ProjectRenameDialog } from "./rename.tsx";

/** One logical project action owner, regardless of the row's menu entry mechanism. */
export function ProjectActions({
	item,
	owner,
	controls,
	filter,
	onFilterChange,
	onManageFolder,
}: {
	item: ProjectListItem;
	owner: ProjectActionOwner;
	controls: Parameters<PreviewActions>[0];
	filter: "active" | "archived";
	onFilterChange: (filter: "active" | "archived") => void;
	onManageFolder?: () => void;
}) {
	const { locale } = usePreferences();
	const l = projectLabels(locale);
	const cl = catalogLabels(locale);
	const { state, disabled, projectPinEnabled } = owner;
	const [renaming, setRenaming] = useState<Project | null>(null);
	const renameTarget = useRef<Project | null>(null);
	const renameRequest = useRef<ProjectCatalogCommand | null>(null);
	const [present, safeToRemove] = usePresence();
	useEffect(() => {
		if (!present && !renaming) safeToRemove?.();
	}, [present, renaming, safeToRemove]);
	const [standaloneOpen, setStandaloneOpen] = useState(false);
	const open = controls.rowMenu?.open ?? standaloneOpen;
	const closeRename = () => {
		if (owner.isBusy()) return;
		renameTarget.current = null;
		renameRequest.current = null;
		setRenaming(null);
		controls.onOverlayChange("dialog", false);
	};
	useEffect(() => {
		const request = renameRequest.current;
		if (!request || !state.projectResult || !matchesProjectCommand(request, state.projectResult)) return;
		renameTarget.current = null;
		renameRequest.current = null;
		setRenaming(null);
		controls.onOverlayChange("dialog", false);
	}, [state.projectResult, controls]);
	return (
		<>
			<ActionMenu
				boundary={controls.rowMenu}
				open={open && !controls.hidden}
				onOpenChange={(value) => {
					setStandaloneOpen(value);
					controls.onOverlayChange("menu", value);
					if (value) controls.onMenuOpen();
				}}
			>
				<ActionMenuTrigger asChild>
					<Button
						ref={controls.triggerRef}
						variant="ghost"
						size="icon-sm"
						className="project-actions-trigger"
						aria-label={`${cl.projectActions}: ${item.project.name}`}
					>
						<Ellipsis size={16} aria-hidden="true" />
					</Button>
				</ActionMenuTrigger>
				<ActionMenuContent
					side="right"
					align="start"
					sideOffset={controls.menuPosition.sideOffset}
					alignOffset={controls.menuPosition.alignOffset}
					collisionPadding={12}
					className="project-action-menu"
					data-sidebar-row-portal=""
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (!renameTarget.current) controls.onReturnFocus();
					}}
				>
					<ActionMenuLabel className="sidebar-menu-preview">{controls.previewContent}</ActionMenuLabel>
					<ActionMenuSeparator />
					{projectPinEnabled && (
						<ActionMenuItem disabled={owner.pinDisabled} onSelect={owner.togglePin}>
							{item.presentation.pinned ? (
								<PinOff size={16} aria-hidden="true" />
							) : (
								<Pin size={16} aria-hidden="true" />
							)}
							{item.presentation.pinned ? l.unpin : l.pin}
						</ActionMenuItem>
					)}
					<ActionMenuItem
						disabled={disabled}
						onSelect={() => {
							if (!owner.canAct()) return;
							const target = { ...item.project };
							renameTarget.current = target;
							setRenaming(target);
							controls.onOverlayChange("dialog", true);
						}}
					>
						<Pencil size={16} aria-hidden="true" />
						{l.rename}
					</ActionMenuItem>
					{onManageFolder && (
						<>
							<ActionMenuSeparator />
							<ActionMenuItem onSelect={onManageFolder}>
								<Icon name="folder" size={16} />
								{projectFolderLabels(locale).title}
							</ActionMenuItem>
						</>
					)}
					<ActionMenuSeparator />
					<ActionMenuRadioGroup
						aria-label={cl.filter}
						value={filter}
						onValueChange={(value) => {
							if (value === "active" || value === "archived") onFilterChange(value);
						}}
					>
						<ActionMenuRadioItem value="active">
							<MessageCircle size={16} aria-hidden="true" />
							{cl.active}
						</ActionMenuRadioItem>
						<ActionMenuRadioItem value="archived">
							<Archive size={16} aria-hidden="true" />
							{cl.archived}
						</ActionMenuRadioItem>
					</ActionMenuRadioGroup>
				</ActionMenuContent>
			</ActionMenu>
			{renaming && (
				<ProjectRenameDialog
					name={renaming.name}
					disabled={disabled}
					busy={state.busy}
					pending={!!state.pending}
					failed={state.failed}
					onClose={closeRename}
					onReturnFocus={() => controls.onReturnFocus("dialog")}
					onSave={(name) => {
						const target = renameTarget.current;
						if (!target || disabled || !name.trim() || name.trim().length > 128) return;
						renameRequest.current = owner.renameProject(target, name);
					}}
				/>
			)}
		</>
	);
}
