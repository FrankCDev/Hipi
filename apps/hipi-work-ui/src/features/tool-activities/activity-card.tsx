import type { ToolActivity } from "@hipi/work-runtime/contracts";
import { useId } from "react";
import { Button } from "../../components/ui/button.tsx";
import type { ActivitySession, ActivityState } from "./activity-session.ts";
import { activityLabels, toolLabel } from "./labels.ts";

export type ToolActivityArtifact = NonNullable<ToolActivity["artifact"]>;

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
