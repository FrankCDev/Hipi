import type {
	ConversationExecution,
	MessageToolCalls,
	Scope,
	ToolActivity,
	ToolActivitySelector,
} from "@hipi/work-runtime/contracts";
import { usePageInView } from "framer-motion";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { MessageProjection, selectionIntersects } from "../workbench/conversation/message-projection.ts";
import type { ToolActivityArtifact } from "./activity-card.tsx";
import { ActivitySession, type ActivityState } from "./activity-session.ts";
import { InlineActivityCard } from "./inline-activity-card.tsx";
import { activityLabels, toolLabel } from "./labels.ts";
import type { LiveActivityRead, LiveTool } from "./live-activity.ts";
import { ActivityDisclosure, ActivitySummaryCoverage } from "./turn-activity-presentation.tsx";

type Props = { scope: Scope; connected: boolean; onOpenArtifact?: (artifact: ToolActivityArtifact) => void };
export function HistoricalTurnActivities({
	messageId,
	toolCalls,
	live,
	liveItems,
	liveTools,
	expanded,
	onToggle,
	...props
}: Props & {
	messageId: string;
	toolCalls: MessageToolCalls;
	live?: LiveActivityRead;
	liveItems?: readonly ToolActivity[];
	liveTools?: readonly LiveTool[];
	expanded: boolean;
	onToggle: () => void;
}) {
	const { locale } = usePreferences();
	const l = activityLabels(locale);
	const selector = useMemo<ToolActivitySelector>(() => ({ kind: "message", messageId }), [messageId]);
	const [manualExpanded, setManualExpanded] = useState<boolean>();
	const current = live?.active
		? liveItems?.find((item) => item.phase !== "terminal" && item.phase !== "unavailable")
		: undefined;
	const currentSlot = live?.active ? liveTools?.find((item) => item.status !== "done") : undefined;
	const liveActive = !!current || !!currentSlot;
	const shownExpanded = manualExpanded ?? (!!liveTools?.length || !!liveItems?.length || expanded);
	if (!toolCalls.total) return null;
	return (
		<ActivityDisclosure
			bodyVariant="grouped"
			title={toolCalls.items[0] ? toolLabel(toolCalls.items[0].name, locale) : l["activity.title"]}
			count={toolCalls.total}
			expanded={shownExpanded}
			active={liveActive}
			status={
				current
					? l[`activity.phase.${current.phase}`]
					: currentSlot
						? l[currentSlot.status === "running" ? "activity.phase.running" : "activity.phase.pending"]
						: (liveTools?.length || liveItems?.length) && !live?.active
							? l["activity.snapshot"]
							: undefined
			}
			onToggle={() => {
				const next = !shownExpanded;
				setManualExpanded(next);
				if (expanded !== next) onToggle();
			}}
			messageId={messageId}
		>
			{shownExpanded && (
				<>
					<ActivitySummaryCoverage shown={toolCalls.items.length} total={toolCalls.total} />
					<PendingSlots
						tools={
							liveTools?.filter(
								(tool) => !liveItems?.some((item) => item.taskId === tool.taskId && item.callId === tool.callId),
							) ?? []
						}
						active={live?.active ?? false}
					/>
					{liveTools?.length && !live?.session ? null : live?.session && (liveTools?.length || liveItems?.length) ? (
						<ActivityDetailsView
							{...props}
							state={live.state}
							session={live.session}
							items={liveItems ?? []}
							showUnavailable={
								!!liveTools?.some((tool) => !!tool.taskId && live.state.page?.unavailableTaskIds?.includes(tool.taskId))
							}
						/>
					) : (
						<ScopedActivityDetails {...props} selector={selector} />
					)}
				</>
			)}
		</ActivityDisclosure>
	);
}
export function LiveTurnActivities({
	execution,
	active,
	live,
	...props
}: Props & { execution: ConversationExecution; active: boolean; live?: LiveActivityRead }) {
	const { locale } = usePreferences();
	const l = activityLabels(locale);
	const [collapsed, setCollapsed] = useState(false);
	const identity = JSON.stringify(
		execution.tools.items.flatMap((item) => (item.taskId ? [[item.taskId, item.callId]] : [])),
	);
	const selector = useMemo<ToolActivitySelector>(
		() => ({
			kind: "tasks",
			taskIds: [...new Set((JSON.parse(identity) as [string, string][]).map(([taskId]) => taskId))],
		}),
		[identity],
	);
	const expectedCalls = useMemo(() => new Map(JSON.parse(identity) as [string, string][]), [identity]);
	if (!execution.tools.total) return null;
	const expanded = !collapsed;
	return (
		<ActivityDisclosure
			bodyVariant="grouped"
			title={l["activity.title"]}
			count={execution.tools.total}
			active={active && execution.tools.active > 0}
			expanded={expanded}
			onToggle={() => setCollapsed(!collapsed)}
		>
			{expanded && (
				<>
					<ul className="activity-live-slots">
						{execution.tools.items.map((item, index) => (
							<li key={JSON.stringify([item.taskId, item.callId, index])}>
								<span>{toolLabel(item.name, locale)}</span>
								<span>
									{active
										? l[
												item.status === "done"
													? "activity.phase.terminal"
													: item.status === "running"
														? "activity.phase.running"
														: "activity.phase.pending"
											]
										: l["activity.snapshot"]}
								</span>
							</li>
						))}
					</ul>
					<ActivitySummaryCoverage shown={execution.tools.items.length} total={execution.tools.total} />
					{live
						? live.session && (
								<ActivityDetailsView
									{...props}
									state={live.state}
									session={live.session}
									items={
										live.state.page?.items.filter((item) =>
											execution.tools.items.some((tool) => tool.taskId === item.taskId && tool.callId === item.callId),
										) ?? []
									}
								/>
							)
						: selector.kind === "tasks" &&
							selector.taskIds.length > 0 && (
								<ScopedActivityDetails
									key={identity}
									{...props}
									selector={selector}
									expectedCalls={expectedCalls}
									running={active}
								/>
							)}
				</>
			)}
		</ActivityDisclosure>
	);
}
function ScopedActivityDetails({
	scope,
	connected,
	selector,
	expectedCalls,
	running = false,
	onOpenArtifact,
}: Props & { selector: ToolActivitySelector; expectedCalls?: ReadonlyMap<string, string>; running?: boolean }) {
	const client = useAppClient();
	const visible = usePageInView();
	const root = useRef<HTMLDivElement>(null);
	const session = useMemo(
		() =>
			new ActivitySession(
				client,
				{ workspaceId: scope.workspaceId, conversationId: scope.conversationId },
				selector,
				expectedCalls,
			),
		[client, scope.workspaceId, scope.conversationId, selector, expectedCalls],
	);
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	useEffect(() => {
		session.activate();
		return () => session.dispose();
	}, [session]);
	useEffect(() => {
		if (!connected || !visible) {
			session.cancel();
			return;
		}
		if (state.failed || state.expanded) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			const selected = selectionIntersects(
				root.current?.closest(".conversation-panel") ?? root.current,
				document.getSelection(),
			);
			if (!selected) await session.page();
			if (!stopped && (running || selected) && !session.snapshot().failed)
				timer = setTimeout(() => void refresh(), 2000);
		};
		void refresh();
		return () => {
			stopped = true;
			clearTimeout(timer);
			if (!session.snapshot().expanded) session.cancel();
		};
	}, [session, connected, visible, running, state.failed, state.expanded]);
	return (
		<div ref={root}>
			<ActivityDetailsView
				scope={scope}
				connected={connected && visible}
				state={state}
				session={session}
				onOpenArtifact={onOpenArtifact}
			/>
		</div>
	);
}
function ActivityDetailsView({
	connected,
	state,
	session,
	items = state.page?.items ?? [],
	showUnavailable = true,
	onOpenArtifact,
}: Props & {
	state: ActivityState;
	session: ActivitySession;
	items?: readonly ToolActivity[];
	showUnavailable?: boolean;
}) {
	const { locale } = usePreferences();
	const l = activityLabels(locale);

	const root = useRef<HTMLDivElement>(null);
	const [display, setDisplay] = useState({ session, outputs: state.outputs });
	const projection = useMemo(
		() =>
			new MessageProjection<ActivityState["outputs"]>(
				undefined,
				(outputs) => setDisplay({ session, outputs }),
				() =>
					selectionIntersects(root.current?.closest(".conversation-panel") ?? root.current, document.getSelection()),
			),
		[session],
	);
	useEffect(() => {
		projection.update(state.outputs, false);
	}, [projection, state.outputs]);
	useEffect(() => {
		const flush = () => projection.flush();
		document.addEventListener("selectionchange", flush);
		return () => {
			document.removeEventListener("selectionchange", flush);
			projection.dispose();
		};
	}, [projection]);
	const presented = { ...state, outputs: display.session === session ? display.outputs : undefined };
	const disabled = state.busy || !connected;
	return (
		<div className="grid gap-2" ref={root}>
			{!connected && <output>{l["activity.offline"]}</output>}
			{state.busy && !state.page && <output>{l["activity.loading"]}</output>}
			{items
				.toSorted((a, b) => (a.anchor?.contentIndex ?? 0) - (b.anchor?.contentIndex ?? 0))
				.map((item) => (
					<InlineActivityCard
						key={item.activityId}
						activity={item}
						locale={locale}
						state={presented}
						session={session}
						disabled={disabled}
						onOpenArtifact={onOpenArtifact}
					/>
				))}
			{state.page?.items.length === 0 && !state.page.unavailableTaskIds && <p>{l["activity.empty"]}</p>}
			{showUnavailable && !!state.page?.unavailableTaskIds?.length && <p>{l["activity.phase.unavailable"]}</p>}
			{state.failed && (
				<>
					<p role="alert">{l["activity.failed"]}</p>
					<Button variant="ghost" size="sm" disabled={disabled} onClick={() => void session.retry()}>
						{l["activity.retry"]}
					</Button>
				</>
			)}
			{state.page && !state.failed && (
				<div className="flex gap-2">
					<Button variant="ghost" size="sm" disabled={disabled} onClick={() => void session.page()}>
						{l["activity.refresh"]}
					</Button>
					{state.page.nextCursor && (
						<Button
							variant="ghost"
							size="sm"
							disabled={disabled}
							onClick={() => void session.page(state.page?.nextCursor ?? undefined)}
						>
							{l["activity.next"]}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

function PendingSlots({ tools, active }: { tools: readonly LiveTool[]; active: boolean }) {
	const { locale } = usePreferences();
	const l = activityLabels(locale);
	if (!tools.length) return null;
	return (
		<ul className="activity-live-slots">
			{tools.map((tool, index) => (
				<li key={JSON.stringify([tool.taskId, tool.callId, index])}>
					<span>{toolLabel(tool.name, locale)}</span>
					<span>
						{!active
							? l["activity.snapshot"]
							: l[
									tool.status === "done"
										? "activity.phase.terminal"
										: tool.status === "running"
											? "activity.phase.running"
											: "activity.phase.pending"
								]}
					</span>
				</li>
			))}
		</ul>
	);
}
