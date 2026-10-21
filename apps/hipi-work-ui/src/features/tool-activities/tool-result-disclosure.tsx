import { animate, motion, useMotionValue } from "framer-motion";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotionPreference } from "../../app/theme/use-reduced-motion.ts";
import { disclosureTransition } from "../../components/ui/disclosure-motion.ts";

/** Keeps only the numeric shell during closing; result views release immediately. */
export function ToolResultDisclosure({
	expanded,
	children,
	id,
}: {
	expanded: boolean;
	children: ReactNode;
	id: string;
}) {
	const reduced = useReducedMotionPreference();
	const content = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number>();
	const animatedHeight = useMotionValue(0);
	const opacity = useMotionValue(0);

	useLayoutEffect(() => {
		const node = content.current;
		if (!expanded || !node) return;
		let active = true;
		const measure = (nextHeight: number) => {
			// A hidden ancestor has no layout box. Preserve the last natural height,
			// but accept zero for a genuinely empty, visible body.
			if (active && node.getClientRects().length && Number.isFinite(nextHeight) && nextHeight >= 0) {
				setHeight(nextHeight);
			}
		};
		measure(node.scrollHeight);
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target === node) measure(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
			}
		});
		observer.observe(node, { box: "border-box" });
		return () => {
			active = false;
			observer.disconnect();
		};
	}, [expanded]);

	useLayoutEffect(() => {
		if (expanded && height === undefined) return;
		const target = expanded ? (height ?? 0) : 0;
		if (reduced) {
			// A preference change must settle an existing animation even when its
			// destination did not change. The previous effect stops both controls.
			animatedHeight.set(target);
			opacity.set(expanded ? 1 : 0);
			return;
		}
		const resize = animate(animatedHeight, target, disclosureTransition);
		const fade = animate(opacity, expanded ? 1 : 0, disclosureTransition);
		return () => {
			resize.stop();
			fade.stop();
		};
	}, [animatedHeight, expanded, height, opacity, reduced]);

	return (
		<motion.div
			id={id}
			className="inline-tool-result-shell"
			data-expanded={expanded}
			inert={!expanded}
			aria-hidden={!expanded}
			style={{
				height: animatedHeight,
				opacity,
				overflow: expanded ? "visible" : "hidden",
				pointerEvents: expanded ? "auto" : "none",
			}}
		>
			{expanded && (
				<div ref={content} className="inline-tool-result-measure">
					<div className="inline-tool-result-body">{children}</div>
				</div>
			)}
		</motion.div>
	);
}
