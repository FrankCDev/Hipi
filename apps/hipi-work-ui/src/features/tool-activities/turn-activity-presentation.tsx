import { motion } from "framer-motion";
import { ChevronRight, Wrench } from "lucide-react";
import { type ReactNode, useId } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { useReducedMotionPreference } from "../../app/theme/use-reduced-motion.ts";
import { CadencedText } from "../workbench/conversation/presentation/cadenced-text.tsx";
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
}) {
	const reducedMotion = useReducedMotionPreference();
	const bodyId = useId();
	return (
		<div className="inline-activity" data-activity-message-id={messageId} data-preserve-turn-viewport="">
			<button
				type="button"
				className="inline-activity-toggle activity-disclosure-toggle"
				aria-expanded={expanded}
				aria-controls={bodyId}
				onClick={onToggle}
			>
				<span className="activity-disclosure-heading">
					<Wrench aria-hidden="true" />
					<span className="activity-disclosure-summary">
						<CadencedText active={active}>{title}</CadencedText>
					</span>
				</span>
				{count > 1 && <span className="inline-activity-count">{count}</span>}
				{status && <span className="inline-activity-phase">{status}</span>}
				<ChevronRight className="activity-disclosure-chevron" aria-hidden="true" />
			</button>
			<motion.div
				id={bodyId}
				data-expanded={expanded}
				initial={false}
				transition={reducedMotion ? { duration: 0 } : undefined}
				animate={{ height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 }}
				aria-hidden={!expanded}
				inert={!expanded}
				className="activity-disclosure-body"
				style={{ pointerEvents: expanded ? "auto" : "none" }}
			>
				<div className="inline-activity-details" data-variant={bodyVariant}>
					{children}
				</div>
			</motion.div>
		</div>
	);
}
