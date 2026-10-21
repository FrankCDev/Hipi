import type { Snapshot } from "@hipi/work-runtime/contracts";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotionPreference } from "../../../../app/theme/use-reduced-motion.ts";
import { RunActivityHeader } from "../activity/header.tsx";
import { projectRunActivities } from "../activity/projection.ts";
import type { TranscriptRow } from "../transcript.ts";
import type { TurnRow } from "./contracts.ts";
import "./row.css";
/** Reference Hk/Uk: one real height transition inside the measured turn, never per-message offsets. */
export function ConversationTurnRow({
	row,
	snapshot,
	choices,
	protectedKeys,
	active,
	onToggle,
	render,
}: {
	row: TurnRow;
	snapshot: Snapshot;
	choices: ReadonlyMap<string, boolean>;
	protectedKeys: ReadonlySet<string>;
	active: boolean;
	onToggle: (key: string, expanded: boolean) => void;
	render: (row: TranscriptRow) => ReactNode;
}) {
	const animateExpansion = useRef(false);
	const priorProcessBody = useRef<boolean | undefined>(undefined);
	const retainedHeader = useRef<Extract<TranscriptRow, { kind: "run-activity" }> | undefined>(undefined);
	const protectedBody = row.children.some((child) => protectedKeys.has(child.key));
	const projected = projectRunActivities(
		row.children,
		snapshot,
		choices,
		protectedKeys,
		active || (protectedBody && priorProcessBody.current === true),
		true,
	);
	const proposedHeader = projected.find((child) => child.kind === "run-activity");
	const header = proposedHeader ?? (protectedBody && priorProcessBody.current ? retainedHeader.current : undefined);
	useLayoutEffect(() => {
		if (!protectedBody) priorProcessBody.current = !!header;
		if (proposedHeader?.kind === "run-activity") retainedHeader.current = proposedHeader;
	}, [header, protectedBody, proposedHeader]);
	if (!header || header.kind !== "run-activity")
		return (
			<div className="conversation-turn">
				{row.children.map((child) => (
					<div className="conversation-turn-block" key={child.key}>
						{render(child)}
					</div>
				))}
			</div>
		);
	const activity = header.activity;
	const members = new Set(
		protectedBody && priorProcessBody.current === false
			? []
			: activity.members.length
				? activity.members
				: activity.running
					? row.children.filter((child) => child.kind === "assistant-message").map((child) => child.key)
					: [],
	);
	const presented = proposedHeader
		? projected
		: row.children.flatMap((child) =>
				child.key === header.activity.members[0] ||
				(header.activity.running &&
					child.kind === "assistant-message" &&
					child.key === row.children.find((value) => value.kind === "assistant-message")?.key)
					? [header, child]
					: [child],
			);
	const first = presented.findIndex((child) => child.key === header.key);
	return (
		<div className="conversation-turn" data-run-turn={row.runId}>
			{presented.map((child, index) => {
				if (members.has(child.key)) return null;
				if (index !== first)
					return (
						<div className="conversation-turn-block" key={child.key}>
							{render(child)}
						</div>
					);
				return (
					<div className="conversation-turn-process" key={child.key}>
						{proposedHeader && (
							<RunActivityHeader
								activity={active ? activity : { ...activity, running: false }}
								onToggle={() => {
									animateExpansion.current = !activity.expanded;
									onToggle(activity.key, !activity.expanded);
								}}
							/>
						)}
						<AnimatePresence initial={false}>
							{activity.expanded && members.size > 0 && (
								<TurnActivityBody animateExpansion={animateExpansion.current}>
									{projected
										.filter((member) => members.has(member.key))
										.map((member) => (
											<div className="conversation-turn-block" key={member.key}>
												{render(member)}
											</div>
										))}
								</TurnActivityBody>
							)}
						</AnimatePresence>
					</div>
				);
			})}
		</div>
	);
}

function TurnActivityBody({ animateExpansion, children }: { animateExpansion: boolean; children: ReactNode }) {
	const reduced = useReducedMotionPreference();
	const present = useIsPresent();
	const [settled, setSettled] = useState(!animateExpansion);
	return (
		<motion.div
			className="conversation-turn-body"
			data-settled={settled && present}
			inert={!present}
			aria-hidden={!present || undefined}
			initial={animateExpansion ? { height: reduced ? "auto" : 0, opacity: 0, y: reduced ? 0 : -8 } : false}
			animate={{
				height: "auto",
				opacity: 1,
				y: 0,
				transition: { duration: animateExpansion ? (reduced ? 0.15 : 0.3) : 0, ease: [0.19, 1, 0.22, 1] },
			}}
			exit={{
				height: reduced ? "auto" : 0,
				opacity: 0,
				y: reduced ? 0 : -8,
				transition: { duration: 0.15, ease: [0.23, 1, 0.32, 1] },
			}}
			onAnimationComplete={() => setSettled(true)}
		>
			{children}
		</motion.div>
	);
}
