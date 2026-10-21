import type {
	AppClient,
	ConversationExecution,
	Scope,
	Snapshot,
	ToolActivity,
	ToolActivityPage,
	ToolActivitySelector,
} from "@hipi/work-runtime/contracts";
import { usePageInView } from "framer-motion";
import { type RefObject, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MessageProjection, selectionIntersects } from "../workbench/conversation/message-projection.ts";
import { ActivitySession, type ActivityState } from "./activity-session.ts";
export type LiveActivityRead = { session?: ActivitySession; state: ActivityState; active: boolean };
const emptyState: ActivityState = { busy: false, failed: false };
const subscribeEmpty = () => () => {};
const getEmpty = () => emptyState;
export function useLiveActivityRead(
	client: AppClient,
	scope: Scope,
	snapshot: Snapshot | undefined,
	active: boolean,
	rootRef?: RefObject<HTMLElement | null>,
): LiveActivityRead {
	const visible = usePageInView();
	const identity = JSON.stringify([
		snapshot?.execution?.ownerTaskId,
		snapshot?.execution?.tools.items.flatMap((item) => (item.taskId ? [[item.taskId, item.callId]] : [])) ?? [],
	]);
	const { selector, expectedCalls } = useMemo(() => {
		const [, pairs] = JSON.parse(identity) as [string | undefined, [string, string][]];
		return {
			selector: { kind: "tasks", taskIds: [...new Set(pairs.map(([id]) => id))] } as ToolActivitySelector,
			expectedCalls: new Map(pairs),
		};
	}, [identity]);
	const session = useMemo(
		() =>
			selector.kind === "tasks" && selector.taskIds.length > 0
				? new ActivitySession(
						client,
						{ workspaceId: scope.workspaceId, conversationId: scope.conversationId },
						selector,
						expectedCalls,
					)
				: undefined,
		[client, scope.workspaceId, scope.conversationId, selector, expectedCalls],
	);
	const state = useSyncExternalStore(
		session?.subscribe ?? subscribeEmpty,
		session?.snapshot ?? getEmpty,
		session?.snapshot ?? getEmpty,
	);
	const [display, setDisplay] = useState<{ session: ActivitySession | undefined; page: ToolActivityPage | undefined }>({
		session,
		page: undefined,
	});
	const pageProjection = useMemo(
		() =>
			new MessageProjection<ToolActivityPage | undefined>(
				undefined,
				(page) => setDisplay({ session, page }),
				() => selectionIntersects(rootRef?.current ?? null, document.getSelection()),
			),
		[session, rootRef],
	);
	useEffect(() => {
		pageProjection.update(state.page, false);
	}, [pageProjection, state.page]);
	useEffect(() => {
		const flush = () => pageProjection.flush();
		document.addEventListener("selectionchange", flush);
		return () => {
			document.removeEventListener("selectionchange", flush);
			pageProjection.dispose();
		};
	}, [pageProjection]);
	useEffect(() => {
		session?.activate();
		return () => session?.dispose();
	}, [session]);
	const enabled =
		active &&
		visible &&
		snapshot?.running === true &&
		snapshot.workspaceId === scope.workspaceId &&
		snapshot.conversationId === scope.conversationId &&
		selector.kind === "tasks" &&
		selector.taskIds.length > 0;
	useEffect(() => {
		if (!session) return;
		if (!enabled) {
			session.cancel();
			return;
		}
		if (state.failed || state.expanded) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			if (!selectionIntersects(rootRef?.current ?? null, document.getSelection())) await session.page();
			if (!stopped && !session.snapshot().failed) timer = setTimeout(() => void refresh(), 2000);
		};
		void refresh();
		return () => {
			stopped = true;
			clearTimeout(timer);
			if (!session.snapshot().expanded) session.cancel();
		};
	}, [session, enabled, state.failed, state.expanded, rootRef]);
	return {
		session,
		state: { ...state, page: display.session === session ? display.page : undefined },
		active: active && visible && snapshot?.running === true,
	};
}
/** Only the server-proven full model anchor can move a live record into a committed row. */
export function anchoredLiveActivities(
	snapshot: Snapshot | undefined,
	page: ToolActivityPage | undefined,
): ReadonlyMap<string, readonly ToolActivity[]> {
	const groups = new Map<string, ToolActivity[]>();
	if (!snapshot?.execution || !snapshot.running || !page) return groups;
	const messages = new Set(
		snapshot.messages
			.filter((message) => message.role === "assistant" && !!message.toolCalls?.total)
			.map((message) => message.id),
	);
	const tasks = new Map(
		snapshot.execution.tools.items.flatMap((tool) => (tool.taskId ? [[tool.taskId, tool.callId] as const] : [])),
	);
	for (const item of page.items) {
		if (!item.taskId || tasks.get(item.taskId) !== item.callId || !item.anchor) continue;
		const id = `${item.anchor.assistantEntryId}_${item.anchor.modelIndex}`;
		if (!messages.has(id)) continue;
		const items = groups.get(id) ?? [];
		items.push(item);
		groups.set(id, items);
	}
	return groups;
}

export type LiveTool = ConversationExecution["tools"]["items"][number];
/** Runtime round anchors also cover slots whose task has not been instantiated. */
export function anchoredLiveTools(
	snapshot: Snapshot | undefined,
	page: ToolActivityPage | undefined,
): ReadonlyMap<string, readonly LiveTool[]> {
	const groups = new Map<string, LiveTool[]>();
	if (!snapshot?.running || !snapshot.execution) return groups;
	const eligible = new Set(
		snapshot.messages
			.filter((message) => message.role === "assistant" && !!message.toolCalls?.total)
			.map((message) => message.id),
	);
	const records = anchoredLiveActivities(snapshot, page);
	for (const tool of snapshot.execution.tools.items) {
		const record = tool.taskId
			? [...records.values()].flat().find((item) => item.taskId === tool.taskId && item.callId === tool.callId)
			: undefined;
		const anchor = tool.anchor ?? record?.anchor;
		if (!anchor) continue;
		const id = `${anchor.assistantEntryId}_${anchor.modelIndex}`;
		if (!eligible.has(id)) continue;
		const items = groups.get(id) ?? [];
		items.push(tool);
		groups.set(id, items);
	}
	return groups;
}
