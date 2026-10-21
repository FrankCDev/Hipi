import { ChevronRight, CodeXml, File } from "lucide-react";
import { type ComponentProps, useId, useRef, useState } from "react";
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
import { CompactFileActivity, compactFilePresentation, matchesCompactFileSummary } from "./compact-file-activity.tsx";
import { inlineActivityLabels } from "./inline-activity-labels.ts";
import { activityLabels, toolLabel } from "./labels.ts";
import { RetainedOutputView } from "./retained-output-view.tsx";
import { ToolResultDisclosure } from "./tool-result-disclosure.tsx";
import "./inline-activity-card.css";

/** Inline result presentation; the existing session remains the only output reader. */
export function InlineActivityCard(props: ComponentProps<typeof ActivityCard>) {
	const { activity, locale, state, session, disabled, onOpenArtifact } = props;
	const l = activityLabels(locale);
	const inline = inlineActivityLabels(locale);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const slot = state.outputs?.get(activity.activityId);
	const output = slot?.chunks?.find((chunk) => chunk.page.presentation)?.page ?? slot?.page;
	// Header classification uses existing proof only. Opening a result must not replace
	// its focused subtree, and a closed header must never hydrate output to classify itself.
	const [initialFile] = useState(() => ({
		session,
		activityId: activity.activityId,
		metadata: activity.fileSummary,
		output: activity.fileSummary ? undefined : compactFilePresentation(activity, output),
	}));
	const currentFile = activity.fileSummary ?? compactFilePresentation(activity, output);
	const cachedFile = initialFile.output;
	const cachedMatches =
		!currentFile ||
		(currentFile.kind === cachedFile?.kind &&
			currentFile.target.rootId === cachedFile.target.rootId &&
			currentFile.target.path === cachedFile.target.path &&
			(currentFile.kind !== "save" || currentFile.operationId === cachedFile.operationId));
	const presentation =
		initialFile.session !== session || initialFile.activityId !== activity.activityId
			? undefined
			: initialFile.metadata
				? activity.fileSummary
				: cachedFile && cachedMatches && matchesCompactFileSummary(activity, cachedFile)
					? (currentFile ?? cachedFile)
					: undefined;
	const outputId = useId();
	const [expanded, setExpanded] = useState(false);
	const canExpand = activity.phase === "terminal" || activity.toolResult !== "unavailable";
	const root = useRef<HTMLElement>(null);
	const toggle = useRef<HTMLButtonElement>(null);
	const detailsTrigger = useRef<HTMLButtonElement>(null);
	const failed = activity.toolResult === "error" || activity.outcome === "failed" || activity.outcome === "faulted";
	if (presentation) return <CompactFileActivity {...props} presentation={presentation} rootRef={root} />;
	const details = (
		<ActionTooltip label={inline["inline.details"]}>
			<DialogTrigger asChild>
				<Button
					ref={detailsTrigger}
					className="inline-tool-details-trigger"
					variant="ghost"
					size="icon-xs"
					aria-label={inline["inline.details"]}
				>
					<CodeXml aria-hidden="true" size={14} />
				</Button>
			</DialogTrigger>
		</ActionTooltip>
	);
	return (
		<section
			ref={root}
			className="inline-tool-result inline-tool-generic"
			data-outcome={failed ? "error" : undefined}
			data-preserve-turn-viewport
		>
			<Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
				<div className="inline-tool-result-heading">
					{canExpand || expanded ? (
						<button
							ref={toggle}
							type="button"
							className="inline-tool-result-toggle"
							aria-expanded={expanded}
							aria-controls={outputId}
							onClick={() => {
								if (expanded && root.current?.contains(document.activeElement)) toggle.current?.focus();
								setExpanded(!expanded);
							}}
						>
							<span className="inline-tool-result-name">{toolLabel(activity.toolName, locale)}</span>
							<ChevronRight aria-hidden="true" className="inline-tool-result-chevron" />
						</button>
					) : (
						<>
							<span className="inline-tool-result-name">{toolLabel(activity.toolName, locale)}</span>
							<span className="inline-tool-result-state">{l[`activity.phase.${activity.phase}`]}</span>
							{/* Keep inspection of pending approvals/receipts without inventing a result. */}
							{details}
						</>
					)}
				</div>
				<DialogContent
					className="inline-tool-details-dialog"
					closeLabel={inline["inline.close"]}
					scrollBody
					onCloseAutoFocus={(event) => {
						if (!detailsTrigger.current?.isConnected && toggle.current) {
							event.preventDefault();
							toggle.current.focus();
						}
					}}
				>
					<DialogTitle>{inline["inline.details"]}</DialogTitle>
					<DialogDescription>{inline["inline.description"]}</DialogDescription>
					<DialogBody>
						{!activity.textAvailable && <p className="inline-tool-note">{l["activity.retained"]}</p>}
						<ActivityCard {...props} sharedOutput />
					</DialogBody>
				</DialogContent>
				{activity.outcome && activity.outcome !== "completed" && (
					<p className="inline-tool-notice">{l[`activity.outcome.${activity.outcome}`]}</p>
				)}
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
				<ToolResultDisclosure id={outputId} expanded={expanded}>
					{activity.textAvailable ? (
						<RetainedOutputView
							activityId={activity.activityId}
							session={session.outputs}
							slot={slot}
							disabled={disabled}
							locale={locale}
						/>
					) : (
						<p className="inline-tool-note">
							{activity.outcome ? l[`activity.outcome.${activity.outcome}`] : l[`activity.phase.${activity.phase}`]}
						</p>
					)}
					{details}
				</ToolResultDisclosure>
			</Dialog>
		</section>
	);
}
