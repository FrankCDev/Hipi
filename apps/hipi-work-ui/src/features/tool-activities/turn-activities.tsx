import type {
	ConversationExecution,
	MessageToolCalls,
	Scope,
	ToolActivity,
	ToolActivitySelector,
} from "@hipi/work-runtime/contracts";
import { usePageInView } from "framer-motion";
import { type RefObject, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { MessageProjection, selectionIntersects } from "../workbench/conversation/message-projection.ts";
import type { ToolActivityArtifact } from "./activity-card.tsx";
import { ActivityContinuation } from "./activity-continuation.tsx";
import { ActivityHistoryWindow } from "./activity-history-window.tsx";
import { ActivitySession, type ActivityState } from "./activity-session.ts";
import { InlineActivityCard } from "./inline-activity-card.tsx";
import { activityLabels, toolLabel } from "./labels.ts";
import type { LiveActivityRead, LiveTool } from "./live-activity.ts";
import { useMessageActivityOwner } from "./message-activity-owner.tsx";
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
	contentIndexes,
	manualChoice,
	onExpandedChange,
	...props
}: Props & {
	messageId: string;
	toolCalls: MessageToolCalls;
	live?: LiveActivityRead;
	liveItems?: readonly ToolActivity[];
	liveTools?: readonly LiveTool[];
	expanded: boolean;
	onToggle: () => void;
	contentIndexes?: readonly number[];
	manualChoice?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
}) {
	const { locale } = usePreferences();
	const l = activityLabels(locale);
	const owner = useMessageActivityOwner();
	const Details =
		owner?.live?.session === live?.session && owner?.live?.session ? ActivityDetailsContent : ActivityDetailsView;
	const selector = useMemo<ToolActivitySelector>(() => ({ kind: "message", messageId }), [messageId]);
	const [manualExpanded, setManualExpanded] = useState<boolean>();
	const current = live?.active
		? liveItems?.find((item) => item.phase !== "terminal" && item.phase !== "unavailable")
		: undefined;
	const currentSlot = live?.active ? liveTools?.find((item) => item.status !== "done") : undefined;
	const liveActive = !!current || !!currentSlot;
	const shownExpanded = manualChoice ?? manualExpanded ?? (!!liveTools?.length || !!liveItems?.length || expanded);
	if (!toolCalls.total) return null;
	return (
		<ActivityDisclosure
			bodyVariant="grouped"
			toolName={
				toolCalls.items.every((item) => item.name === toolCalls.items[0]?.name) ? toolCalls.items[0]?.name : undefined
			}
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
				if (onExpandedChange) onExpandedChange(next);
				else if (expanded !== next) onToggle();
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
						<Details
							{...props}
							state={owner?.live?.session === live.session ? owner.live.state : live.state}
							session={live.session}
							items={liveItems ?? []}
							showUnavailable={
								!!liveTools?.some((tool) => !!tool.taskId && live.state.page?.unavailableTaskIds?.includes(tool.taskId))
							}
						/>
					) : (
						<HistoricalActivityDetails
							{...props}
							selector={selector}
							messageId={messageId}
							contentIndexes={contentIndexes}
							windowed={
								contentIndexes === undefined && (toolCalls.total > 16 || toolCalls.items.length < toolCalls.total)
							}
						/>
					)}
				</>
			)}
		</ActivityDisclosure>
	);
}
function HistoricalActivityDetails(
	props: Props & {
		selector: ToolActivitySelector;
		messageId: string;
		contentIndexes?: readonly number[];
		windowed?: boolean;
	},
) {
	const owner = useMessageActivityOwner();
	if (!owner || owner.messageId !== props.messageId) return <ScopedActivityDetails {...props} />;
	return <SharedMessageActivityDetails {...props} owner={owner} />;
}
function SharedMessageActivityDetails({
	owner,
	contentIndexes,
	windowed,
	...props
}: Props & {
	owner: NonNullable<ReturnType<typeof useMessageActivityOwner>>;
	contentIndexes?: readonly number[];
	windowed?: boolean;
}) {
	useEffect(() => owner.lease(windowed), [owner.lease, windowed]);
	if (windowed)
		return (
			<WindowedActivityDetails {...props} connected={owner.connected} session={owner.session} state={owner.state} />
		);
	return (
		<ActivityDetailsContent
			{...props}
			connected={owner.connected}
			state={owner.state}
			session={owner.session}
			items={
				owner.state.page?.items.filter(
					(item) =>
						item.anchor &&
						`${item.anchor.assistantEntryId}_${item.anchor.modelIndex}` === owner.messageId &&
						(contentIndexes === undefined || contentIndexes.includes(item.anchor.contentIndex)),
				) ?? []
			}
		/>
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
	windowed = false,
	onOpenArtifact,
}: Props & {
	selector: ToolActivitySelector;
	expectedCalls?: ReadonlyMap<string, string>;
	running?: boolean;
	windowed?: boolean;
}) {
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
			if (!selected) await (windowed ? session.windowPage(0) : session.inlinePage());
			if (!stopped && (running || selected) && !session.snapshot().failed)
				timer = setTimeout(() => void refresh(), 2000);
		};
		void refresh();
		return () => {
			stopped = true;
			clearTimeout(timer);
			if (!session.snapshot().expanded) session.cancel();
		};
	}, [session, connected, visible, running, state.failed, state.expanded, windowed]);
	if (windowed)
		return (
			<WindowedActivityDetails
				connected={connected && visible}
				state={state}
				session={session}
				onOpenArtifact={onOpenArtifact}
			/>
		);
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
function WindowedActivityDetails({
	connected,
	state,
	session,
	onOpenArtifact,
}: {
	connected: boolean;
	state: ActivityState;
	session: ActivitySession;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
}) {
	const { locale } = usePreferences();
	const l = activityLabels(locale);
	return (
		<>
			{!connected && <output>{l["activity.offline"]}</output>}
			{state.busy && <output>{l["activity.loading"]}</output>}
			{state.failed && (
				<>
					<p role="alert">{l["activity.failed"]}</p>
					<Button variant="ghost" size="sm" disabled={!connected || state.busy} onClick={() => void session.retry()}>
						{l["activity.retry"]}
					</Button>
				</>
			)}
			<ActivityHistoryWindow
				session={session}
				state={state}
				enabled={connected}
				locale={locale}
				inline
				onOpenArtifact={onOpenArtifact}
			/>
		</>
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
	return (
		<ActivityDetailsContent
			connected={connected}
			state={presented}
			session={session}
			items={items}
			showUnavailable={showUnavailable}
			onOpenArtifact={onOpenArtifact}
			rootRef={root}
		/>
	);
}
function ActivityDetailsContent({
	connected,
	state,
	session,
	items = state.page?.items ?? [],
	showUnavailable = true,
	onOpenArtifact,
	rootRef,
}: {
	connected: boolean;
	state: ActivityState;
	session: ActivitySession;
	items?: readonly ToolActivity[];
	showUnavailable?: boolean;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
	rootRef?: RefObject<HTMLDivElement | null>;
}) {
	const { locale } = usePreferences();
	const l = activityLabels(locale);
	const disabled = state.busy || !connected;
	return (
		<div className="inline-activity-records" ref={rootRef}>
			{!connected && <output>{l["activity.offline"]}</output>}
			{state.busy && <output>{l["activity.loading"]}</output>}
			{items
				.toSorted((a, b) => (a.anchor?.contentIndex ?? 0) - (b.anchor?.contentIndex ?? 0))
				.map((item) => (
					<InlineActivityCard
						key={item.activityId}
						activity={item}
						locale={locale}
						state={state}
						session={session}
						disabled={disabled}
						onOpenArtifact={onOpenArtifact}
					/>
				))}
			{!state.busy && state.page?.items.length === 0 && !state.page.nextCursor && !state.page.unavailableTaskIds && (
				<p>{l["activity.phase.unavailable"]}</p>
			)}
			{showUnavailable && !!state.page?.unavailableTaskIds?.length && <p>{l["activity.phase.unavailable"]}</p>}
			{state.failed && (
				<>
					<p role="alert">{l["activity.failed"]}</p>
					<Button variant="ghost" size="sm" disabled={disabled} onClick={() => void session.retry()}>
						{l["activity.retry"]}
					</Button>
				</>
			)}
			<ActivityContinuation session={session} state={state} enabled={connected} locale={locale} />
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
