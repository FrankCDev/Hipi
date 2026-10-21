import type { AppClient, MessageToolCalls, Scope, Snapshot, ToolActivityPage } from "@hipi/work-runtime/contracts";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
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
import { projectToolGroupPresentation } from "./group-presentation.ts";
import { activityLabels, toolLabel } from "./labels.ts";
import {
	anchoredLiveActivities,
	anchoredLiveTools,
	type LiveActivityRead,
	useLiveActivityRead,
} from "./live-activity.ts";
import { MessageActivityOwner } from "./message-activity-owner.tsx";
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
	presentationGeneration: string;
	presentedToolActivity: boolean;
	leasePresentation: (owner: symbol, generation: string) => () => void;
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
	groupChoices: ReadonlyMap<string, boolean>;
	setGroupChoice: (key: string, expanded: boolean) => void;
	toggleGroup: (key: string) => void;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
};
const ActivityContext = createContext<ActivityTranscript | null>(null);
// Only disclosure keys persist across conversation navigation, never output or
// activity records. Bound both the number of scopes and keys in each scope.
type ClientActivityView = { key: number; groups: Map<string, ReadonlyMap<string, boolean>> };
const clientGroups = new WeakMap<AppClient, ClientActivityView>();
let nextClientView = 0;

function changedGroupChoice(current: ReadonlyMap<string, boolean>, key: string, expanded: boolean) {
	const next = new Map(current);
	next.delete(key);
	next.set(key, expanded);
	if (next.size > 128) {
		const first = next.keys().next().value;
		if (first !== undefined) next.delete(first);
	}
	return next;
}

export function useActivityTranscript() {
	return useContext(ActivityContext);
}

/** True only while a current tool summary is actually mounted, not merely present in runtime state. */
export function usePresentedToolActivity() {
	return useActivityTranscript()?.presentedToolActivity ?? false;
}
function useToolPresentationLease(active: boolean) {
	const context = useActivityTranscript();
	const lease = context?.leasePresentation;
	const generation = context?.presentationGeneration;
	const [owner] = useState(() => Symbol("tool-presentation"));
	useLayoutEffect(() => {
		if (active && lease && generation) return lease(owner, generation);
	}, [active, lease, generation, owner]);
}

/** One read owner for compact, inline and dialog views. Pages and output stay bounded. */
export function ActivityTranscriptProvider(props: Props) {
	const client = useAppClient();
	const owner = useMemo(() => {
		const existing = clientGroups.get(client);
		if (existing) return existing;
		const view = { key: ++nextClientView, groups: new Map<string, ReadonlyMap<string, boolean>>() };
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
	savedGroups: Map<string, ReadonlyMap<string, boolean>>;
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
	const presentationGeneration = JSON.stringify(transcript.snapshot?.execution ?? null);
	const [presentations, setPresentations] = useState<ReadonlyMap<symbol, string>>(() => new Map());
	const leasePresentation = useCallback((owner: symbol, generation: string) => {
		setPresentations((current) =>
			current.size >= 128 && !current.has(owner) ? current : new Map(current).set(owner, generation),
		);
		return () =>
			setPresentations((current) => {
				if (current.get(owner) !== generation) return current;
				const next = new Map(current);
				next.delete(owner);
				return next;
			});
	}, []);
	const [inlinePage, setInlinePage] = useState(state.cursor ? undefined : state.page);
	const [open, setOpenState] = useState(false);
	const scopeKey = JSON.stringify([scope.workspaceId, scope.conversationId]);
	const [groupChoices, setGroupChoices] = useState<ReadonlyMap<string, boolean>>(
		() => savedGroups.get(scopeKey) ?? new Map(),
	);
	const expandedGroups = useMemo(
		() => new Set([...groupChoices].filter(([, expanded]) => expanded).map(([key]) => key)),
		[groupChoices],
	);
	const setGroupChoice = (key: string, expanded: boolean) => {
		setGroupChoices((current) => changedGroupChoice(current, key, expanded));
	};
	const [visible, setVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	const summary = useRef<HTMLSpanElement>(null);
	const historyTrigger = useRef<HTMLButtonElement>(null);
	const dialogId = useId();
	useEffect(() => {
		savedGroups.delete(scopeKey);
		savedGroups.set(scopeKey, groupChoices);
		if (savedGroups.size > 24) {
			const oldest = savedGroups.keys().next().value;
			if (oldest !== undefined) savedGroups.delete(oldest);
		}
	}, [scopeKey, groupChoices, savedGroups]);
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
				presentationGeneration,
				presentedToolActivity:
					live.active &&
					transcript.snapshot?.workspaceId === scope.workspaceId &&
					transcript.snapshot?.conversationId === scope.conversationId &&
					[...presentations.values()].includes(presentationGeneration),
				leasePresentation,
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
				groupChoices,
				setGroupChoice,
				onOpenArtifact,
				setOpen(next) {
					setOpenState(next);
					if (!next) session.collapse();
				},
				toggleGroup(key) {
					setGroupChoices((current) => changedGroupChoice(current, key, !current.get(key)));
				},
			}}
		>
			{children}
		</ActivityContext.Provider>
	);
}

const MessageActivitiesContext = createContext<{ messageId: string; toolCalls?: MessageToolCalls } | null>(null);

export function MessageActivitiesProvider({
	messageId,
	toolCalls,
	children,
}: {
	messageId: string;
	toolCalls?: MessageToolCalls;
	children: ReactNode;
}) {
	const context = useActivityTranscript();
	if (!context) return children;
	return (
		<MessageActivityOwner scope={context.scope} connected={context.connected} messageId={messageId} live={context.live}>
			<MessageActivitiesContext.Provider value={{ messageId, toolCalls }}>{children}</MessageActivitiesContext.Provider>
		</MessageActivityOwner>
	);
}

export function InlineMessageToolBlock({ contentIndexes }: { contentIndexes: readonly number[] }) {
	const message = useContext(MessageActivitiesContext);
	if (!message?.toolCalls) return null;
	const items = message.toolCalls.items.filter((item) => contentIndexes.includes(item.contentIndex));
	if (!items.length) return null;
	return (
		<InlineMessageActivities
			messageId={message.messageId}
			toolCalls={{ items, total: items.length }}
			contentIndexes={contentIndexes}
		/>
	);
}

export function InlineMessageActivities({
	messageId,
	toolCalls,
	contentIndexes,
}: {
	messageId: string;
	toolCalls?: MessageToolCalls;
	contentIndexes?: readonly number[];
}) {
	const context = useActivityTranscript();
	const { locale } = usePreferences();
	const groupKey = contentIndexes === undefined ? messageId : JSON.stringify([messageId, contentIndexes[0]]);
	const liveItems = anchoredLiveActivities(context?.transcript, context?.live.state.page).get(messageId);
	const liveTools = anchoredLiveTools(context?.transcript, context?.live.state.page).get(messageId);
	const selectedItems =
		contentIndexes === undefined
			? liveItems
			: liveItems?.filter((item) => !!item.anchor && contentIndexes.includes(item.anchor.contentIndex));
	const selectedTools =
		contentIndexes === undefined
			? liveTools
			: liveTools?.filter((tool) => {
					const anchor =
						tool.anchor ??
						liveItems?.find((item) => item.taskId === tool.taskId && item.callId === tool.callId)?.anchor;
					return !!anchor && contentIndexes.includes(anchor.contentIndex);
				});
	const presentation = projectToolGroupPresentation(
		context?.transcript,
		messageId,
		contentIndexes,
		context?.live.active ?? false,
		context?.live.state.page?.items,
	);
	useToolPresentationLease(!!toolCalls?.total && presentation.kind === "active");
	if (!context) return null;
	if (toolCalls)
		return (
			<HistoricalTurnActivities
				scope={context.scope}
				connected={context.connected}
				messageId={messageId}
				toolCalls={toolCalls}
				live={context.live}
				liveItems={selectedItems}
				liveTools={selectedTools}
				presentation={presentation}
				contentIndexes={contentIndexes}
				manualChoice={context.groupChoices.get(groupKey)}
				expanded={context.expandedGroups.has(groupKey)}
				onToggle={() => context.toggleGroup(groupKey)}
				onExpandedChange={(expanded) => context.setGroupChoice(groupKey, expanded)}
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
	const anchored = anchoredLiveTools(snapshot, context?.live.state.page);
	const bound = new Set([...anchored.values()].flat());
	const items = snapshot.execution?.tools.items.filter((item) => !bound.has(item)) ?? [];
	const total = (snapshot.execution?.tools.total ?? 0) - bound.size;
	// Unanchored slots remain readable, but cannot claim a latest semantic unit.
	useToolPresentationLease(false);
	if (!context || !snapshot.execution || !snapshot.running) return null;
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
