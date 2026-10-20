import type { Scope } from "@hipi/work-runtime/contracts";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { ActivityCard, type ToolActivityArtifact } from "./activity-card.tsx";
import { ActivityTranscriptProvider, useActivityTranscript } from "./activity-transcript.tsx";
import { activityLabels, toolLabel } from "./labels.ts";

export { ActivityCard, type ToolActivityArtifact } from "./activity-card.tsx";

type Props = {
	scope: Scope;
	connected: boolean;
	running: boolean;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
};
export function ToolActivities(props: Props) {
	const context = useActivityTranscript();
	return context ? (
		<ActivitySummary />
	) : (
		<ActivityTranscriptProvider {...props}>
			<ActivitySummary />
			<ActivityHistoryDialog />
		</ActivityTranscriptProvider>
	);
}
function ActivitySummary() {
	const context = useActivityTranscript();
	const { locale } = usePreferences();
	if (!context) return null;
	const { state, connected } = context;
	const l = activityLabels(locale);
	const first =
		state.page?.items.find((item) => item.phase !== "terminal" && item.phase !== "unavailable") ?? state.page?.items[0];
	const snapshot = first
		? [
				`${l["activity.snapshot"]}: ${toolLabel(first.toolName, locale)}`,
				l[`activity.phase.${first.phase}`],
				first.outcome && l[`activity.outcome.${first.outcome}`],
				first.toolResult === "error" && l["activity.result.error"],
			]
				.filter(Boolean)
				.join(" · ")
		: undefined;
	if (!first && !state.failed) return null;
	return (
		<div className="activity-context" data-state={state.failed ? "error" : first ? "record" : "idle"}>
			{snapshot && (
				<span ref={context.summary} className="activity-summary min-w-0 flex-1 truncate" title={snapshot}>
					{snapshot}
				</span>
			)}
			<ActivityHistoryAction />
			{state.failed && (
				<p className="activity-read-error" role="alert">
					{l["activity.failed"]}
				</p>
			)}
			{!connected && first && <output className="activity-offline">{l["activity.offline"]}</output>}
		</div>
	);
}

/** Both progressive details and a real activity summary reach this one dialog owner. */
export function ActivityHistoryAction() {
	const context = useActivityTranscript();
	const { locale } = usePreferences();
	if (!context) return null;
	return (
		<Button
			className="activity-trigger"
			variant="ghost"
			size="sm"
			aria-haspopup="dialog"
			aria-expanded={context.open}
			aria-controls={context.dialogId}
			onClick={(event) => {
				context.historyTrigger.current = event.currentTarget;
				context.setOpen(true);
			}}
		>
			{activityLabels(locale)["activity.open"]}
			<Icon name="chevron" size={14} />
		</Button>
	);
}
export function ActivityHistoryDialog() {
	const context = useActivityTranscript();
	const { locale } = usePreferences();
	if (!context) return null;
	const { session, state, open, disabled, connected, onOpenArtifact } = context;
	const l = activityLabels(locale);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				context.setOpen(next);
			}}
		>
			<DialogContent
				id={context.dialogId}
				closeLabel={l["activity.close"]}
				className="max-h-[85vh] sm:max-w-2xl overflow-hidden flex flex-col"
				onCloseAutoFocus={(event) => {
					const trigger = context.historyTrigger.current;
					if (trigger?.isConnected) {
						event.preventDefault();
						trigger.focus();
					}
				}}
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
											context.setOpen(false);
											onOpenArtifact(artifact);
										}
									: undefined
							}
						/>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
