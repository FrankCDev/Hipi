import type { FilePresentation, ToolActivity, ToolActivityTextPage } from "@hipi/work-runtime/contracts";
import { File, Folder, Pencil } from "lucide-react";
import { type ComponentProps, type RefObject, useState } from "react";
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
import { ActivityContinuation } from "./activity-continuation.tsx";
import { inlineActivityLabels } from "./inline-activity-labels.ts";
import { activityLabels, toolLabel } from "./labels.ts";

export type CompactFileSummary = {
	target: FilePresentation["target"];
	kind: FilePresentation["result"]["kind"];
	partial: boolean;
	operationId?: string;
};
/** Only small, proven display metadata survives output-chunk navigation; never copy retained text. */
export function compactFilePresentation(
	activity: ToolActivity,
	output: ToolActivityTextPage | undefined,
): CompactFileSummary | undefined {
	const presentation = output?.activityId === activity.activityId ? output.presentation : undefined;
	if (!presentation) return undefined;
	const result = presentation.result;
	const summary: CompactFileSummary = {
		target: presentation.target,
		kind: result.kind,
		partial:
			result.kind === "read"
				? result.offset > 0 || result.nextOffset !== null
				: result.kind === "directory" && result.hasMore,
		...(result.kind === "save" ? { operationId: result.operationId } : {}),
	};
	return matchesCompactFileSummary(activity, summary) ? summary : undefined;
}
/** Display metadata is not an authorization grant or evidence of a successful unconfirmed write. */
export function matchesCompactFileSummary(activity: ToolActivity, summary: CompactFileSummary) {
	if (
		activity.toolResult !== "success" ||
		activity.phase !== "terminal" ||
		(activity.outcome !== undefined && activity.outcome !== "completed") ||
		(activity.effect && activity.effect.status !== "confirmed") ||
		(activity.artifact && activity.artifact.status !== "confirmed")
	)
		return false;
	return summary.kind === "read"
		? activity.toolName === "hipi_files_read"
		: summary.kind === "directory"
			? activity.toolName === "hipi_files_list"
			: activity.toolName === "hipi_files_save" &&
				activity.effect?.status === "confirmed" &&
				activity.effect.operationId === summary.operationId;
}

/** IT → NYe/EYe compact row geometry; unsupported diff/count semantics are deliberately absent. */
export function CompactFileActivity({
	presentation,
	rootRef,
	onDetailsOpenChange,
	unresolvedMetadata,
	...props
}: ComponentProps<typeof ActivityCard> & {
	presentation: CompactFileSummary;
	rootRef?: RefObject<HTMLElement | null>;
	onDetailsOpenChange?: (open: boolean) => void;
	unresolvedMetadata?: { connected: boolean };
}) {
	const { activity, locale, disabled, onOpenArtifact, state, session } = props;
	const [open, setOpen] = useState(false);
	const l = activityLabels(locale);
	const inline = inlineActivityLabels(locale);
	const Icon = presentation.kind === "save" ? Pencil : presentation.kind === "directory" ? Folder : File;
	const artifact = activity.artifact;
	const canOpen =
		artifact &&
		artifact.rootId === presentation.target.rootId &&
		artifact.path === presentation.target.path &&
		onOpenArtifact;
	const partial = presentation.partial;
	const slot = state.outputs?.get(activity.activityId);
	return (
		<section ref={rootRef} className="inline-tool-result inline-file-activity">
			<Dialog
				open={open}
				onOpenChange={(value) => {
					setOpen(value);
					onDetailsOpenChange?.(value);
				}}
			>
				<div className="inline-file-activity-row">
					<Icon aria-hidden="true" />
					<DialogTrigger asChild>
						<button type="button" className="inline-file-action" aria-label={inline["inline.details"]}>
							{toolLabel(activity.toolName, locale)}
						</button>
					</DialogTrigger>
					{canOpen ? (
						<button
							type="button"
							className="inline-file-target"
							disabled={disabled}
							title={l["activity.fileNote"]}
							onClick={() => onOpenArtifact?.(artifact)}
						>
							{presentation.target.path}
						</button>
					) : (
						<DialogTrigger asChild>
							<button type="button" className="inline-file-target" title={inline["inline.details"]}>
								{presentation.target.path || "."}
							</button>
						</DialogTrigger>
					)}
				</div>
				<DialogContent className="inline-tool-details-dialog" closeLabel={inline["inline.close"]} scrollBody>
					<DialogTitle>{inline["inline.details"]}</DialogTitle>
					<DialogDescription>{inline["inline.description"]}</DialogDescription>
					<DialogBody>
						{unresolvedMetadata ? (
							<>
								{!unresolvedMetadata.connected && <output>{l["activity.offline"]}</output>}
								{state.busy && <output>{l["activity.loading"]}</output>}
								{state.failed && (
									<>
										<p role="alert">{l["activity.failed"]}</p>
										<Button
											variant="ghost"
											size="sm"
											disabled={!unresolvedMetadata.connected || state.busy}
											onClick={() => void session.retry()}
										>
											{l["activity.retry"]}
										</Button>
									</>
								)}
								{!state.page && !state.busy && !state.failed && <p>{l["activity.phase.unavailable"]}</p>}
								<ActivityContinuation
									session={session}
									state={state}
									enabled={unresolvedMetadata.connected}
									locale={locale}
								/>
							</>
						) : (
							<>
								{slot?.busy && <output>{l["activity.loading"]}</output>}
								{slot?.failed && <p role="alert">{l["activity.failed"]}</p>}
								{partial && <p>{l["activity.partial.description"]}</p>}
								<ActivityCard {...props} sharedOutput />
							</>
						)}
					</DialogBody>
				</DialogContent>
			</Dialog>
			{activity.abortRequested && <p className="inline-tool-notice">{l["activity.cancel"]}</p>}
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
			{partial && <p className="inline-tool-note">{l["activity.partial.description"]}</p>}
			{activity.outputTruncated && <p className="inline-tool-note">{l["activity.truncated"]}</p>}
		</section>
	);
}
