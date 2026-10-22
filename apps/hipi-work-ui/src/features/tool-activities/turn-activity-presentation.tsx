import { animate, motion, useMotionValue } from "framer-motion";
import { ChevronRight, File, Folder, Pencil, Puzzle } from "lucide-react";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { useReducedMotionPreference } from "../../app/theme/use-reduced-motion.ts";
import { disclosureTransition } from "../../components/ui/disclosure-motion.ts";
import { CadencedText } from "../workbench/conversation/presentation/cadenced-text.tsx";
import { useGroupSummary } from "./group-summary.tsx";

type DisclosurePhase = "collapsed" | "opening" | "expanded" | "closing";
const disclosureVariants = {
	expanded: { opacity: 1 },
	collapsed: { opacity: 0 },
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
	plainSummary = false,
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
	plainSummary?: boolean;
}) {
	const summary = useGroupSummary(
		{ title, toolName, status, active, plain: plainSummary },
		summaryKey,
		summaryTransition,
	);
	const reducedMotion = useReducedMotionPreference();
	const bodyId = useId();
	const [phase, setPhase] = useState<DisclosurePhase>(expanded ? "expanded" : "collapsed");
	const shell = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const settled = useRef(expanded);
	const animatedHeight = useMotionValue<number | "auto">(expanded ? "auto" : 0);
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
	useLayoutEffect(() => {
		if (reducedMotion || phase === "collapsed") {
			settled.current = phase === "expanded";
			animatedHeight.set(phase === "expanded" ? "auto" : 0);
			return;
		}
		if (phase === "expanded" && settled.current) return;
		settled.current = false;
		let active = true;
		let generation = 0;
		let target: number | undefined;
		let resize: ReturnType<typeof animate> | undefined;
		let observer: ResizeObserver | undefined;
		const retarget = (height: number) => {
			if (!active || target === height) return;
			target = height;
			const current = ++generation;
			resize?.stop();
			if (animatedHeight.get() === "auto") animatedHeight.set(shell.current?.getBoundingClientRect().height ?? height);
			resize = animate(animatedHeight, height, {
				...disclosureTransition,
				onComplete: () => {
					if (!active || current !== generation) return;
					if (phase === "expanded") {
						// Only our own opening owns height. Afterwards nested result motion
						// flows through auto without a second parent interpolation.
						settled.current = true;
						observer?.disconnect();
						animatedHeight.set("auto");
					}
				},
			});
		};
		if (phase === "closing") retarget(0);
		else {
			const node = content.current;
			const measure = (height: number) => {
				if (!active || settled.current || !node?.getClientRects().length || !Number.isFinite(height) || height < 0)
					return;
				// Unlike the reference's already available children, Hipi reads details
				// after opening. Refresh the in-flight endpoint, not a stale auto snapshot.
				if (phase === "expanded") retarget(height);
			};
			if (node) {
				// Border-box respects the grouped scroll cap; scrollHeight does not.
				measure(node.getBoundingClientRect().height);
				if (typeof ResizeObserver !== "undefined") {
					observer = new ResizeObserver((entries) => {
						for (const entry of entries) {
							if (entry.target === node)
								measure(entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height);
						}
					});
					observer.observe(node, { box: "border-box" });
				}
			}
		}
		return () => {
			active = false;
			generation++;
			observer?.disconnect();
			resize?.stop();
		};
	}, [animatedHeight, phase, reducedMotion]);
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
					{!summary.plain && <ToolIcon aria-hidden="true" />}
					<span className="activity-disclosure-summary">
						<CadencedText active={summary.active}>{summary.title}</CadencedText>
					</span>
				</span>
				{!summary.plain && count > 1 && ToolIcon === Puzzle && <span className="inline-activity-count">{count}</span>}
				{summary.status && <span className="inline-activity-phase">{summary.status}</span>}
				<ChevronRight className="activity-disclosure-chevron" aria-hidden="true" />
			</button>
			{phase !== "collapsed" && (
				<motion.div
					ref={shell}
					id={bodyId}
					data-expanded={expanded}
					initial={false}
					transition={reducedMotion ? { duration: 0 } : disclosureTransition}
					variants={disclosureVariants}
					animate={phase === "expanded" ? "expanded" : "collapsed"}
					aria-hidden={!expanded || phase === "opening"}
					inert={!expanded || phase === "opening"}
					className="activity-disclosure-body"
					style={{ height: animatedHeight, pointerEvents: phase === "expanded" ? "auto" : "none" }}
					onAnimationComplete={(target) => {
						// A zero-height shell may finish immediately; retain its reader
						// until the original close/fade lifecycle has completed too.
						if (target === "collapsed") setPhase((current) => (current === "closing" ? "collapsed" : current));
					}}
				>
					<div ref={content} className="inline-activity-details" data-variant={bodyVariant}>
						{children}
					</div>
				</motion.div>
			)}
		</div>
	);
}
