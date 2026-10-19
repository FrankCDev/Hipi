import { type Conversation, PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";
import { type RefObject, useId, useRef, useState, useSyncExternalStore } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { Input } from "../../components/ui/input.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import type { CatalogSession } from "./catalog-session.ts";
import type { CatalogCommand } from "./command-recovery.ts";

export function CatalogRecovery({ session, onResolved }: { session: CatalogSession; onResolved: () => void }) {
	const { locale } = usePreferences();
	const l = catalogLabels(locale);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
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
				onClick={() => void session.check().then(onResolved)}
			>
				{l.check}
			</Button>
			{state.notFound && (
				<Button size="sm" variant="outline" disabled={state.busy} onClick={() => void session.retry().then(onResolved)}>
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
	onPreview,
	onMenuOpen,
	triggerRef,
}: {
	conversation: Conversation;
	session: CatalogSession;
	guard: (action: () => void) => void;
	onPreview?: () => void;
	onMenuOpen?: () => void;
	triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
	const { locale } = usePreferences();
	const l = catalogLabels(locale);
	const cache = useQueryClient();
	const [action, setAction] = useState<"rename" | "archive" | "restore" | null>(null);
	const [title, setTitle] = useState(conversation.title);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const titleId = useId();
	const ownTrigger = useRef<HTMLButtonElement>(null);
	const trigger = triggerRef ?? ownTrigger;
	const previewSelected = useRef(false);
	const disabled = state.busy || !!state.pending || state.incompatible;
	return (
		<Dialog
			open={action !== null}
			onOpenChange={(open) => {
				if (!open && !state.busy) setAction(null);
			}}
		>
			<DropdownMenu
				onOpenChange={(open) => {
					if (open) onMenuOpen?.();
				}}
			>
				<DropdownMenuTrigger asChild>
					<Button
						ref={trigger}
						className="conversation-actions-trigger"
						size="icon-sm"
						variant="ghost"
						disabled={disabled && !onPreview}
						aria-label={`${l.actions}: ${conversation.title}`}
					>
						<Ellipsis size={16} aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					onCloseAutoFocus={(event) => {
						if (action || previewSelected.current) event.preventDefault();
						previewSelected.current = false;
					}}
				>
					{onPreview && (
						<DropdownMenuItem
							onSelect={() => {
								previewSelected.current = true;
								onPreview();
							}}
						>
							{l.preview}
						</DropdownMenuItem>
					)}
					<DropdownMenuItem
						disabled={disabled}
						onSelect={() => {
							setTitle(conversation.title);
							setAction("rename");
						}}
					>
						{l.rename}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={disabled}
						onSelect={() => setAction(conversation.archivedAt === null ? "archive" : "restore")}
					>
						{l[conversation.archivedAt === null ? "archive" : "restore"]}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<DialogContent
				closeLabel={l.close}
				closeDisabled={state.busy}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					trigger.current?.focus();
				}}
			>
				<DialogTitle>{l[action ?? "rename"]}</DialogTitle>
				<DialogDescription>
					{l[action === "archive" ? "archiveNote" : action === "restore" ? "restoreNote" : "renameNote"]}
				</DialogDescription>
				<p className="break-all">
					{conversation.workspaceId} / {conversation.conversationId}
				</p>
				{action === "rename" && (
					<label htmlFor={titleId}>
						{l.title}
						<Input
							id={titleId}
							value={title}
							disabled={disabled}
							maxLength={128}
							onChange={(event) => setTitle(event.target.value)}
						/>
					</label>
				)}
				{state.failed && <p role="alert">{l.failed}</p>}
				{state.pending && <p role="alert">{l.pending}</p>}
				<Button
					disabled={disabled || (action === "rename" && !title.trim())}
					onClick={() => {
						if (!action) return;
						const params = {
							workspaceId: conversation.workspaceId,
							conversationId: conversation.conversationId,
							requestId: crypto.randomUUID(),
							expectedRevision: conversation.revision,
						};
						const command: CatalogCommand =
							action === "rename"
								? {
										version: PROTOCOL_VERSION,
										method: "renameConversation" as const,
										params: { ...params, title: title.trim() },
									}
								: {
										version: PROTOCOL_VERSION,
										method: action === "archive" ? ("archiveConversation" as const) : ("restoreConversation" as const),
										params,
									};
						guard(() => {
							void session.execute(command).then(() => {
								if (!session.getSnapshot().pending && !session.getSnapshot().failed) {
									const result = session.getSnapshot().result;
									if (result && "conversationId" in result) {
										cache.setQueryData(["conversation", result.workspaceId, result.conversationId], result);
										void cache.invalidateQueries({ queryKey: ["conversations", result.workspaceId] });
									}
									setAction(null);
								}
							});
						});
					}}
				>
					{l.confirm}
				</Button>
			</DialogContent>
		</Dialog>
	);
}
