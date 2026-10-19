import type { Scope, ToolActivity } from "@hipi/work-runtime/contracts";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import { ActivitySession, type ActivityState } from "./activity-session.ts";
import { activityLabels, toolLabel } from "./labels.ts";

export type ToolActivityArtifact = NonNullable<ToolActivity["artifact"]>;
type Props = {
	scope: Scope;
	connected: boolean;
	running: boolean;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
};
export function ToolActivities(props: Props) {
	return <ScopedActivities key={`${props.scope.workspaceId}/${props.scope.conversationId}`} {...props} />;
}
function ScopedActivities({ scope, connected, running, onOpenArtifact }: Props) {
	const client = useAppClient();
	const { locale } = usePreferences();
	const l = activityLabels(locale);
	const [session] = useState(() => new ActivitySession(client, scope));
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	const [open, setOpen] = useState(false);
	const [visible, setVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	const id = useId();
	const summary = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		session.activate();
		return () => session.dispose();
	}, [session]);
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
		if (!connected || !visible || open || state.failed) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			const selection = document.getSelection();
			const selected =
				summary.current && selection && !selection.isCollapsed && selection.containsNode(summary.current, true);
			if (!selected) await session.page();
			if (!stopped && (running || selected) && !session.snapshot().failed)
				timer = setTimeout(() => void refresh(), 2000);
		};
		void refresh();
		return () => {
			stopped = true;
			clearTimeout(timer);
			session.cancel();
		};
	}, [session, connected, visible, running, open, state.failed]);
	const first =
		state.page?.items.find((item) => item.phase !== "terminal" && item.phase !== "unavailable") ?? state.page?.items[0];
	const disabled = state.busy || !connected || !visible;
	return (
		<div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-4 py-1 text-sm">
			<span className="shrink-0 text-muted-foreground">{l["activity.title"]}</span>
			<span ref={summary} className="min-w-0 flex-1 truncate text-muted-foreground">
				{state.failed
					? l["activity.failed"]
					: first
						? `${l["activity.snapshot"]}: ${toolLabel(first.toolName, locale)} · ${l[`activity.phase.${first.phase}`]}`
						: l[state.page ? "activity.empty" : "activity.notLoaded"]}
			</span>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) session.collapse();
				}}
			>
				<DialogTrigger asChild>
					<Button variant="ghost" size="sm" aria-expanded={open} aria-controls={id}>
						{l["activity.open"]}
					</Button>
				</DialogTrigger>
				<DialogContent
					id={id}
					closeLabel={l["activity.close"]}
					className="max-h-[85vh] sm:max-w-2xl overflow-hidden flex flex-col"
				>
					<DialogTitle>{l["activity.title"]}</DialogTitle>
					<DialogDescription>{l["activity.description"]}</DialogDescription>
					{!connected && <output>{l["activity.offline"]}</output>}
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="outline" disabled={disabled} onClick={() => void session.page(state.cursor)}>
							{l["activity.refresh"]}
						</Button>
						<Button size="sm" variant="ghost" disabled={disabled || !state.cursor} onClick={() => void session.page()}>
							{l["activity.first"]}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={disabled || !state.page?.nextCursor}
							onClick={() => {
								if (state.page?.nextCursor) void session.page(state.page.nextCursor);
							}}
						>
							{l["activity.next"]}
						</Button>
					</div>
					{state.busy && <output>{l["activity.loading"]}</output>}
					{!state.page && !state.busy && !state.failed && <p>{l["activity.notLoaded"]}</p>}
					{state.failed && (
						<div role="alert">
							<p>{l["activity.failed"]}</p>
							<Button size="sm" variant="outline" disabled={disabled} onClick={() => void session.retry()}>
								{l["activity.retry"]}
							</Button>
						</div>
					)}
					<div className="min-h-0 overflow-y-auto overscroll-contain grid gap-3">
						{state.page && (
							<p className="text-sm text-muted-foreground">
								{l[state.page.coverage === "tasks" ? "activity.tasks" : "activity.entries"]}
							</p>
						)}
						{state.page?.items.length === 0 && <p>{l["activity.empty"]}</p>}
						{state.page?.items.map((item) => (
							<ActivityCard
								key={item.activityId}
								activity={item}
								locale={locale}
								state={state}
								session={session}
								disabled={disabled}
								onOpenArtifact={
									onOpenArtifact
										? (artifact) => {
												setOpen(false);
												session.collapse();
												onOpenArtifact(artifact);
											}
										: undefined
								}
							/>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function ActivityCard({
	activity,
	locale,
	state,
	session,
	disabled,
	onOpenArtifact,
}: {
	activity: ToolActivity;
	locale: string;
	state: ActivityState;
	session: ActivitySession;
	disabled: boolean;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
}) {
	const l = activityLabels(locale);
	const outputId = useId();
	const expanded = state.expanded === activity.activityId;
	const text = expanded && state.text?.activityId === activity.activityId ? state.text : undefined;
	return (
		<article className="rounded-lg border border-border bg-background p-3 grid gap-2 text-sm break-words">
			<h3 className="font-medium">{toolLabel(activity.toolName, locale)}</h3>
			<p>
				{l[`activity.phase.${activity.phase}`]}
				{activity.outcome && <> · {l[`activity.outcome.${activity.outcome}`]}</>}
			</p>
			<p>{l[`activity.result.${activity.toolResult}`]}</p>
			<p className="text-muted-foreground">
				{l[`activity.source.${activity.source}`]}
				{activity.inherited && <> · {l["activity.inherited"]}</>}
			</p>
			{activity.abortRequested && <p>{l["activity.cancel"]}</p>}
			{activity.effect && (
				<div className="rounded-md border border-border p-2 grid gap-1">
					<p>{l[`activity.effect.${activity.effect.status}`]}</p>
					<p className="break-all">
						{l["activity.operation"]}: {activity.effect.operationId}
					</p>
					{!activity.artifact && <p className="text-muted-foreground">{l["activity.noFile"]}</p>}
				</div>
			)}
			{activity.artifact && (
				<div className="grid gap-1">
					<p className="break-all">{activity.artifact.path}</p>
					<p className="text-muted-foreground">{l["activity.fileNote"]}</p>
					{onOpenArtifact && (
						<Button
							className="justify-self-start"
							size="sm"
							variant="outline"
							disabled={disabled}
							onClick={() => {
								if (activity.artifact) onOpenArtifact(activity.artifact);
							}}
						>
							{l["activity.openFile"]}
						</Button>
					)}
				</div>
			)}
			<details>
				<summary className="cursor-pointer focus-visible:outline focus-visible:outline-ring">
					{l["activity.identity"]}
				</summary>
				<p className="break-all">
					{activity.toolName} / {activity.activityId}
				</p>
				{activity.approval && (
					<p className="break-all">
						{l["activity.approval"]}: {activity.approval.approvalId} / {activity.approval.status}
					</p>
				)}
				{activity.receiptIds.length > 0 && (
					<p className="break-all">
						{l["activity.receipts"]}: {activity.receiptIds.join(", ")}
					</p>
				)}
			</details>
			{activity.outputTruncated && <p className="text-muted-foreground">{l["activity.truncated"]}</p>}
			{activity.textAvailable && (
				<Button
					variant="outline"
					size="sm"
					className="justify-self-start"
					disabled={disabled && !expanded}
					aria-expanded={expanded}
					aria-controls={outputId}
					onClick={() => (expanded ? session.collapse() : void session.text(activity.activityId))}
				>
					{l[expanded ? "activity.collapse" : "activity.original"]}
				</Button>
			)}
			<div id={outputId} hidden={!expanded} className="min-w-0 grid gap-2">
				{expanded && (
					<>
						<p className="text-muted-foreground">{l["activity.retained"]}</p>
						{text && (
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-foreground">
								{text.text}
							</pre>
						)}
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="ghost"
								disabled={disabled}
								onClick={() => void session.text(activity.activityId)}
							>
								{l["activity.text.first"]}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={disabled || !text?.nextCursor}
								onClick={() => {
									if (text?.nextCursor) void session.text(activity.activityId, text.nextCursor);
								}}
							>
								{l["activity.text.next"]}
							</Button>
						</div>
					</>
				)}
			</div>
		</article>
	);
}
