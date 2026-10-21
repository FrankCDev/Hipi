import type { Conversation, Scope } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { Pin, PinOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { ActionMenuItem } from "../../../components/ui/action-menu.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { SidebarActionTooltip } from "./action-tooltip.tsx";
import { pinLabels } from "./pin-labels.ts";
import type { PresentationSession } from "./presentation-session.ts";

export const presentationKey = (scope: Scope) => ["conversation-presentation", scope.workspaceId, scope.conversationId];

function usePinAction({
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
	const current =
		query.data?.workspaceId === conversation.workspaceId && query.data.conversationId === conversation.conversationId
			? query.data
			: undefined;
	return {
		l,
		current,
		isError: query.isError,
		isFetching: query.isFetching,
		reload: () => void query.refetch(),
		disabled: disabled || !current || query.isFetching || state.busy || !!state.pending || state.incompatible,
		toggle: () => {
			if (!current || disabled || query.isFetching || query.isError || conversation.archivedAt !== null) return;
			void session.execute({
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
				requestId: crypto.randomUUID(),
				expectedPresentationRevision: current.revision,
				pinned: !current.pinned,
			});
		},
	};
}

type PinProps = Parameters<typeof usePinAction>[0];

export function PinConversationItem(props: PinProps) {
	const { conversation } = props;
	const action = usePinAction(props);
	if (conversation.archivedAt !== null) return null;
	if (action.isError)
		return (
			<ActionMenuItem
				disabled={action.isFetching}
				onSelect={(event) => {
					event.preventDefault();
					action.reload();
				}}
			>
				{action.l.reload}
			</ActionMenuItem>
		);
	return (
		<ActionMenuItem data-action="pin-conversation" disabled={action.disabled} onSelect={action.toggle}>
			{action.current?.pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
			{action.current ? action.l[action.current.pinned ? "unpin" : "pin"] : action.l.loading}
		</ActionMenuItem>
	);
}

/** The direct action shares the menu's exact query, CAS and recovery owner. */
export function PinConversationButton(props: PinProps) {
	const action = usePinAction(props);
	if (props.conversation.archivedAt !== null) return null;
	const label = action.isError
		? action.l.reload
		: action.current
			? action.l[action.current.pinned ? "unpin" : "pin"]
			: action.l.loading;
	return (
		<SidebarActionTooltip label={label}>
			<Button
				variant="ghost"
				size="icon-sm"
				className="conversation-quick-action"
				data-action="pin-conversation-direct"
				aria-label={label}
				disabled={action.isError ? action.isFetching : action.disabled}
				onClick={action.isError ? action.reload : action.toggle}
			>
				{action.current?.pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
			</Button>
		</SidebarActionTooltip>
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
				{state.order && !state.incompatible
					? l[state.rejected ? "orderRejected" : state.pending ? "orderPending" : "orderFailed"]
					: l[state.incompatible ? "incompatible" : state.rejected ? "rejected" : state.pending ? "pending" : "failed"]}
			</p>
			{state.pending && (
				<Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void session.check()}>
					{state.order ? l.orderCheck : l.check}
				</Button>
			)}
			{state.pending && state.notFound && (
				<>
					<p>{l.notFound}</p>
					<Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void session.retry()}>
						{state.order ? l.orderRetry : l.retry}
					</Button>
				</>
			)}
		</section>
	);
}
