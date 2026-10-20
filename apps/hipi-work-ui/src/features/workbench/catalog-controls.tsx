import { type Conversation, PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Ellipsis, Pencil } from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef, useState, useSyncExternalStore } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { Input } from "../../components/ui/input.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import type { CatalogSession } from "./catalog-session.ts";
import type { CatalogCommand } from "./command-recovery.ts";
import { ComposerKeyboard } from "./composer-keyboard.ts";
import { PinConversationItem } from "./pin-conversation.tsx";
import type { PresentationSession } from "./presentation-session.ts";
import type { PreviewActions } from "./sidebar-preview-row.tsx";
import "./conversation-rename.css";

export function CatalogRecovery({
	session,
	onResolve,
}: {
	session: CatalogSession;
	onResolve: (operation: () => Promise<void>) => Promise<void>;
}) {
	const { locale } = usePreferences();
	const l = catalogLabels(locale);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	if (state.initialSend || state.submission) return null;
	if (!state.pending && !state.incompatible && !state.failed) return null;
	return (
		<section className="nav-feedback grid gap-2" aria-live="polite">
			<p role="alert">{l[state.incompatible ? "incompatible" : state.pending ? "pending" : "failed"]}</p>
			{state.pending && (
				<p className="break-all">
					{state.pending.method} /{" "}
					{"requestId" in state.pending.params ? state.pending.params.requestId : state.pending.params.workspaceId}
				</p>
			)}
			{state.pending && (
				<div className="break-all">
					<p>
						{state.pending.params.workspaceId} /{" "}
						{"conversationId" in state.pending.params ? state.pending.params.conversationId : ""}
					</p>
					{"title" in state.pending.params && <p>{state.pending.params.title}</p>}
					{"name" in state.pending.params && <p>{state.pending.params.name}</p>}
					{state.pending.method === "createConversation" && state.pending.params.model && (
						<p>
							{state.pending.params.model.provider} / {state.pending.params.model.modelId}
						</p>
					)}
					{state.pending.method === "archiveConversation" && <p>{l.archiveNote}</p>}
					{state.pending.method === "restoreConversation" && <p>{l.restoreNote}</p>}
				</div>
			)}
			{state.failed && state.pending && <p role="alert">{l.failed}</p>}
			{state.notFound && <p>{l.notFound}</p>}
			<Button
				size="sm"
				variant="outline"
				disabled={state.busy || state.incompatible || !state.pending}
				onClick={() => void onResolve(session.check)}
			>
				{l.check}
			</Button>
			{state.notFound && (
				<Button size="sm" variant="outline" disabled={state.busy} onClick={() => void onResolve(session.retry)}>
					{l.retry}
				</Button>
			)}
		</section>
	);
}
export function ConversationActions({
	conversation,
	session,
	guard,
	previewContent,
	menuPosition,
	onMenuOpen,
	onOverlayChange,
	onReturnFocus,
	triggerRef,
	presentation,
}: {
	conversation: Conversation;
	session: CatalogSession;
	guard: (action: () => void) => void;
	previewContent?: ReactNode;
	menuPosition?: Parameters<PreviewActions>[0]["menuPosition"];
	onMenuOpen?: () => void;
	onOverlayChange?: (owner: "menu" | "dialog", open: boolean) => void;
	onReturnFocus?: () => void;
	triggerRef?: RefObject<HTMLButtonElement | null>;
	presentation?: PresentationSession;
}) {
	const { locale } = usePreferences();
	const l = catalogLabels(locale);
	const cache = useQueryClient();
	const [renaming, setRenaming] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [title, setTitle] = useState(conversation.title);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const titleId = useId();
	const titleInput = useRef<HTMLInputElement>(null);
	const renameKeyboard = useRef(new ComposerKeyboard());
	const renameOpen = useRef(false);
	const ownTrigger = useRef<HTMLButtonElement>(null);
	const trigger = triggerRef ?? ownTrigger;
	const disabled = state.busy || !!state.pending || state.incompatible;
	const renameDisabled = disabled || !!state.initialSend;
	const closeRename = () => {
		if (session.getSnapshot().busy) return;
		renameOpen.current = false;
		renameKeyboard.current.reset();
		setRenaming(false);
		onOverlayChange?.("dialog", false);
	};
	const execute = (command: CatalogCommand) => {
		guard(() => {
			const previous = session.getSnapshot();
			if (previous.busy || previous.pending || previous.initialSend || previous.incompatible) return;
			void session.execute(command).then(() => {
				const resultState = session.getSnapshot();
				if (
					resultState === previous ||
					resultState.pending ||
					resultState.failed ||
					resultState.resultMethod !== command.method
				)
					return;
				const result = resultState.result;
				if (
					result &&
					"conversationId" in result &&
					result.workspaceId === command.params.workspaceId &&
					"conversationId" in command.params &&
					result.conversationId === command.params.conversationId
				) {
					cache.setQueryData(["conversation", result.workspaceId, result.conversationId], result);
					void cache.invalidateQueries({ queryKey: ["conversations", result.workspaceId] });
					if (presentation) {
						void cache.invalidateQueries({ queryKey: ["pinned-conversations"] });
						void cache.invalidateQueries({
							queryKey: ["conversation-presentation", result.workspaceId, result.conversationId],
						});
					}
					if (command.method === "renameConversation") {
						closeRename();
					}
				}
			});
		});
	};
	const saveRename = () => {
		if (!renameOpen.current || renameDisabled || !title.trim()) return;
		execute({
			version: PROTOCOL_VERSION,
			method: "renameConversation",
			params: {
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
				requestId: crypto.randomUUID(),
				expectedRevision: conversation.revision,
				title: title.trim(),
			},
		});
	};
	return (
		<Dialog
			open={renaming}
			onOpenChange={(open) => {
				if (!open) closeRename();
			}}
		>
			<DropdownMenu
				onOpenChange={(open) => {
					setMenuOpen(open);
					onOverlayChange?.("menu", open);
					if (open) onMenuOpen?.();
				}}
			>
				<DropdownMenuTrigger asChild>
					<Button
						ref={trigger}
						className="conversation-actions-trigger"
						size="icon-sm"
						variant="ghost"
						aria-label={`${l.actions}: ${conversation.title}`}
					>
						<Ellipsis size={16} aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					side={menuPosition ? "right" : "bottom"}
					align={menuPosition ? "start" : "end"}
					sideOffset={menuPosition?.sideOffset}
					alignOffset={menuPosition?.alignOffset}
					collisionPadding={12}
					className="conversation-action-menu"
					onCloseAutoFocus={(event) => {
						if (renaming) event.preventDefault();
						else if (onReturnFocus) {
							event.preventDefault();
							onReturnFocus();
						}
					}}
				>
					<DropdownMenuLabel className="sidebar-menu-preview">{previewContent ?? conversation.title}</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{presentation && (
						<PinConversationItem
							conversation={conversation}
							session={presentation}
							open={menuOpen}
							disabled={disabled}
						/>
					)}
					<DropdownMenuItem
						disabled={renameDisabled}
						onSelect={() => {
							const current = session.getSnapshot();
							if (current.busy || current.pending || current.initialSend || current.incompatible) return;
							setTitle(conversation.title);
							renameKeyboard.current.reset();
							renameOpen.current = true;
							onOverlayChange?.("dialog", true);
							setRenaming(true);
						}}
					>
						<Pencil size={15} aria-hidden="true" />
						{l.rename}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={disabled}
						onSelect={() => {
							execute({
								version: PROTOCOL_VERSION,
								method: conversation.archivedAt === null ? "archiveConversation" : "restoreConversation",
								params: {
									workspaceId: conversation.workspaceId,
									conversationId: conversation.conversationId,
									requestId: crypto.randomUUID(),
									expectedRevision: conversation.revision,
								},
							});
						}}
					>
						{conversation.archivedAt === null ? (
							<Archive size={15} aria-hidden="true" />
						) : (
							<ArchiveRestore size={15} aria-hidden="true" />
						)}
						{l[conversation.archivedAt === null ? "archive" : "restore"]}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<DialogContent
				className="conversation-rename-dialog"
				closeLabel={l.close}
				closeDisabled={state.busy}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					titleInput.current?.focus();
					titleInput.current?.select();
				}}
				onEscapeKeyDown={(event) => {
					if (event.isComposing || event.keyCode === 229 || session.getSnapshot().busy) event.preventDefault();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (onReturnFocus) onReturnFocus();
					else trigger.current?.focus();
				}}
			>
				<DialogTitle>{l.rename}</DialogTitle>
				<DialogDescription>{l.renameNote}</DialogDescription>
				<form
					className="conversation-rename-form"
					onSubmit={(event) => {
						event.preventDefault();
						// Enter is owned below so confirming IME input cannot submit implicitly.
					}}
				>
					<label htmlFor={titleId}>
						{l.title}
						<Input
							ref={titleInput}
							className="conversation-rename-input"
							id={titleId}
							value={title}
							disabled={renameDisabled}
							maxLength={128}
							autoComplete="off"
							onChange={(event) => setTitle(event.target.value)}
							onCompositionStart={() => renameKeyboard.current.compositionStart()}
							onCompositionEnd={(event) => renameKeyboard.current.compositionEnd(event.timeStamp)}
							onBlur={() => renameKeyboard.current.reset()}
							onKeyUp={() => renameKeyboard.current.keyUp()}
							onKeyDown={(event) => {
								const action = renameKeyboard.current.keyDown(event.nativeEvent);
								if (action !== "native") event.preventDefault();
								if (action === "submit") saveRename();
							}}
						/>
					</label>
					{state.failed && <p role="alert">{l.failed}</p>}
					{state.pending && <p role="alert">{l.pending}</p>}
					<div className="conversation-rename-actions">
						<Button
							type="button"
							className="conversation-rename-cancel"
							variant="ghost"
							disabled={state.busy}
							onClick={closeRename}
						>
							{state.pending ? l.close : l.cancel}
						</Button>
						<Button
							type="button"
							className="conversation-rename-save"
							disabled={renameDisabled || !title.trim()}
							onClick={saveRename}
						>
							{l.save}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
