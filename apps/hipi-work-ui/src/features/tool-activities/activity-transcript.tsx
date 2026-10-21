import type { AppClient, MessageToolCalls, Scope, Snapshot, ToolActivityPage } from "@hipi/work-runtime/contracts";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { selectionIntersects } from "../workbench/conversation/message-projection.ts";
import { ActivityCard, type ToolActivityArtifact } from "./activity-card.tsx";
import { ActivitySession, type ActivityState } from "./activity-session.ts";
import { activityLabels, toolLabel } from "./labels.ts";
import {
	anchoredLiveActivities,
	anchoredLiveTools,
	type LiveActivityRead,
	useLiveActivityRead,
} from "./live-activity.ts";
import { HistoricalTurnActivities, LiveTurnActivities } from "./turn-activities.tsx";
import "./activity-transcript.css";

type Props = {
	scope: Scope;
	connected: boolean;
	running: boolean;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
	rootRef?: RefObject<HTMLElement | null>;
	children: ReactNode;
};
type ActivityTranscript = {
	scope: Scope;
	live: LiveActivityRead;
	transcript?: Snapshot;
	setTranscript: (view: { snapshot?: Snapshot; active: boolean }) => void;
	session: ActivitySession;
	state: ActivityState;
	inlinePage: ToolActivityPage | undefined;
	connected: boolean;
	disabled: boolean;
	open: boolean;
	setOpen: (open: boolean) => void;
	summary: RefObject<HTMLSpanElement | null>;
	historyTrigger: RefObject<HTMLButtonElement | null>;
	dialogId: string;
	expandedGroups: ReadonlySet<string>;
	toggleGroup: (key: string) => void;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
};
const ActivityContext = createContext<ActivityTranscript | null>(null);
// Only disclosure keys persist across conversation navigation, never output or
// activity records. Bound both the number of scopes and keys in each scope.
type ClientActivityView = { key: number; groups: Map<string, ReadonlySet<string>> };
const clientGroups = new WeakMap<AppClient, ClientActivityView>();
let nextClientView = 0;

export function useActivityTranscript() {
	return useContext(ActivityContext);
}

/** One read owner for compact, inline and dialog views. Pages and output stay bounded. */
export function ActivityTranscriptProvider(props: Props) {
	const client = useAppClient();
	const owner = useMemo(() => {
		const existing = clientGroups.get(client);
		if (existing) return existing;
		const view = { key: ++nextClientView, groups: new Map<string, ReadonlySet<string>>() };
		clientGroups.set(client, view);
		return view;
	}, [client]);
	return (
		<ScopedActivityTranscript
			key={JSON.stringify([owner.key, props.scope.workspaceId, props.scope.conversationId])}
			client={client}
			savedGroups={owner.groups}
			{...props}
		/>
	);
}

function ScopedActivityTranscript({
	scope,
	connected,
	running,
	onOpenArtifact,
	children,
	client,
	savedGroups,
	rootRef,
}: Props & {
	client: AppClient;
	savedGroups: Map<string, ReadonlySet<string>>;
}) {
	const session = useMemo(
		() =>
			new ActivitySession(client, {
				workspaceId: scope.workspaceId,
				conversationId: scope.conversationId,
			}),
		[client, scope.workspaceId, scope.conversationId],
	);
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	const [transcript, setTranscript] = useState<{ snapshot?: Snapshot; active: boolean }>({ active: false });
	const live = useLiveActivityRead(client, scope, transcript.snapshot, connected && transcript.active, rootRef);
	const [inlinePage, setInlinePage] = useState(state.cursor ? undefined : state.page);
	const [open, setOpenState] = useState(false);
	const scopeKey = JSON.stringify([scope.workspaceId, scope.conversationId]);
	const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
		() => savedGroups.get(scopeKey) ?? new Set(),
	);
	const [visible, setVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	const summary = useRef<HTMLSpanElement>(null);
	const historyTrigger = useRef<HTMLButtonElement>(null);
	const dialogId = useId();
	useEffect(() => {
		savedGroups.delete(scopeKey);
		savedGroups.set(scopeKey, expandedGroups);
		if (savedGroups.size > 24) {
			const oldest = savedGroups.keys().next().value;
			if (oldest !== undefined) savedGroups.delete(oldest);
		}
	}, [scopeKey, expandedGroups, savedGroups]);
	useEffect(() => {
		session.activate();
		return () => session.dispose();
	}, [session]);
	useEffect(() => {
		if (state.page && state.cursor === undefined) setInlinePage(state.page);
	}, [state.page, state.cursor]);
	useEffect(() => {
		const update = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	useEffect(() => {
		if (!connected || !visible) {
			session.cancel();
			return;
		}
		if (open && !state.page && !state.failed) void session.page();
	}, [session, connected, visible, state.page, state.failed, open]);
	useEffect(() => {
		if (!connected || !visible || open || state.failed || state.expanded) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			const root = rootRef?.current ?? summary.current?.closest<HTMLElement>(".activity-context") ?? null;
			const selected = selectionIntersects(root, document.getSelection());
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
	}, [session, connected, visible, running, open, state.failed, state.expanded, rootRef]);
	return (
		<ActivityContext.Provider
			value={{
				scope,
				live,
				transcript: transcript.snapshot,
				setTranscript,
				session,
				state,
				inlinePage,
				connected,
				disabled: state.busy || !connected || !visible,
				open,
				summary,
				historyTrigger,
				dialogId,
				expandedGroups,
				onOpenArtifact,
				setOpen(next) {
					setOpenState(next);
					if (!next) session.collapse();
				},
				toggleGroup(key) {
					setExpandedGroups((current) => {
						const next = new Set(current);
						if (next.has(key)) next.delete(key);
						else {
							next.add(key);
							// Only small disclosure keys survive virtual row eviction.
							if (next.size > 128) {
								const first = next.values().next().value;
								if (first !== undefined) next.delete(first);
							}
						}
						return next;
					});
				},
			}}
		>
			{children}
		</ActivityContext.Provider>
	);
}

export function InlineMessageActivities({ messageId, toolCalls }: { messageId: string; toolCalls?: MessageToolCalls }) {
	const context = useActivityTranscript();
	const { locale } = usePreferences();
	if (!context) return null;
	if (toolCalls)
		return (
			<HistoricalTurnActivities
				scope={context.scope}
				connected={context.connected}
				messageId={messageId}
				toolCalls={toolCalls}
				live={context.live}
				liveItems={anchoredLiveActivities(context.transcript, context.live.state.page).get(messageId)}
				liveTools={anchoredLiveTools(context.transcript, context.live.state.page).get(messageId)}
				expanded={context.expandedGroups.has(messageId)}
				onToggle={() => context.toggleGroup(messageId)}
				onOpenArtifact={context.onOpenArtifact}
			/>
		);
	// Match previewMessage's authoritative entry/model index. A conversation-wide
	// activity with no anchor is never assigned to the newest assistant response.
	const items =
		context.inlinePage?.items.filter(
			(item) => item.anchor && `${item.anchor.assistantEntryId}_${item.anchor.modelIndex}` === messageId,
		) ?? [];
	if (items.length === 0) return null;
	const l = activityLabels(locale);
	const expanded = context.expandedGroups.has(messageId);
	const first = items[0];
	return (
		<div className="inline-activity" data-activity-message-id={messageId} data-preserve-turn-viewport="">
			<Button
				variant="ghost"
				size="sm"
				className="inline-activity-toggle"
				aria-expanded={expanded}
				onClick={() => {
					context.toggleGroup(messageId);
					if (expanded && items.some((item) => item.activityId === context.state.expanded)) context.session.collapse();
				}}
			>
				<Icon name="chevron" size={14} style={{ transform: expanded ? "rotate(90deg)" : undefined }} />
				<span>{first ? toolLabel(first.toolName, locale) : l["activity.title"]}</span>
				{items.length > 1 && <span className="inline-activity-count">{items.length}</span>}
				{first && <span className="inline-activity-phase">{l[`activity.phase.${first.phase}`]}</span>}
			</Button>
			{expanded && (
				<div className="inline-activity-details">
					{!context.connected && <output>{l["activity.offline"]}</output>}
					{items.map((item) => (
						<ActivityCard
							key={item.activityId}
							activity={item}
							locale={locale}
							state={context.state}
							session={context.session}
							disabled={
								context.disabled || !context.state.page?.items.some((current) => current.activityId === item.activityId)
							}
							onOpenArtifact={context.onOpenArtifact}
						/>
					))}
					{context.state.failed && <p role="alert">{l["activity.failed"]}</p>}
				</div>
			)}
		</div>
	);
}

export function InlineLiveActivities({ snapshot, active }: { snapshot: Snapshot; active: boolean }) {
	const context = useActivityTranscript();
	if (!context || !snapshot.execution || !snapshot.running) return null;
	const anchored = anchoredLiveTools(snapshot, context.live.state.page);
	const bound = new Set([...anchored.values()].flat());
	const items = snapshot.execution.tools.items.filter((item) => !bound.has(item));
	const total = snapshot.execution.tools.total - bound.size;
	if (total <= 0) return null;
	return (
		<LiveTurnActivities
			key={snapshot.execution.ownerTaskId}
			scope={context.scope}
			connected={context.connected}
			execution={{ ...snapshot.execution, tools: { ...snapshot.execution.tools, items, total } }}
			active={active}
			live={context.live}
			onOpenArtifact={context.onOpenArtifact}
		/>
	);
}

/** Uses the already selection-frozen transcript projection, not a second runtime view. */
export function useActivityTranscriptProjection(snapshot: Snapshot | undefined, active: boolean) {
	const context = useActivityTranscript();
	const update = context?.setTranscript;
	useLayoutEffect(() => {
		update?.({ snapshot, active });
	}, [update, snapshot, active]);
	useEffect(() => () => update?.({ active: false }), [update]);
}
