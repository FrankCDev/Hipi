import { type Conversation, PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { matchesBinding } from "../../../app/keybindings.ts";
import { usePreferences } from "../../../app/preferences.tsx";
import { ActionTooltip } from "../../../components/ui/action-tooltip.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { executeConversationCommand } from "../catalog/conversation-command.ts";
import { catalogLabels } from "../catalog/labels.ts";
import type { CatalogSession } from "../catalog/session.ts";
import { ComposerKeyboard, DEFAULT_EDITOR_KEYBINDINGS as submitBindings } from "../composer/keyboard.ts";
import "./header.css";

export const DEFAULT_EDITOR_KEYBINDINGS = { ...submitBindings, cancel: "Escape" };

type HeaderProps = {
	conversation: Conversation;
	projectName?: string;
	session: CatalogSession;
	editorBindings?: typeof DEFAULT_EDITOR_KEYBINDINGS;
};

/** Changing scope/session retires only the local editor, never its persisted catalog command. */
export function ConversationHeaderIdentity(props: HeaderProps) {
	return (
		<HeaderIdentity
			key={JSON.stringify([props.conversation.workspaceId, props.conversation.conversationId])}
			{...props}
		/>
	);
}

function HeaderIdentity({
	conversation,
	projectName,
	session,
	editorBindings = DEFAULT_EDITOR_KEYBINDINGS,
}: HeaderProps) {
	const { locale } = usePreferences();
	const labels = catalogLabels(locale);
	const cache = useQueryClient();
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const [edit, setEdit] = useState<{ title: string; original: string; revision: number }>();
	const [failed, setFailed] = useState(false);
	const [saving, setSaving] = useState(false);
	const title = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const keyboard = useRef(new ComposerKeyboard());
	const composing = useRef(false);
	const submitting = useRef(false);
	const attempted = useRef(false);
	const cancelled = useRef(false);
	const restoreFocus = useRef(false);
	const generation = useRef(0);
	const feedbackId = useId();
	const blocked = state.busy || !!state.pending || !!state.initialSend || state.incompatible;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Replacing the catalog owner retires this editor and its asynchronous completion.
	useLayoutEffect(() => {
		generation.current++;
		submitting.current = false;
		attempted.current = false;
		setEdit(undefined);
		setFailed(false);
		setSaving(false);
		return () => {
			generation.current++;
		};
	}, [session]);
	const editing = edit !== undefined;
	useLayoutEffect(() => {
		if (editing) {
			input.current?.focus({ preventScroll: true });
			input.current?.select();
		} else if (restoreFocus.current) {
			restoreFocus.current = false;
			title.current?.focus({ preventScroll: true });
		}
	}, [editing]);
	// Recovery remains catalog-owned. Retire the retained draft only once its desired title is confirmed.
	useLayoutEffect(() => {
		const result = state.result;
		if (!failed || !edit || blocked || state.failed || state.resultMethod !== "renameConversation") return;
		if (!result || !("conversationId" in result)) return;
		if (result.workspaceId !== conversation.workspaceId || result.conversationId !== conversation.conversationId)
			return;
		if (result.title !== edit.title.trim() || result.revision <= edit.revision) return;
		setEdit(undefined);
		setFailed(false);
	}, [
		failed,
		edit,
		blocked,
		state.failed,
		state.resultMethod,
		state.result,
		conversation.workspaceId,
		conversation.conversationId,
	]);
	const save = () => {
		if (!edit || cancelled.current || submitting.current || attempted.current || composing.current) return;
		const value = edit.title.trim();
		if (!value || value === edit.original) {
			setEdit(undefined);
			return;
		}
		if (blocked) return;
		attempted.current = true;
		submitting.current = true;
		setSaving(true);
		setFailed(false);
		const owner = generation.current;
		void executeConversationCommand(
			session,
			cache,
			{
				version: PROTOCOL_VERSION,
				method: "renameConversation",
				params: {
					workspaceId: conversation.workspaceId,
					conversationId: conversation.conversationId,
					requestId: crypto.randomUUID(),
					expectedRevision: edit.revision,
					title: value,
				},
			},
			true,
		).then(
			(result) => {
				if (generation.current !== owner) return;
				submitting.current = false;
				setSaving(false);
				if (result) setEdit(undefined);
				else setFailed(true);
			},
			() => {
				if (generation.current !== owner) return;
				submitting.current = false;
				setSaving(false);
				setFailed(true);
			},
		);
	};
	return (
		<div className="conversation-header-identity">
			{projectName && (
				<ActionTooltip label={projectName} side="bottom">
					<span className="conversation-header-project" role="img" aria-label={projectName}>
						<Icon name="folder" size={16} />
					</span>
				</ActionTooltip>
			)}
			<div className="conversation-header-title-owner">
				{edit ? (
					<input
						ref={input}
						className="conversation-header-title conversation-header-title-input"
						aria-label={labels.title}
						aria-describedby={failed ? feedbackId : undefined}
						aria-busy={saving}
						value={edit.title}
						readOnly={blocked || saving}
						maxLength={128}
						size={Math.max(1, edit.title.length)}
						autoComplete="off"
						onChange={(event) => setEdit({ ...edit, title: event.target.value })}
						onBlur={save}
						onCompositionStart={() => {
							composing.current = true;
							keyboard.current.compositionStart();
						}}
						onCompositionEnd={(event) => {
							composing.current = false;
							keyboard.current.compositionEnd(event.timeStamp);
						}}
						onKeyUp={() => keyboard.current.keyUp()}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
							if (matchesBinding(event, editorBindings.cancel)) {
								if (saving) return;
								event.preventDefault();
								cancelled.current = true;
								restoreFocus.current = true;
								setEdit(undefined);
								setFailed(false);
								return;
							}
							const action = keyboard.current.keyDown(event.nativeEvent, editorBindings);
							if (action !== "native") event.preventDefault();
							if (action === "submit") event.currentTarget.blur();
						}}
					/>
				) : (
					<button
						ref={title}
						type="button"
						className="conversation-header-title"
						disabled={blocked}
						aria-label={labels.rename}
						onClick={() => {
							if (blocked) return;
							cancelled.current = false;
							attempted.current = false;
							keyboard.current.reset();
							setFailed(false);
							setEdit({ title: conversation.title, original: conversation.title, revision: conversation.revision });
						}}
					>
						{conversation.title}
					</button>
				)}
				{failed && (
					<p className="conversation-header-rename-feedback" id={feedbackId} role="alert">
						{state.pending ? labels.pending : labels.failed}
					</p>
				)}
			</div>
		</div>
	);
}
