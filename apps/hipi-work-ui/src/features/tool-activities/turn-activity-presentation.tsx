import { motion } from "framer-motion";
import { ChevronRight, File, Folder, Pencil, Puzzle } from "lucide-react";
import { type ReactNode, useId, useLayoutEffect, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { useReducedMotionPreference } from "../../app/theme/use-reduced-motion.ts";
import { disclosureTransition } from "../../components/ui/disclosure-motion.ts";
import { CadencedText } from "../workbench/conversation/presentation/cadenced-text.tsx";
import { useGroupSummary } from "./group-summary.tsx";

type DisclosurePhase = "collapsed" | "opening" | "expanded" | "closing";
const disclosureVariants = {
	expanded: { height: "auto", opacity: 1 },
	collapsed: { height: 0, opacity: 0 },
};
export function ActivitySummaryCoverage({ shown, total }: { shown: number; total: number }) {
	const { locale } = usePreferences();
	return total > shown ? (
		<p className="text-muted-foreground">
			{locale === "en"
				? `${shown} of ${total} tool names shown. Details are read in bounded pages.`
				: `已展示 ${total} 个工具中的 ${shown} 个名称，详情按页读取。`}
		</p>
	) : null;
}
export function ActivityDisclosure({
	title,
	count,
	expanded,
	onToggle,
	messageId,
	status,
	active = false,
	bodyVariant = "default",
	children,
	toolName,
	summaryKey = "summary",
	summaryTransition = "immediate",
}: {
	title: string;
	count: number;
	expanded: boolean;
	onToggle: () => void;
	messageId?: string;
	status?: string;
	active?: boolean;
	bodyVariant?: "default" | "grouped";
	children: ReactNode;
	toolName?: string;
	summaryKey?: string;
	summaryTransition?: "immediate" | "deferred";
}) {
	const summary = useGroupSummary({ title, toolName, status, active }, summaryKey, summaryTransition);
	const reducedMotion = useReducedMotionPreference();
	const bodyId = useId();
	const [phase, setPhase] = useState<DisclosurePhase>(expanded ? "expanded" : "collapsed");
	useLayoutEffect(() => {
		setPhase((current) => {
			if (reducedMotion) return expanded ? "expanded" : "collapsed";
			if (expanded) return current === "collapsed" ? "opening" : current === "closing" ? "expanded" : current;
			// An opening cancelled before its frame has never acquired visible height.
			return current === "expanded" ? "closing" : "collapsed";
		});
	}, [expanded, reducedMotion]);
	useLayoutEffect(() => {
		if (phase !== "opening") return;
		const frame = requestAnimationFrame(() => setPhase((current) => (current === "opening" ? "expanded" : current)));
		return () => cancelAnimationFrame(frame);
	}, [phase]);
	const ToolIcon =
		summary.toolName === "hipi_files_save"
			? Pencil
			: summary.toolName === "hipi_files_list"
				? Folder
				: summary.toolName === "hipi_files_read"
					? File
					: Puzzle;
	return (
		<div
			className="inline-activity"
			data-activity-message-id={messageId}
			data-disclosure-phase={phase}
			data-preserve-turn-viewport=""
		>
			<button
				type="button"
				className="inline-activity-toggle activity-disclosure-toggle"
				aria-expanded={expanded}
				aria-controls={bodyId}
				onClick={onToggle}
			>
				<span className="activity-disclosure-heading">
					<ToolIcon aria-hidden="true" />
					<span className="activity-disclosure-summary">
						<CadencedText active={summary.active}>{summary.title}</CadencedText>
					</span>
				</span>
				{count > 1 && ToolIcon === Puzzle && <span className="inline-activity-count">{count}</span>}
				{summary.status && <span className="inline-activity-phase">{summary.status}</span>}
				<ChevronRight className="activity-disclosure-chevron" aria-hidden="true" />
			</button>
			{phase !== "collapsed" && (
				<motion.div
					id={bodyId}
					data-expanded={expanded}
					initial={false}
					transition={reducedMotion ? { duration: 0 } : disclosureTransition}
					variants={disclosureVariants}
					animate={phase === "expanded" ? "expanded" : "collapsed"}
					aria-hidden={!expanded || phase === "opening"}
					inert={!expanded || phase === "opening"}
					className="activity-disclosure-body"
					style={{ pointerEvents: phase === "expanded" ? "auto" : "none" }}
					onAnimationComplete={(target) => {
						if (target === "collapsed") setPhase((current) => (current === "closing" ? "collapsed" : current));
					}}
				>
					<div className="inline-activity-details" data-variant={bodyVariant}>
						{children}
					</div>
				</motion.div>
			)}
		</div>
	);
}
