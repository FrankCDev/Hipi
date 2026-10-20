import type { Conversation, Scope } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { Pin, PinOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { DropdownMenuItem } from "../../components/ui/dropdown-menu.tsx";
import { pinLabels } from "./pin-labels.ts";
import type { PresentationSession } from "./presentation-session.ts";

export const presentationKey = (scope: Scope) => ["conversation-presentation", scope.workspaceId, scope.conversationId];

export function PinConversationItem({
	conversation,
	session,
	open,
	disabled = false,
}: {
	conversation: Conversation;
	session: PresentationSession;
	open: boolean;
	disabled?: boolean;
}) {
	const client = useAppClient();
	const { locale } = usePreferences();
	const l = pinLabels(locale);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const query = useQuery({
		queryKey: presentationKey(conversation),
		queryFn: ({ signal }) =>
			client.call(
				"getConversationPresentation",
				{ workspaceId: conversation.workspaceId, conversationId: conversation.conversationId },
				signal,
			),
		enabled: open,
		staleTime: 0,
	});
	if (conversation.archivedAt !== null) return null;
	if (query.isError)
		return (
			<DropdownMenuItem
				disabled={query.isFetching}
				onSelect={(event) => {
					event.preventDefault();
					void query.refetch();
				}}
			>
				{l.reload}
			</DropdownMenuItem>
		);
	const current =
		query.data?.workspaceId === conversation.workspaceId && query.data.conversationId === conversation.conversationId
			? query.data
			: undefined;
	return (
		<DropdownMenuItem
			data-action="pin-conversation"
			disabled={disabled || !current || query.isFetching || state.busy || !!state.pending || state.incompatible}
			onSelect={() => {
				if (!current || disabled || query.isFetching || conversation.archivedAt !== null) return;
				void session.execute({
					workspaceId: conversation.workspaceId,
					conversationId: conversation.conversationId,
					requestId: crypto.randomUUID(),
					expectedPresentationRevision: current.revision,
					pinned: !current.pinned,
				});
			}}
		>
			{current?.pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
			{current ? l[current.pinned ? "unpin" : "pin"] : l.loading}
		</DropdownMenuItem>
	);
}

export function PinRecovery({ session }: { session: PresentationSession }) {
	const { locale } = usePreferences();
	const l = pinLabels(locale);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	if (!state.incompatible && !state.failed && !state.pending) return null;
	return (
		<section className="nav-feedback pin-recovery" aria-live="polite">
			<p role={state.failed || state.incompatible ? "alert" : undefined}>
				{l[state.incompatible ? "incompatible" : state.rejected ? "rejected" : state.pending ? "pending" : "failed"]}
			</p>
			{state.pending && (
				<Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void session.check()}>
					{l.check}
				</Button>
			)}
			{state.pending && state.notFound && (
				<>
					<p>{l.notFound}</p>
					<Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void session.retry()}>
						{l.retry}
					</Button>
				</>
			)}
		</section>
	);
}
