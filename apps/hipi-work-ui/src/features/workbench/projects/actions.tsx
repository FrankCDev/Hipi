import { PROTOCOL_VERSION, type Project, type ProjectListItem } from "@hipi/work-runtime/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { usePresence } from "framer-motion";
import { Archive, Ellipsis, MessageCircle, Pencil, Pin, PinOff } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import type { CatalogSession } from "../catalog/session.ts";
import type { ProjectCatalogCommand } from "../command-recovery.ts";
import type { PreviewActions } from "../sidebar/preview-row.tsx";
import { matchesProjectCommand } from "./commands.ts";
import { projectFolderLabels } from "./folder-labels.ts";
import { projectLabels } from "./labels.ts";
import { ProjectRenameDialog } from "./rename.tsx";

/** One logical project action owner, regardless of the row's menu entry mechanism. */
export function ProjectActions({
	item,
	projectPinEnabled = false,
	session,
	guard,
	controls,
	filter,
	onFilterChange,
	onManageFolder,
}: {
	item: ProjectListItem;
	projectPinEnabled?: boolean;
	session: CatalogSession;
	guard: (action: () => void) => void;
	controls: Parameters<PreviewActions>[0];
	filter: "active" | "archived";
	onFilterChange: (filter: "active" | "archived") => void;
	onManageFolder?: () => void;
}) {
	const { locale } = usePreferences();
	const l = projectLabels(locale);
	const cl = catalogLabels(locale);
	const cache = useQueryClient();
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const [renaming, setRenaming] = useState<Project | null>(null);
	const renameTarget = useRef<Project | null>(null);
	const renameRequest = useRef<ProjectCatalogCommand | null>(null);
	const [present, safeToRemove] = usePresence();
	useEffect(() => {
		if (!present && !renaming) safeToRemove?.();
	}, [present, renaming, safeToRemove]);
	const disabled = state.busy || !!state.pending || !!state.initialSend || state.incompatible;
	const [standaloneOpen, setStandaloneOpen] = useState(false);
	const open = controls.rowMenu?.open ?? standaloneOpen;
	const closeRename = () => {
		if (session.getSnapshot().busy) return;
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
	const execute = (command: Extract<ProjectCatalogCommand, { method: "renameProject" | "setProjectPinned" }>) => {
		if (
			command.method === "setProjectPinned" &&
			(!projectPinEnabled || item.presentation.projectId !== command.params.projectId)
		)
			return;
		guard(() => {
			const current = session.getSnapshot();
			if (current.busy || current.pending || current.initialSend || current.incompatible) return;
			if (command.method === "renameProject") renameRequest.current = command;
			void session.execute(command).then(() => {
				const result = session.getSnapshot();
				if (result.failed && !result.pending) {
					void cache.invalidateQueries({ queryKey: ["projects"] });
					void cache.invalidateQueries({ queryKey: ["project", command.params.projectId] });
				}
				if (
					result.pending ||
					result.failed ||
					!result.projectResult ||
					!matchesProjectCommand(command, result.projectResult)
				)
					return;
				if (result.projectResult.method === "renameProject")
					cache.setQueryData(["project", result.projectResult.result.projectId], result.projectResult.result);
				for (const key of [
					["projects"],
					["project", command.params.projectId],
					["project-catalog"],
					["sidebar-navigation"],
					["sidebar-pins"],
				])
					void cache.invalidateQueries({ queryKey: key });
			});
		});
	};
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
						<ActionMenuItem
							disabled={disabled || item.presentation.projectId !== item.project.projectId}
							onSelect={() =>
								execute({
									version: PROTOCOL_VERSION,
									method: "setProjectPinned",
									params: {
										requestId: crypto.randomUUID(),
										projectId: item.project.projectId,
										expectedPresentationRevision: item.presentation.revision,
										pinned: !item.presentation.pinned,
									},
								})
							}
						>
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
							const current = session.getSnapshot();
							if (current.busy || current.pending || current.initialSend || current.incompatible) return;
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
						execute({
							version: PROTOCOL_VERSION,
							method: "renameProject",
							params: {
								requestId: crypto.randomUUID(),
								projectId: target.projectId,
								expectedRevision: target.revision,
								name: name.trim(),
							},
						});
					}}
				/>
			)}
		</>
	);
}
