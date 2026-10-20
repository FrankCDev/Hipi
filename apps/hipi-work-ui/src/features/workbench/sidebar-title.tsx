import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { type SidebarTitleMotion, sidebarTitleMotion } from "./sidebar-title-motion.ts";
import "./sidebar-title.css";

type TitleStyle = CSSProperties & {
	"--sidebar-title-offset"?: string;
	"--sidebar-title-delay"?: string;
	"--sidebar-title-duration"?: string;
	"--sidebar-title-total-duration"?: string;
};

/** The row owns pointer hover; keyboard focus must not start text movement. */
export function SidebarTitle({
	text,
	className,
	id,
	hovered = false,
}: {
	text: string;
	className?: string;
	id?: string;
	hovered?: boolean;
}) {
	const viewport = useRef<HTMLSpanElement>(null);
	const content = useRef<HTMLSpanElement>(null);
	const [motion, setMotion] = useState<SidebarTitleMotion | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Text replaces the observed node; class and row hover can change its committed layout before paint.
	useLayoutEffect(() => {
		const frame = viewport.current;
		const label = content.current;
		const view = frame?.ownerDocument.defaultView;
		if (!frame || !label || !view) return;
		let pendingFrame: number | undefined;
		let disposed = false;
		const measure = () => {
			if (disposed) return;
			const frameRect = frame.getBoundingClientRect();
			const labelRect = label.getBoundingClientRect();
			const frameStyle = view.getComputedStyle(frame);
			const labelStyle = view.getComputedStyle(label);
			// Our borderless, unpadded viewport gives a fractional layout width.
			// Using offsetWidth alone would round short overflows and misread zoom.
			const layoutWidth = Number.parseFloat(frameStyle.width);
			const scaleX =
				frameRect.width > 0 && layoutWidth > 0
					? frameRect.width / layoutWidth
					: frameRect.width > 0 && frame.offsetWidth > 0
						? frameRect.width / frame.offsetWidth
						: 1;
			const next = sidebarTitleMotion({
				contentWidth: labelRect.width > 0 ? labelRect.width : label.scrollWidth,
				viewportWidth: frameRect.width > 0 ? frameRect.width : frame.clientWidth,
				scaleX,
				fontSize: Number.parseFloat(labelStyle.fontSize),
				direction: labelStyle.direction === "rtl" ? "rtl" : "ltr",
			});
			setMotion((previous) =>
				previous?.offsetPx === next?.offsetPx && previous?.durationMs === next?.durationMs ? previous : next,
			);
		};
		const scheduleMeasure = () => {
			if (disposed || pendingFrame !== undefined) return;
			pendingFrame = view.requestAnimationFrame(() => {
				pendingFrame = undefined;
				measure();
			});
		};
		measure();
		const resize = new ResizeObserver(scheduleMeasure);
		resize.observe(frame);
		resize.observe(label);
		const appearance = new MutationObserver(scheduleMeasure);
		for (let ancestor = frame.parentElement; ancestor; ancestor = ancestor.parentElement) {
			appearance.observe(ancestor, {
				attributes: true,
				attributeFilter: ["class", "style", "dir", "lang", "data-theme"],
			});
		}
		view.addEventListener("resize", scheduleMeasure);
		const fonts = frame.ownerDocument.fonts;
		fonts?.addEventListener("loadingdone", scheduleMeasure);
		return () => {
			disposed = true;
			resize.disconnect();
			appearance.disconnect();
			view.removeEventListener("resize", scheduleMeasure);
			fonts?.removeEventListener("loadingdone", scheduleMeasure);
			if (pendingFrame !== undefined) view.cancelAnimationFrame(pendingFrame);
		};
	}, [text, className, hovered]);

	const style: TitleStyle = motion
		? {
				"--sidebar-title-offset": `${motion.offsetPx}px`,
				"--sidebar-title-delay": `${motion.delayMs}ms`,
				"--sidebar-title-duration": `${motion.durationMs}ms`,
				"--sidebar-title-total-duration": `${motion.totalDurationMs}ms`,
			}
		: {};
	return (
		<span
			ref={viewport}
			id={id}
			className={className ? `${className} sidebar-title` : "sidebar-title"}
			data-overflowing={motion !== null}
			data-hovered={hovered}
			data-direction={motion?.direction}
			style={style}
			draggable={false}
		>
			<span className="sidebar-title-clip" key={text}>
				<span ref={content} className="sidebar-title-content">
					{text}
				</span>
			</span>
		</span>
	);
}
