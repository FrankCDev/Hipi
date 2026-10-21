import { useInView, usePageInView } from "framer-motion";
import { CodeXml, File } from "lucide-react";
import { type ComponentProps, useEffect, useId, useRef, useState } from "react";
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
import {
	CompactFileActivity,
	type CompactFileSummary,
	compactFilePresentation,
	matchesCompactFileSummary,
} from "./compact-file-activity.tsx";
import { inlineActivityLabels } from "./inline-activity-labels.ts";
import { activityLabels, toolLabel } from "./labels.ts";
import { RetainedOutputView } from "./retained-output-view.tsx";
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
	const root = useRef<HTMLElement>(null);
	const visible = useInView(root, { initial: true });
	const pageVisible = usePageInView();
	const [lease] = useState(() => Symbol("inline-output"));
	useEffect(
		() => session.outputs.lease(lease, activity.textAvailable && visible && pageVisible ? [activity.activityId] : []),
		[session, lease, activity.activityId, activity.textAvailable, visible, pageVisible],
	);
	const failed = activity.toolResult === "error" || activity.outcome === "failed" || activity.outcome === "faulted";
	const [summary, setSummary] = useState<{ session: typeof session; activityId: string; value: CompactFileSummary }>();
	useEffect(() => {
		const value = compactFilePresentation(activity, output);
		if (value) setSummary({ session, activityId: activity.activityId, value });
	}, [activity, output, session]);
	const presentation =
		compactFilePresentation(activity, output) ??
		(summary?.session === session &&
		summary.activityId === activity.activityId &&
		matchesCompactFileSummary(activity, summary.value)
			? summary.value
			: undefined);
	if (presentation) return <CompactFileActivity {...props} presentation={presentation} rootRef={root} />;
	return (
		<section ref={root} className="inline-tool-result" data-outcome={failed ? "error" : undefined}>
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
					<RetainedOutputView
						activityId={activity.activityId}
						session={session.outputs}
						slot={slot}
						disabled={disabled}
						locale={locale}
					/>
				)}
			</div>
		</section>
	);
}
