import { CodeXml, File } from "lucide-react";
import { type ComponentProps, useEffect, useId, useState } from "react";
import { ActionTooltip } from "../../components/ui/action-tooltip.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { ActivityCard } from "./activity-card.tsx";
import { inlineActivityLabels } from "./inline-activity-labels.ts";
import { activityLabels, toolLabel } from "./labels.ts";
import "./inline-activity-card.css";

/** Inline result presentation; the existing session remains the only output reader. */
export function InlineActivityCard(props: ComponentProps<typeof ActivityCard>) {
	const { activity, locale, state, session, disabled, onOpenArtifact } = props;
	const l = activityLabels(locale);
	const inline = inlineActivityLabels(locale);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const outputId = useId();
	const slot = state.outputs?.get(activity.activityId);
	const output = slot?.page;
	const expanded = activity.textAvailable;
	const [lease] = useState(() => Symbol("inline-output"));
	useEffect(
		() => session.outputs.lease(lease, activity.textAvailable ? [activity.activityId] : []),
		[session, lease, activity.activityId, activity.textAvailable],
	);
	const failed = activity.toolResult === "error" || activity.outcome === "failed" || activity.outcome === "faulted";
	return (
		<section className="inline-tool-result" data-outcome={failed ? "error" : undefined}>
			<div className="inline-tool-result-heading">
				<span className="inline-tool-result-name">{toolLabel(activity.toolName, locale)}</span>
				<span className="inline-tool-result-state">
					{activity.outcome ? l[`activity.outcome.${activity.outcome}`] : l[`activity.phase.${activity.phase}`]}
				</span>
				<Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
					<ActionTooltip label={inline["inline.details"]}>
						<DialogTrigger asChild>
							<Button
								className="inline-tool-details-trigger"
								variant="ghost"
								size="icon-xs"
								aria-label={inline["inline.details"]}
							>
								<CodeXml aria-hidden="true" size={16} />
							</Button>
						</DialogTrigger>
					</ActionTooltip>
					<DialogContent className="inline-tool-details-dialog" closeLabel={inline["inline.close"]} scrollBody>
						<DialogTitle>{inline["inline.details"]}</DialogTitle>
						<DialogDescription>{inline["inline.description"]}</DialogDescription>
						<DialogBody>
							{!expanded && <p className="inline-tool-note">{l["activity.retained"]}</p>}
							<ActivityCard {...props} sharedOutput />
						</DialogBody>
					</DialogContent>
				</Dialog>
			</div>
			{activity.toolResult === "error" && <p className="inline-tool-notice">{l["activity.result.error"]}</p>}
			{activity.toolResult === "unavailable" && activity.phase === "terminal" && (
				<p className="inline-tool-notice">{l["activity.result.unavailable"]}</p>
			)}
			{activity.abortRequested && <p className="inline-tool-notice">{l["activity.cancel"]}</p>}
			{activity.effect && activity.effect.status !== "confirmed" && (
				<p className="inline-tool-notice">{l[`activity.effect.${activity.effect.status}`]}</p>
			)}
			{activity.artifact &&
				activity.artifact.status !== "confirmed" &&
				activity.artifact.status !== activity.effect?.status && (
					<p className="inline-tool-notice">{l[`activity.effect.${activity.artifact.status}`]}</p>
				)}
			{activity.artifact && (
				<div className="inline-tool-artifact">
					{onOpenArtifact ? (
						<ActionTooltip label={l["activity.openFile"]} disabled={disabled}>
							<Button
								variant="ghost"
								size="sm"
								className="inline-tool-file"
								disabled={disabled}
								onClick={() => {
									if (activity.artifact) onOpenArtifact(activity.artifact);
								}}
							>
								<File aria-hidden="true" size={16} />
								<span>{activity.artifact.path}</span>
							</Button>
						</ActionTooltip>
					) : (
						<p className="inline-tool-path">{activity.artifact.path}</p>
					)}
					<p className="inline-tool-note">{l["activity.fileNote"]}</p>
				</div>
			)}
			{activity.outputTruncated && <p className="inline-tool-note">{l["activity.truncated"]}</p>}
			<div id={outputId} hidden={!expanded}>
				{expanded && (
					<>
						{slot?.busy && !output && <output>{l["activity.loading"]}</output>}
						{slot?.failed && (
							<div>
								<p role="alert">{l["activity.failed"]}</p>
								<Button
									variant="ghost"
									size="sm"
									disabled={disabled || slot.busy}
									onClick={() => session.outputs.retry(activity.activityId)}
								>
									{l["activity.retry"]}
								</Button>
							</div>
						)}
						{output && (
							<div className="inline-tool-text-card">
								<div className="inline-tool-text-header">{inline["inline.plaintext"]}</div>
								{/* Retained text has no trusted MIME/Markdown contract. Preserve it as escaped plaintext. */}
								<pre className="inline-tool-text">{output.text}</pre>
							</div>
						)}
						<div className="inline-tool-output-pages">
							{output && slot?.cursor !== undefined && (
								<Button
									variant="ghost"
									size="sm"
									disabled={disabled || !!slot?.busy}
									onClick={() => session.outputs.read(activity.activityId)}
								>
									{l["activity.text.first"]}
								</Button>
							)}
							{output?.nextCursor && (
								<Button
									variant="ghost"
									size="sm"
									disabled={disabled || !!slot?.busy}
									onClick={() => {
										if (output.nextCursor) session.outputs.read(activity.activityId, output.nextCursor);
									}}
								>
									{l["activity.text.next"]}
								</Button>
							)}
						</div>
					</>
				)}
			</div>
		</section>
	);
}
