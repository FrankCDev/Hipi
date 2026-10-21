import type { MessageToolCalls, ToolActivity } from "@hipi/work-runtime/contracts";
import { useInView } from "framer-motion";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { selectionIntersects } from "../workbench/conversation/message-projection.ts";
import type { ToolActivityArtifact } from "./activity-card.tsx";
import type { ActivitySession } from "./activity-session.ts";
import { CompactFileActivity } from "./compact-file-activity.tsx";
import type { LiveActivityRead, LiveTool } from "./live-activity.ts";
import { useMessageActivityOwner } from "./message-activity-owner.tsx";

function sameFileProof(left: ToolActivity | undefined, right: ToolActivity | undefined) {
	return (
		!!left &&
		!!right &&
		left.activityId === right.activityId &&
		left.taskId === right.taskId &&
		left.resultEntryId === right.resultEntryId &&
		JSON.stringify(left.fileSummary) === JSON.stringify(right.fileSummary)
	);
}

type Props = {
	messageId: string;
	toolCalls: MessageToolCalls;
	contentIndexes?: readonly number[];
	live?: LiveActivityRead;
	liveTools?: readonly LiveTool[];
	expanded: boolean;
	manualChoice?: boolean;
	active: boolean;
	locale: string;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
	children: ReactNode;
};

/** A visible header leases metadata from its message owner, never retained output. */
export function SingletonFileActivity(props: Props) {
	const owner = useMessageActivityOwner();
	const { messageId, toolCalls, contentIndexes, children } = props;
	const selectedCalls =
		contentIndexes?.length === 1
			? toolCalls.items.filter((item) => item.contentIndex === contentIndexes[0])
			: contentIndexes === undefined
				? toolCalls.items
				: [];
	const slot = toolCalls.items.length === toolCalls.total && selectedCalls.length === 1 ? selectedCalls[0] : undefined;
	if (
		!owner ||
		owner.messageId !== messageId ||
		!slot ||
		!["hipi_files_read", "hipi_files_list", "hipi_files_save"].includes(slot.name)
	)
		return children;
	const unit = JSON.stringify([messageId, slot.contentIndex, slot.callId, slot.name]);
	return <FileActivityUnit {...props} owner={owner} slot={slot} unit={unit} />;
}

function FileActivityUnit({
	messageId,
	live,
	liveTools,
	expanded,
	manualChoice,
	active,
	locale,
	onOpenArtifact,
	children,
	owner,
	slot,
	unit,
}: Props & {
	owner: NonNullable<ReturnType<typeof useMessageActivityOwner>>;
	slot: MessageToolCalls["items"][number];
	unit: string;
}) {
	const ownerSession = owner.session;
	const root = useRef<HTMLDivElement>(null);
	const visible = useInView(root);
	const [dialogOpen, setDialogOpen] = useState(false);
	const liveMatches = liveTools?.filter((tool) => {
		const anchor =
			tool.anchor ??
			owner?.live?.state.page?.items.find((item) => item.taskId === tool.taskId && item.callId === tool.callId)?.anchor;
		return (
			tool.callId === slot?.callId &&
			tool.name === slot?.name &&
			anchor?.contentIndex === slot?.contentIndex &&
			`${anchor?.assistantEntryId}_${anchor?.modelIndex}` === messageId
		);
	});
	const liveTool = liveMatches?.length === 1 ? liveMatches[0] : undefined;
	const liveRead = liveTool && owner?.live?.session === live?.session ? owner?.live : undefined;
	const awaitingLive = !!liveTools?.length;
	const historicalLease = !awaitingLive && (visible || dialogOpen);
	useEffect(() => {
		if (historicalLease) return owner?.lease();
	}, [historicalLease, owner?.lease]);
	const session = awaitingLive ? liveRead?.session : owner?.session;
	const state = awaitingLive ? liveRead?.state : owner?.state;
	const matches = state?.page?.items.filter(
		(item) =>
			item.anchor &&
			`${item.anchor.assistantEntryId}_${item.anchor.modelIndex}` === messageId &&
			item.anchor.contentIndex === slot?.contentIndex,
	);
	const item = matches?.length === 1 ? matches[0] : undefined;
	const candidate =
		item?.callId === slot?.callId &&
		item?.toolName === slot?.name &&
		(!awaitingLive || (liveTool?.taskId && item?.taskId === liveTool.taskId)) &&
		item?.fileSummary
			? item
			: undefined;
	const [proof, setProof] = useState<{
		owner: ActivitySession;
		unit: string;
		activity: ToolActivity;
	}>();
	useEffect(() => {
		let disposed = false;
		const promote = () => {
			if (
				disposed ||
				!ownerSession ||
				!unit ||
				!candidate ||
				expanded ||
				manualChoice !== undefined ||
				active ||
				dialogOpen ||
				root.current?.contains(document.activeElement) ||
				selectionIntersects(root.current?.closest(".conversation-panel") ?? root.current, document.getSelection())
			)
				return;
			setProof((previous) =>
				previous?.owner === ownerSession && previous.unit === unit && previous.activity === candidate
					? previous
					: { owner: ownerSession, unit, activity: candidate },
			);
		};
		const afterFocus = () => queueMicrotask(promote);
		promote();
		document.addEventListener("selectionchange", promote);
		document.addEventListener("focusout", afterFocus);
		return () => {
			disposed = true;
			document.removeEventListener("selectionchange", promote);
			document.removeEventListener("focusout", afterFocus);
		};
	}, [ownerSession, unit, candidate, expanded, manualChoice, active, dialogOpen]);
	// The terminal proof bridges only an unread handoff. Contradictory/current absence wins immediately.
	const sameResult = sameFileProof(candidate, proof?.activity);
	const unresolved = !matches?.length && (!state?.page || !!state.page.nextCursor);
	const shown =
		proof?.owner === owner?.session &&
		proof?.unit === unit &&
		!expanded &&
		manualChoice === undefined &&
		!active &&
		(sameResult || unresolved)
			? proof?.activity
			: undefined;
	useEffect(() => {
		setProof((previous) =>
			previous &&
			(previous.owner !== ownerSession ||
				previous.unit !== unit ||
				(!unresolved && !sameFileProof(candidate, previous.activity)))
				? undefined
				: previous,
		);
		if (!shown) setDialogOpen(false);
	}, [ownerSession, unit, unresolved, candidate, shown]);
	return (
		<div ref={root} data-file-activity-unit={unit} data-preserve-turn-viewport="">
			{shown?.fileSummary && session && state ? (
				<CompactFileActivity
					activity={sameResult && candidate ? candidate : shown}
					presentation={shown.fileSummary}
					locale={locale}
					state={state}
					session={session}
					disabled={!sameResult || !owner?.connected || state.busy || state.failed}
					onOpenArtifact={
						onOpenArtifact
							? (artifact) => {
									if (sameResult && owner?.connected && !state.busy && !state.failed) onOpenArtifact(artifact);
								}
							: undefined
					}
					onDetailsOpenChange={setDialogOpen}
					unresolvedMetadata={sameResult ? undefined : { connected: owner.connected }}
				/>
			) : (
				children
			)}
		</div>
	);
}
